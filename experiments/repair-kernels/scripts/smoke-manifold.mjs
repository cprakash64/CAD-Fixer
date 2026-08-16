#!/usr/bin/env node
/**
 * Manifold candidate smoke test.
 *
 * Run before the bakeoff to establish that the artifact loads, that the flat
 * binding round-trips a mesh, and that Manifold rejects what it says it
 * rejects. A bakeoff run against a broken artifact would produce a page of
 * failures that say nothing about the kernel.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ARTIFACTS = join(import.meta.dirname, '..', 'manifold', 'artifacts');

const { default: createModule } = await import(join(ARTIFACTS, 'manifold-candidate.js'));
const wasmBinary = readFileSync(join(ARTIFACTS, 'manifold-candidate.wasm'));

const started = performance.now();
const mod = await createModule({ wasmBinary });
const initMs = performance.now() - started;

/** Closed unit tetrahedron, wound outward. */
const TETRA_POS = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10];
const TETRA_TRIS = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];

/** Three faces sharing one edge: a non-manifold edge. */
const NONMANIFOLD_POS = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 0, -10, 0];
const NONMANIFOLD_TRIS = [0, 1, 2, 0, 1, 3, 0, 1, 4];

function run(operation, positions, triangles) {
  const vertexCount = positions.length / 3;
  const triangleCount = triangles.length / 3;

  const posPtr = mod._malloc(positions.length * 8);
  const triPtr = mod._malloc(triangles.length * 4);
  mod.HEAPF64.set(new Float64Array(positions), posPtr / 8);
  mod.HEAPU32.set(new Uint32Array(triangles), triPtr / 4);

  const status = mod._cf_run(operation, posPtr, vertexCount, triPtr, triangleCount);

  const outVerts = mod._cf_vertex_count();
  const outTris = mod._cf_triangle_count();
  const result = {
    status,
    kernelSuccess: mod._cf_kernel_reported_success() === 1,
    vertices: outVerts,
    triangles: outTris,
    genus: mod._cf_genus(),
    volume: mod._cf_volume(),
    area: mod._cf_surface_area(),
    components: mod._cf_component_count(),
  };

  mod._free(posPtr);
  mod._free(triPtr);
  mod._cf_reset();
  return result;
}

console.error(`init: ${initMs.toFixed(1)} ms`);
console.error('clean tetrahedron (ingest):', JSON.stringify(run(0, TETRA_POS, TETRA_TRIS)));
console.error(
  'non-manifold edge (ingest):',
  JSON.stringify(run(0, NONMANIFOLD_POS, NONMANIFOLD_TRIS)),
);
console.error(
  'non-manifold edge (merge):',
  JSON.stringify(run(1, NONMANIFOLD_POS, NONMANIFOLD_TRIS)),
);
console.error('clean tetrahedron (self-union):', JSON.stringify(run(2, TETRA_POS, TETRA_TRIS)));
