import { performance } from 'node:perf_hooks';
import { it } from 'vitest';
import { uncancellable } from '@cadfixer/shared';
import {
  computeBounds,
  computeVertexNormals,
  distinctMeshes,
  documentTriangleCount,
  meshByteLength,
  partId,
  singlePartDocument,
  transformBounds,
  triangleCount,
  unionBounds,
  validateGeometryDocument,
  validateMeshStructure,
  type CanonicalMesh,
  type GeometryDocument,
  type GeometryPart,
  type MeshBounds,
} from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  MeshFormatId,
  readStl,
  registerBuiltInFormats,
  requireWriter,
} from '@cadfixer/file-formats';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { documentByteLength, ResidentDocumentStore } from '@cadfixer/geometry-runtime';

/**
 * WHAT THE DOCUMENT WRAPPER COSTS. NOT part of CI.
 *
 * Two questions, and only two:
 *
 *   1. Did wrapping ONE mesh in a document make the existing single-part
 *      workflow measurably worse? Stage 4A-2A is a refactor, and a refactor
 *      that costs an ordinary STL user time has failed regardless of what it
 *      enables. Every stage below is run against a bare mesh and against the
 *      same mesh inside a one-part document, in the same process.
 *
 *   2. Does part count cost geometry, or only metadata? A thousand placements
 *      of one component must cost one mesh — if it costs a thousand, the
 *      structural-sharing design does not work and no amount of protocol
 *      correctness saves it.
 *
 * WHAT THIS IS NOT. A Node measurement, not a browser one, and it does not claim
 * process memory: typed arrays live outside the JS heap and `process.memoryUsage`
 * would not tell the truth about a tab. Memory here is MODELLED from actual
 * typed-array byte lengths, which is a claim that can be checked.
 *
 * Run with `npm run bench:document`. Sizes: `CADFIXER_DOCUMENT_MB=1,10,50`.
 */

const BINARY_PREFIX_BYTES = 84;
const BINARY_FACET_BYTES = 50;

function buildStl(targetBytes: number): { bytes: Uint8Array; triangles: number } {
  const facets = Math.max(2, Math.floor((targetBytes - BINARY_PREFIX_BYTES) / BINARY_FACET_BYTES));
  const side = Math.max(2, Math.floor(Math.sqrt(facets / 2)));
  const triangles = side * side * 2;

  const bytes = new Uint8Array(BINARY_PREFIX_BYTES + triangles * BINARY_FACET_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles, true);

  const height = (x: number, y: number): number => ((x * 7 + y * 13) % 17) * 0.01;
  let facet = 0;
  const writeTriangle = (points: readonly (readonly [number, number, number])[]): void => {
    const offset = BINARY_PREFIX_BYTES + facet * BINARY_FACET_BYTES;
    points.forEach((point, corner) => {
      const base = offset + 12 + corner * 12;
      view.setFloat32(base, point[0], true);
      view.setFloat32(base + 4, point[1], true);
      view.setFloat32(base + 8, point[2], true);
    });
    facet += 1;
  };

  for (let row = 0; row < side; row += 1) {
    for (let col = 0; col < side; col += 1) {
      const p00: readonly [number, number, number] = [col, row, height(col, row)];
      const p10: readonly [number, number, number] = [col + 1, row, height(col + 1, row)];
      const p01: readonly [number, number, number] = [col, row + 1, height(col, row + 1)];
      const p11: readonly [number, number, number] = [col + 1, row + 1, height(col + 1, row + 1)];
      writeTriangle([p00, p10, p01]);
      writeTriangle([p10, p11, p01]);
    }
  }

  return { bytes, triangles };
}

function ms(value: number): string {
  return `${value.toFixed(1).padStart(8)} ms`;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function timed<T>(run: () => T): { value: T; elapsed: number } {
  const started = performance.now();
  const value = run();
  return { value, elapsed: performance.now() - started };
}

function parseSizes(): number[] {
  const raw = process.env.CADFIXER_DOCUMENT_MB;
  if (raw === undefined || raw.trim().length === 0) return [1, 10, 50];
  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The render snapshot the worker builds, per DISTINCT mesh, exactly as it does. */
function buildDocumentRender(document: GeometryDocument): {
  buffers: number;
  bytes: number;
} {
  const byMesh = new Map<CanonicalMesh, { positions: Float32Array; normals: Float32Array }>();
  for (const part of document.parts) {
    if (byMesh.has(part.mesh)) continue;
    byMesh.set(part.mesh, {
      positions: part.mesh.positions.slice(),
      normals: computeVertexNormals(part.mesh),
    });
  }
  let bytes = 0;
  for (const entry of byMesh.values()) {
    bytes += entry.positions.byteLength + entry.normals.byteLength;
  }
  return { buffers: byMesh.size * 2, bytes };
}

/**
 * The worker's document bounds, computed the way the worker computes them.
 *
 * ONCE PER DISTINCT MESH. Doing it per part made this 356 ms at 1,000
 * placements — a thousand walks of one shared buffer producing one answer.
 */
function documentBounds(document: GeometryDocument): MeshBounds | undefined {
  const local = new Map<CanonicalMesh, MeshBounds | undefined>();
  for (const mesh of distinctMeshes(document)) local.set(mesh, computeBounds(mesh));

  let bounds: MeshBounds | undefined;
  for (const part of document.parts) {
    const box = local.get(part.mesh);
    if (box === undefined) continue;
    bounds = unionBounds(bounds, transformBounds(box, part.transform));
  }
  return bounds;
}

it('measures the single-part cost of the document wrapper', async () => {
  registerBuiltInFormats();

  process.stdout.write(
    `\nnode ${process.version} on ${process.platform}/${process.arch}\n` +
      `run at ${new Date().toISOString()}\n\n` +
      `SINGLE-PART REGRESSION — bare mesh vs the same mesh in a one-part document\n\n`,
  );

  for (const sizeMb of parseSizes()) {
    const built = buildStl(Math.floor(sizeMb * 1024 * 1024));
    const parsed = await readStl(built.bytes, {
      cancellation: uncancellable,
      budget: DEFAULT_IMPORT_BUDGET,
      yieldToEventLoop,
      decodeText: (): string => {
        throw new Error('the STL reader does not decode text');
      },
      progress: { report: (): void => undefined },
    });
    const mesh = parsed.mesh;

    // ---- bare-mesh path, as Stage 3 ran it ----
    const bareValidate = timed(() => validateMeshStructure(mesh));
    const bareBounds = timed(() => computeBounds(mesh));
    const bareRender = timed(() => ({
      positions: mesh.positions.slice(),
      normals: computeVertexNormals(mesh),
    }));
    const bareBytes = meshByteLength(mesh);

    // ---- one-part document path ----
    const wrap = timed(() => singlePartDocument(mesh));
    const document = wrap.value;
    // Meshes are NOT re-walked on the document gate: the mesh validation above
    // is the same call the import already made, and doing it twice is the cost
    // this measurement exists to show is not being paid.
    const docValidate = timed(() => validateGeometryDocument(document, { validateMeshes: false }));
    const docBounds = timed(() => documentBounds(document));
    const docRender = timed(() => buildDocumentRender(document));
    const docBytes = documentByteLength(document);

    const store = new ResidentDocumentStore();
    const commit = timed(() => store.commit(document));

    const topology = timed(
      () =>
        analyseTopology(mesh, {
          documentId: 'bench',
          documentRevision: 1,
          partId: 'part-1',
          cancellation: uncancellable,
        }).report,
    );

    const writer = requireWriter(MeshFormatId.Stl);
    const exportStarted = performance.now();
    await writer.write(mesh, {
      cancellation: uncancellable,
      budget: DEFAULT_IMPORT_BUDGET,
      encoding: 'binary',
      yieldToEventLoop,
      progress: { report: (): void => undefined },
    });
    const exportElapsed = performance.now() - exportStarted;

    process.stdout.write(
      `${String(sizeMb).padStart(3)} MiB  ${triangleCount(mesh).toLocaleString().padStart(10)} triangles\n` +
        `  validate      bare ${ms(bareValidate.elapsed)}   document ${ms(docValidate.elapsed)}\n` +
        `  bounds        bare ${ms(bareBounds.elapsed)}   document ${ms(docBounds.elapsed)}\n` +
        `  render        bare ${ms(bareRender.elapsed)}   document ${ms(docRender.elapsed)}\n` +
        `  wrap                       ${ms(wrap.elapsed)}\n` +
        `  resident commit            ${ms(commit.elapsed)}\n` +
        `  topology                   ${ms(topology.elapsed)}\n` +
        `  export (binary)            ${ms(exportElapsed)}\n` +
        `  geometry bytes  bare ${mib(bareBytes).padStart(10)}   document ${mib(docBytes).padStart(10)}\n` +
        `  render bytes                 ${mib(docRender.value.bytes)}\n\n`,
    );
  }
});

it('measures how part count scales, with and without shared geometry', () => {
  const counts = [1, 10, 100, 1000];
  const base = buildStl(1024 * 1024);

  process.stdout.write(
    `\nMULTI-PART SCALING — one shared mesh placed N times\n` +
      `  (the same base mesh; only the number of PLACEMENTS changes)\n\n`,
  );

  // Parsed once, synchronously reused: the point is the document layer, not the
  // parser, and re-parsing per count would measure the wrong thing.
  const mesh: CanonicalMesh = {
    positions: new Float32Array(base.triangles * 9),
    indices: new Uint32Array(base.triangles * 3),
    metadata: { sourceFormat: 'stl' },
  };
  for (let index = 0; index < mesh.indices.length; index += 1) mesh.indices[index] = index;
  for (let index = 0; index < mesh.positions.length; index += 1) {
    mesh.positions[index] = (index % 97) * 0.01;
  }

  for (const count of counts) {
    const buildParts = timed(() => {
      const parts: GeometryPart[] = [];
      for (let index = 0; index < count; index += 1) {
        parts.push({
          id: partId(`p${String(index)}`),
          mesh,
          transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, index * 2, 0, 0],
        });
      }
      return { parts } satisfies GeometryDocument;
    });
    const document = buildParts.value;

    const store = new ResidentDocumentStore();
    const commit = timed(() => store.commit(document));
    const validate = timed(() => validateGeometryDocument(document, { validateMeshes: false }));
    const render = timed(() => buildDocumentRender(document));
    const bounds = timed(() => documentBounds(document));

    // "Switching the active part" on the main thread is a metadata lookup and
    // nothing else. Measured over every part so the number is not one lucky hit.
    const switchAll = timed(() => {
      let found = 0;
      for (const part of document.parts) {
        const target = document.parts.find((candidate) => candidate.id === part.id);
        if (target !== undefined) found += 1;
      }
      return found;
    });

    const meshes = distinctMeshes(document);
    process.stdout.write(
      `${String(count).padStart(5)} parts  ${documentTriangleCount(document).toLocaleString().padStart(12)} triangles across the document\n` +
        `  build document        ${ms(buildParts.elapsed)}\n` +
        `  validate              ${ms(validate.elapsed)}\n` +
        `  resident commit       ${ms(commit.elapsed)}\n` +
        `  render snapshot       ${ms(render.elapsed)}   (${String(render.value.buffers)} GPU buffers)\n` +
        `  document bounds       ${ms(bounds.elapsed)}\n` +
        `  switch every part     ${ms(switchAll.elapsed)}   (${String(switchAll.value)} lookups)\n` +
        `  DISTINCT meshes       ${String(meshes.length).padStart(8)}\n` +
        `  geometry bytes        ${mib(documentByteLength(document)).padStart(11)}` +
        `   (naive per-part would be ${mib(meshByteLength(mesh) * count)})\n\n`,
    );
  }
});
