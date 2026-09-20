import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { isAppError } from '@cadfixer/shared';
import type { DocumentReadResult } from '../packages/file-formats/src/document-reader';
import { refusalOf } from '../packages/file-formats/src/import-errors';
import { decodeUtf8, testReadContext } from '../packages/file-formats/src/test-context';
import {
  read3mf,
  read3mfForQualification,
  ThreeMfIngestion,
  type ThreeMfRouteDecision,
} from '../packages/file-formats/src/threemf/threemf-reader';
import { createStreamScanStats } from '../packages/file-formats/src/threemf/xml-stream';
import {
  createInflationBudget,
  readZipDirectory,
  readZipEntry,
} from '../packages/file-formats/src/threemf/zip';
import { inflateRawForTests } from '../packages/file-formats/src/test-context';

/**
 * STAGE 6E-A2 — BUFFERED VERSUS STREAMED INGESTION OVER A DIRECTORY OF REAL
 * 3MF FILES.
 *
 * NO FIXTURE IS COMMITTED WITH THIS: the tree comes from `CADFIXER_CORPUS`, as
 * for `interop-corpus.suite.ts`, and its provenance is recorded in the Stage 6E
 * design document.
 *
 * Every `.3mf` is read twice — `read3mf` buffered, and streamed — and the two
 * outcomes are compared:
 *   - IMPORTED: a SHA-256 over the unit, every part's name, material
 *     reference, mesh sharing and transform, every distinct mesh's position and
 *     index BYTES, and the encoding, warnings and compatibility report;
 *   - REFUSED: category, reason, message and every structured detail except the
 *     two whose values move with decompressor chunking (`produced`, `atLeast`).
 *
 * It also records two facts the design document relies on: the longest tag the
 * streamed scanner ever held (the evidence behind `maxTagLength`), and every
 * namespace declaration made on an element OTHER than `<model>` (the evidence
 * behind resolving prefixes from `<model>` alone).
 *
 * Run:
 *   CADFIXER_CORPUS=<dir> CADFIXER_CORPUS_REPORT=<file.jsonl> \
 *     npm run qualify:streaming-corpus
 *
 * IT ASSERTS ONE THING: no file differs between the two modes, and none throws
 * an untyped error in either.
 */

function* files(root: string): Generator<string> {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (extname(name).toLowerCase() === '.3mf') yield full;
  }
}

function fingerprint(result: DocumentReadResult): string {
  const hash = createHash('sha256');
  const meshes = new Map<unknown, number>();
  const parts = result.document.parts.map((part) => {
    if (!meshes.has(part.mesh)) meshes.set(part.mesh, meshes.size);
    return [
      part.name ?? null,
      part.materialRef ?? null,
      meshes.get(part.mesh),
      [...part.transform],
    ];
  });
  hash.update(
    JSON.stringify([
      result.document.unit ?? null,
      parts,
      result.encoding,
      result.warnings,
      result.compatibility,
    ]),
  );
  for (const mesh of meshes.keys()) {
    const { positions, indices } = mesh as { positions: Float32Array; indices: Uint32Array };
    hash.update(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
    hash.update(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
  }
  return `imported ${String(result.document.parts.length)} parts ${hash.digest('hex').slice(0, 24)}`;
}

function refusal(error: unknown): string {
  if (!isAppError(error)) return `UNTYPED ${String(error)}`;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error.details)) {
    details[key] = key === 'produced' || key === 'atLeast' ? typeof value : value;
  }
  return `refused ${error.code} ${String(refusalOf(error))} ${error.message} ${JSON.stringify(details)}`;
}

async function outcome(run: () => Promise<DocumentReadResult>): Promise<string> {
  try {
    return fingerprint(await run());
  } catch (error) {
    return refusal(error);
  }
}

/** Namespace declarations below `<model>`, in every `.model` entry. */
async function nestedDeclarations(bytes: Uint8Array): Promise<number> {
  let count = 0;
  try {
    const entries = readZipDirectory(bytes);
    for (const entry of entries.filter((e) => e.name.toLowerCase().endsWith('.model'))) {
      const xml = decodeUtf8(
        await readZipEntry(bytes, entry, {
          inflateRaw: inflateRawForTests,
          budget: createInflationBudget(),
        }),
      );
      for (const match of xml.matchAll(/<([A-Za-z_][\w:.-]*)[^>]*?\sxmlns(?::[\w.-]+)?\s*=/g)) {
        if (match[1] !== 'model') count += 1;
      }
    }
  } catch (error) {
    // An archive the reader refuses has nothing further to count; its refusal is
    // what the comparison above records.
    if (!isAppError(error)) throw error;
  }
  return count;
}

it('reads every 3MF in CADFIXER_CORPUS identically: buffered, streamed and routed', async () => {
  const root = process.env.CADFIXER_CORPUS ?? '';
  if (root === '') {
    process.stdout.write('\nCADFIXER_CORPUS is not set: nothing to read.\n');
    return;
  }
  const report = process.env.CADFIXER_CORPUS_REPORT ?? '';
  if (report !== '') writeFileSync(report, '');

  let total = 0;
  let imported = 0;
  let refused = 0;
  let longestTag = 0;
  let nested = 0;
  const differing: string[] = [];
  const untyped: string[] = [];
  const reasons = new Map<string, number>();
  /*
   * A3 — HOW THE ROUTED READER ACTUALLY ROUTED THIS CORPUS. Recorded per entry
   * so the design document can report what share of REAL producer output takes
   * each path, which is the product-impact half of the threshold decision. It
   * is a count, in this process, written to a local report; nothing is sent
   * anywhere and no model path leaves the run.
   */
  const routed = { buffered: 0, streaming: 0 };
  const entrySizes: number[] = [];

  for (const file of files(root)) {
    total += 1;
    const bytes = new Uint8Array(readFileSync(file));
    const stats = createStreamScanStats();
    const buffered = await outcome(() => read3mf(bytes, testReadContext()));
    const streamed = await outcome(() =>
      read3mfForQualification(
        bytes,
        testReadContext(),
        { ingestion: ThreeMfIngestion.Streaming },
        { stats },
      ),
    );
    /*
     * THE THIRD READ IS THE SHIPPED ONE. `auto` is what the registry holds, so
     * a differential that compared only the two forced modes would no longer be
     * comparing the product against anything.
     */
    const routes: ThreeMfRouteDecision[] = [];
    const auto = await outcome(() =>
      read3mfForQualification(
        bytes,
        testReadContext(),
        { ingestion: ThreeMfIngestion.Auto },
        {
          onRoute: (decision) => {
            routes.push(decision);
          },
        },
      ),
    );
    for (const decision of routes) {
      entrySizes.push(decision.declaredUncompressedBytes);
      if (decision.route === ThreeMfIngestion.Streaming) routed.streaming += 1;
      else routed.buffered += 1;
    }
    longestTag = Math.max(longestTag, stats.maxTagChars);
    const declarations = await nestedDeclarations(bytes);
    nested += declarations;
    const name = relative(root, file);
    if (buffered.startsWith('imported')) imported += 1;
    else {
      refused += 1;
      const reason = buffered.split(' ')[2] ?? '?';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    if (buffered !== streamed)
      differing.push(`${name}\n    buffered: ${buffered}\n    streamed: ${streamed}`);
    if (buffered !== auto) differing.push(`${name}\n    buffered: ${buffered}\n    auto: ${auto}`);
    if (
      buffered.startsWith('UNTYPED') ||
      streamed.startsWith('UNTYPED') ||
      auto.startsWith('UNTYPED')
    )
      untyped.push(name);
    if (report !== '') {
      appendFileSync(
        report,
        `${JSON.stringify({
          file: name,
          bytes: bytes.byteLength,
          same: buffered === streamed && buffered === auto,
          modelEntryBytes: routes.map((decision) => decision.declaredUncompressedBytes),
          routes: routes.map((decision) => decision.route),
          outcome: buffered.slice(0, 160),
          maxTagChars: stats.maxTagChars,
          nestedNamespaceDeclarations: declarations,
        })}\n`,
      );
    }
  }

  process.stdout.write(
    `\n6E-A2 streaming corpus: ${String(total)} files — ${String(imported)} imported, ${String(refused)} refused; ` +
      `${String(total - differing.length)} identical, ${String(differing.length)} different; ` +
      `longest streamed tag ${String(longestTag)} characters; ` +
      `${String(nested)} namespace declarations below <model>\n` +
      `model entries routed: ${String(routed.buffered)} buffered, ${String(routed.streaming)} streamed` +
      `${entrySizes.length === 0 ? '' : ` (largest ${String(Math.max(...entrySizes))} bytes)`}\n` +
      `refusals by reason: ${JSON.stringify(Object.fromEntries(reasons))}\n` +
      differing.map((line) => `  DIFFERENT ${line}\n`).join(''),
  );
  expect(untyped).toEqual([]);
  expect(differing).toEqual([]);
});
