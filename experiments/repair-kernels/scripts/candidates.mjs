/**
 * Candidate adapters for the Stage 3A-2 bakeoff.
 *
 * RESEARCH ONLY. Loaded by the bakeoff suite; never imported by the
 * application.
 *
 * Each adapter owns the JS↔WASM marshalling for one candidate and nothing else.
 * They deliberately do NOT decide whether an operation succeeded — they report
 * status, counts and geometry, and the harness runs CAD Fixer's own validators
 * to form a verdict. See docs/repair/REPAIR_ARCHITECTURE.md.
 *
 * MARSHALLING CONTRACT, identical for all three: one input copy in, one call,
 * one output copy out. Three boundary crossings per operation regardless of
 * mesh size.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Status a candidate reports when it cannot represent the input at all. */
export const UNSUPPORTED_INPUT_CLASS = 'UNSUPPORTED_INPUT_CLASS';
export const UNSUPPORTED_OPERATION = 'UNSUPPORTED_OPERATION';

/**
 * Copies a mesh into the WASM heap, calls one function, and copies the result
 * back out.
 *
 * @param {any} mod
 * @param {Float64Array} positions
 * @param {Uint32Array} triangles
 * @param {(posPtr: number, vertexCount: number, triPtr: number, triangleCount: number) => number} call
 * @param {{ vertexCount: () => number, triangleCount: () => number, positionsPtr: () => number, trianglesPtr: () => number }} readers
 */
function marshal(mod, positions, triangles, call, readers) {
  const vertexCount = positions.length / 3;
  const triangleCount = triangles.length / 3;

  const posPtr = mod._malloc(positions.byteLength);
  const triPtr = mod._malloc(triangles.byteLength);
  // HEAPU8 is not in the exported runtime list; HEAPF64 shares the same
  // underlying WebAssembly.Memory buffer, so its byteLength is the heap size.
  const heapBefore = mod.HEAPF64.buffer.byteLength;

  mod.HEAPF64.set(positions, posPtr / 8);
  mod.HEAPU32.set(triangles, triPtr / 4);

  const startedAt = performance.now();
  const status = call(posPtr, vertexCount, triPtr, triangleCount);
  const kernelMs = performance.now() - startedAt;

  const outVerts = readers.vertexCount();
  const outTris = readers.triangleCount();

  let outPositions;
  let outTriangles;
  if (outVerts > 0 && outTris > 0) {
    const pPtr = readers.positionsPtr();
    const tPtr = readers.trianglesPtr();
    // Copied, not viewed: the heap can move under memory growth, and a view
    // handed to the harness would silently become garbage.
    outPositions = new Float64Array(mod.HEAPF64.buffer, pPtr, outVerts * 3).slice();
    outTriangles = new Uint32Array(mod.HEAPU32.buffer, tPtr, outTris * 3).slice();
  }

  const heapAfter = mod.HEAPF64.buffer.byteLength;
  mod._free(posPtr);
  mod._free(triPtr);

  return { status, kernelMs, outPositions, outTriangles, heapBefore, heapAfter };
}

export function artifactInfo(candidateId, wasmName) {
  const path = join(ROOT, candidateId, 'artifacts', wasmName);
  if (!existsSync(path)) return { path, bytes: 0, sha256: 'missing' };
  const bytes = readFileSync(path);
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/* ------------------------------------------------------------- manifold -- */

export async function loadManifold() {
  const dir = join(ROOT, 'manifold', 'artifacts');
  const { default: create } = await import(join(dir, 'manifold-candidate.js'));
  const wasmBinary = readFileSync(join(dir, 'manifold-candidate.wasm'));
  const startedAt = performance.now();
  const mod = await create({ wasmBinary });
  const initMs = performance.now() - startedAt;

  const OPS = { ingest: 0, merge: 1, selfUnion: 2 };

  return {
    id: 'manifold',
    initMs,
    artifact: artifactInfo('manifold', 'manifold-candidate.wasm'),
    supports: ['ingest', 'merge', 'selfUnion', 'boolean'],
    run(operation, positions, triangles) {
      const code = OPS[operation];
      if (code === undefined) return { unsupported: UNSUPPORTED_OPERATION };
      const out = marshal(
        mod,
        positions,
        triangles,
        (p, vc, t, tc) => mod._cf_run(code, p, vc, t, tc),
        {
          vertexCount: () => mod._cf_vertex_count(),
          triangleCount: () => mod._cf_triangle_count(),
          positionsPtr: () => mod._cf_positions(),
          trianglesPtr: () => mod._cf_triangles(),
        },
      );
      const extra = {
        kernelReportedSuccess: mod._cf_kernel_reported_success() === 1,
        genus: mod._cf_genus(),
        volume: mod._cf_volume(),
        components: mod._cf_component_count(),
      };
      mod._cf_reset();
      return { ...out, ...extra };
    },
    boolean(opType, a, b) {
      const aPos = mod._malloc(a.positions.byteLength);
      const aTri = mod._malloc(a.triangles.byteLength);
      const bPos = mod._malloc(b.positions.byteLength);
      const bTri = mod._malloc(b.triangles.byteLength);
      mod.HEAPF64.set(a.positions, aPos / 8);
      mod.HEAPU32.set(a.triangles, aTri / 4);
      mod.HEAPF64.set(b.positions, bPos / 8);
      mod.HEAPU32.set(b.triangles, bTri / 4);

      const startedAt = performance.now();
      const status = mod._cf_boolean(
        opType,
        aPos,
        a.positions.length / 3,
        aTri,
        a.triangles.length / 3,
        bPos,
        b.positions.length / 3,
        bTri,
        b.triangles.length / 3,
      );
      const kernelMs = performance.now() - startedAt;

      const outVerts = mod._cf_vertex_count();
      const outTris = mod._cf_triangle_count();
      const result = {
        status,
        kernelMs,
        vertices: outVerts,
        triangles: outTris,
        volume: mod._cf_volume(),
        components: mod._cf_component_count(),
        outPositions:
          outVerts > 0
            ? new Float64Array(mod.HEAPF64.buffer, mod._cf_positions(), outVerts * 3).slice()
            : undefined,
        outTriangles:
          outTris > 0
            ? new Uint32Array(mod.HEAPU32.buffer, mod._cf_triangles(), outTris * 3).slice()
            : undefined,
      };
      mod._free(aPos);
      mod._free(aTri);
      mod._free(bPos);
      mod._free(bTri);
      mod._cf_reset();
      return result;
    },
  };
}

/* -------------------------------------------------------------- geogram -- */

export async function loadGeogram() {
  const dir = join(ROOT, 'geogram', 'artifacts');
  const { default: create } = await import(join(dir, 'geogram-candidate.js'));
  const wasmBinary = readFileSync(join(dir, 'geogram-candidate.wasm'));
  const startedAt = performance.now();
  const mod = await create({ wasmBinary });
  const initMs = performance.now() - startedAt;

  // Each name is ONE Geogram API, never a generic "repair".
  const OPS = {
    repairTopology: 0,
    repairDuplicateFacets: 1,
    repairColocate: 2,
    reorient: 3,
    intersectSurface: 4,
  };

  return {
    id: 'geogram',
    initMs,
    artifact: artifactInfo('geogram', 'geogram-candidate.wasm'),
    supports: Object.keys(OPS),
    run(operation, positions, triangles, epsilon = 0) {
      const code = OPS[operation];
      if (code === undefined) return { unsupported: UNSUPPORTED_OPERATION };
      const out = marshal(
        mod,
        positions,
        triangles,
        (p, vc, t, tc) => mod._cf_g_run(code, p, vc, t, tc, epsilon),
        {
          vertexCount: () => mod._cf_g_vertex_count(),
          triangleCount: () => mod._cf_g_triangle_count(),
          positionsPtr: () => mod._cf_g_positions(),
          trianglesPtr: () => mod._cf_g_triangles(),
        },
      );
      const extra = { moebiusFacets: mod._cf_g_moebius_facets() };
      mod._cf_g_reset();
      return { ...out, ...extra };
    },
  };
}

/* ------------------------------------------------------------------ pmp -- */

export async function loadPmp() {
  const dir = join(ROOT, 'pmp', 'artifacts');
  const { default: create } = await import(join(dir, 'pmp-candidate.js'));
  const wasmBinary = readFileSync(join(dir, 'pmp-candidate.wasm'));
  const startedAt = performance.now();
  const mod = await create({ wasmBinary });
  const initMs = performance.now() - startedAt;

  const OPS = { ingest: 0, fillHoles: 1, remesh: 2 };

  return {
    id: 'pmp',
    initMs,
    artifact: artifactInfo('pmp', 'pmp-candidate.wasm'),
    supports: Object.keys(OPS),
    run(operation, positions, triangles, parameter = 0) {
      const code = OPS[operation];
      if (code === undefined) return { unsupported: UNSUPPORTED_OPERATION };
      const out = marshal(
        mod,
        positions,
        triangles,
        (p, vc, t, tc) => mod._cf_p_run(code, p, vc, t, tc, parameter),
        {
          vertexCount: () => mod._cf_p_vertex_count(),
          triangleCount: () => mod._cf_p_triangle_count(),
          positionsPtr: () => mod._cf_p_positions(),
          trianglesPtr: () => mod._cf_p_triangles(),
        },
      );
      const extra = {
        filledHoles: mod._cf_p_filled_holes(),
        // 10 is the binding's precondition-failure code: PMP's halfedge
        // structure cannot represent this input at all. A role finding, not an
        // algorithmic failure.
        unsupportedInput: out.status === 10,
      };
      mod._cf_p_reset();
      return { ...out, ...extra };
    },
  };
}
