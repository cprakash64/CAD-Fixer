import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { isAppError } from '@cadfixer/shared';
import {
  applyPartTransform,
  assertGeometryDocument,
  assertMeshStructure,
  buildDrawableTriangles,
  distinctMeshes,
  documentTriangleCount,
  IDENTITY_PART_TRANSFORM,
  measureImportGeometry,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import { checkImportGeometry } from '@cadfixer/geometry-runtime';
import {
  identifyFormat,
  registerBuiltInFormats,
  requireReader,
  MeshFormatId,
} from '@cadfixer/file-formats';
import { refusalOf } from '../packages/file-formats/src/import-errors';
import { testReadContext } from '../packages/file-formats/src/test-context';
import { exportDocument } from '../packages/file-formats/src/export/export-document';
import { exportSnapshotOf } from '../packages/file-formats/src/export/export-contract';
import {
  testExportReadContext,
  testWriteContextWithDeflate,
} from '../packages/file-formats/src/export/test-context';
import {
  createInflationBudget,
  readZipDirectory,
  readZipEntry,
} from '../packages/file-formats/src/threemf/zip';
import { inflateRawForTests, decodeUtf8 } from '../packages/file-formats/src/test-context';

/**
 * WHAT THE PRODUCTION IMPORT PIPELINE MAKES OF A DIRECTORY TREE OF REAL FILES —
 * Stage 6D-A4, for STL, OBJ and 3MF alike.
 *
 * NO FIXTURE IS COMMITTED WITH THIS, for the reason `threemf-corpus.suite.ts`
 * gives: the repository stays dataless and redistributes no producer's output.
 * The tree comes from `CADFIXER_CORPUS`; its provenance is recorded by the
 * qualifier (repository, commit, path) in the stage's documentation.
 *
 * THE SAME STEPS THE WORKER TAKES, in the same order, and no others:
 * `identifyFormat` from the BYTES, `requireReader`, `assertMeshStructure` per
 * DISTINCT mesh, `assertGeometryDocument`, the Stage 6D-R3 geometry gate, and
 * the non-indexed render expansion the snapshot performs. A file that passes
 * here passes every gate the application applies before a document becomes
 * resident; nothing is skipped to make a corpus look better.
 *
 * WITH `CADFIXER_EXPORT=1`, every imported document is also exported to STL,
 * OBJ and 3MF through `exportDocument` — which reads each artifact back with
 * the PRODUCTION reader and refuses to return it unless the two agree — and the
 * artifact is read back once more here, independently, so triangle totals and
 * world bounds can be compared with the source document.
 *
 * Run:
 *   CADFIXER_CORPUS=<dir> CADFIXER_CORPUS_REPORT=<file.jsonl> \
 *     npm run qualify:interop-corpus
 *
 * IT REPORTS; IT ASSERTS NOTHING ABOUT ANY PARTICULAR FILE. A corpus outside the
 * repository cannot be a test. What it asserts is that the run happened and
 * that no file produced an error that is not a typed `AppError` — an untyped
 * throw from a reader is a crash, whatever the file was.
 */

registerBuiltInFormats();

const FORMAT_EXTENSIONS = new Set(['.stl', '.obj', '.3mf']);

interface PackageFacts {
  readonly zip64: boolean;
  readonly entries: number;
  readonly modelParts: number;
  readonly hasRootRels: boolean;
  readonly hasContentTypes: boolean;
  readonly thumbnails: number;
  readonly application: string | undefined;
  readonly requiredExtensions: string | undefined;
  readonly usesProductionPath: boolean;
  readonly namespaces: readonly string[];
}

interface ExportFacts {
  readonly target: string;
  readonly ok: boolean;
  readonly bytes?: number;
  readonly triangles?: number;
  readonly parts?: number;
  readonly boundsMatch?: boolean;
  readonly error?: string;
}

interface ResultRow {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly format?: string;
  readonly outcome: 'IMPORTED' | 'REFUSED' | 'CRASH';
  readonly code?: string;
  readonly refusal?: string;
  readonly message?: string;
  readonly parts?: number;
  readonly distinctMeshes?: number;
  readonly triangles?: number;
  readonly unit?: string;
  readonly bounds?: readonly number[];
  readonly nonIdentityTransforms?: number;
  readonly geometryBytes?: number;
  readonly warnings?: readonly string[];
  readonly unsupported?: readonly string[];
  readonly ms: number;
  readonly pkg?: PackageFacts;
  readonly exports?: readonly ExportFacts[];
}

function walk(directory: string, out: string[]): void {
  for (const name of readdirSync(directory).sort()) {
    if (name === '.git') continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else if (FORMAT_EXTENSIONS.has(extname(name).toLowerCase())) out.push(path);
  }
}

/**
 * The tight world bounds of every triangle corner, with each placement applied
 * PER VERTEX in Float64. Not the transformed box of a local box: for a rotated
 * part that is looser than the geometry, and an OBJ or STL export — which bakes
 * placements into coordinates — would then look like it had moved the model.
 */
function worldBounds(document: GeometryDocument): number[] | undefined {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const part of document.parts) {
    const { positions, indices } = part.mesh;
    for (const index of indices) {
      const corner = applyPartTransform(
        part.transform,
        positions[index * 3] ?? 0,
        positions[index * 3 + 1] ?? 0,
        positions[index * 3 + 2] ?? 0,
      );
      for (let axis = 0; axis < 3; axis += 1) {
        const value = corner[axis] ?? 0;
        if (value < (min[axis] ?? Infinity)) min[axis] = value;
        if (value > (max[axis] ?? -Infinity)) max[axis] = value;
      }
      any = true;
    }
  }
  return any ? [...min, ...max] : undefined;
}

/**
 * Bounds agree when each coordinate is equal to within a few Float32 ulps of
 * its own magnitude. Exports narrow through Float32 exactly once, as the reader
 * does, so an exact comparison would be comparing two roundings; the engine's
 * own parse-back check is the exact one, and this is a second, coarser opinion.
 */
function boundsAgree(left: readonly number[], right: readonly number[]): boolean {
  return left.every((value, index) => {
    const other = right[index] ?? NaN;
    return Math.abs(value - other) <= Math.max(Math.abs(value), 1) * 2 ** -20;
  });
}

function isIdentity(transform: readonly number[]): boolean {
  return transform.every((value, index) => value === IDENTITY_PART_TRANSFORM[index]);
}

async function packageFacts(bytes: Uint8Array): Promise<PackageFacts | undefined> {
  try {
    const entries = readZipDirectory(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let zip64 = false;
    for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 66_000); at -= 1) {
      if (view.getUint32(at, true) === 0x06054b50) {
        zip64 = at >= 20 && view.getUint32(at - 20, true) === 0x07064b50;
        break;
      }
    }
    const models = entries.filter((entry) => entry.name.toLowerCase().endsWith('.model'));
    const budget = createInflationBudget();
    const namespaces = new Set<string>();
    let application: string | undefined;
    let requiredExtensions: string | undefined;
    let usesProductionPath = false;
    for (const model of models) {
      const xml = decodeUtf8(
        await readZipEntry(bytes, model, { inflateRaw: inflateRawForTests, budget }),
      );
      const head = xml.slice(0, 8_192);
      for (const match of head.matchAll(/xmlns(?::[\w.-]+)?="([^"]+)"/g)) {
        if (match[1] !== undefined) namespaces.add(match[1]);
      }
      application ??= /name="Application"[^>]*>([^<]{0,120})</.exec(head)?.[1];
      requiredExtensions ??= /requiredextensions="([^"]*)"/.exec(head)?.[1];
      if (xml.includes(':path="')) usesProductionPath = true;
    }
    return {
      zip64,
      entries: entries.length,
      modelParts: models.length,
      hasRootRels: entries.some((entry) => entry.name.toLowerCase() === '_rels/.rels'),
      hasContentTypes: entries.some((entry) => entry.name === '[Content_Types].xml'),
      thumbnails: entries.filter((entry) => /\.(png|jpe?g)$/i.test(entry.name)).length,
      application,
      requiredExtensions,
      usesProductionPath,
      namespaces: [...namespaces].sort(),
    };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return undefined;
  }
}

async function exportFacts(
  document: GeometryDocument,
  sourceTriangles: number,
  sourceBounds: readonly number[] | undefined,
): Promise<ExportFacts[]> {
  const out: ExportFacts[] = [];
  for (const target of [MeshFormatId.Stl, MeshFormatId.Obj, MeshFormatId.ThreeMf]) {
    try {
      const written = await exportDocument({
        snapshot: exportSnapshotOf(document, 'corpus', 1, {
          ...(document.unit === undefined && target === MeshFormatId.ThreeMf
            ? { unitAssertion: 'millimeter' }
            : {}),
        }),
        target,
        write: testWriteContextWithDeflate(),
        read: testExportReadContext(),
      });
      // Read back once more, here, independently of the engine's own check.
      const back = await requireReader(target).read(written.bytes, testReadContext());
      const backBounds = worldBounds(back.document);
      out.push({
        target,
        ok: true,
        bytes: written.bytes.byteLength,
        triangles: documentTriangleCount(back.document),
        parts: back.document.parts.length,
        boundsMatch:
          sourceBounds === undefined || backBounds === undefined
            ? sourceBounds === backBounds
            : boundsAgree(sourceBounds, backBounds) &&
              documentTriangleCount(back.document) === sourceTriangles,
      });
    } catch (error) {
      if (!isAppError(error)) throw error;
      out.push({ target, ok: false, error: `${error.code}/${String(refusalOf(error))}` });
    }
  }
  return out;
}

async function qualify(root: string, path: string, withExport: boolean): Promise<ResultRow> {
  const bytes = new Uint8Array(readFileSync(path));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = relative(root, path);
  const startedAt = Date.now();
  const pkg = extname(path).toLowerCase() === '.3mf' ? await packageFacts(bytes) : undefined;
  try {
    const identified = identifyFormat(bytes, path.split('/').pop() ?? path);
    const parsed = await requireReader(identified.formatId).read(bytes, testReadContext());
    for (const mesh of distinctMeshes(parsed.document)) assertMeshStructure(mesh, 'corpus');
    assertGeometryDocument(parsed.document, 'corpus', { validateMeshes: false });
    const cost = measureImportGeometry(parsed.document);
    const overBudget = checkImportGeometry(cost);
    if (overBudget) throw overBudget;
    for (const mesh of distinctMeshes(parsed.document)) buildDrawableTriangles(mesh);

    const triangles = documentTriangleCount(parsed.document);
    const bounds = worldBounds(parsed.document);
    const ms = Date.now() - startedAt;
    return {
      file,
      bytes: bytes.byteLength,
      sha256,
      format: identified.formatId,
      outcome: 'IMPORTED',
      parts: parsed.document.parts.length,
      distinctMeshes: distinctMeshes(parsed.document).length,
      triangles,
      ...(parsed.document.unit === undefined ? {} : { unit: parsed.document.unit }),
      ...(bounds === undefined ? {} : { bounds }),
      nonIdentityTransforms: parsed.document.parts.filter((part) => !isIdentity(part.transform))
        .length,
      geometryBytes: cost.totalBytes,
      warnings: parsed.warnings.map((warning) => warning.code),
      unsupported: [...parsed.compatibility.unsupported],
      ms,
      ...(pkg === undefined ? {} : { pkg }),
      ...(withExport ? { exports: await exportFacts(parsed.document, triangles, bounds) } : {}),
    };
  } catch (error) {
    const ms = Date.now() - startedAt;
    if (!isAppError(error)) {
      return {
        file,
        bytes: bytes.byteLength,
        sha256,
        outcome: 'CRASH',
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ms,
        ...(pkg === undefined ? {} : { pkg }),
      };
    }
    return {
      file,
      bytes: bytes.byteLength,
      sha256,
      outcome: 'REFUSED',
      code: error.code,
      refusal: String(refusalOf(error)),
      message: error.message.slice(0, 240),
      ms,
      ...(pkg === undefined ? {} : { pkg }),
    };
  }
}

it('reports what the production import pipeline makes of every file in CADFIXER_CORPUS', async () => {
  const root = process.env.CADFIXER_CORPUS ?? '';
  if (root === '') {
    process.stdout.write('\nCADFIXER_CORPUS is not set: nothing to read.\n');
    return;
  }
  const report = process.env.CADFIXER_CORPUS_REPORT ?? '';
  const withExport = process.env.CADFIXER_EXPORT === '1';

  const files: string[] = [];
  walk(root, files);
  if (report !== '') writeFileSync(report, '');

  const tally = new Map<string, number>();
  for (const path of files) {
    const row = await qualify(root, path, withExport);
    const key = `${row.outcome} ${row.code ?? ''}`.trim();
    tally.set(key, (tally.get(key) ?? 0) + 1);
    if (report !== '') appendFileSync(report, `${JSON.stringify(row)}\n`);
  }

  process.stdout.write(
    `\n${String(files.length)} file(s) under ${root}\n` +
      [...tally.entries()]
        .map(([key, count]) => `  ${key.padEnd(40)} ${String(count)}`)
        .join('\n') +
      '\n',
  );
  expect(files.length).toBeGreaterThan(0);
  expect(tally.get('CRASH') ?? 0).toBe(0);
}, 3_600_000);
