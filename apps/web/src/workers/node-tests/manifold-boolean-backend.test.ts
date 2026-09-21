import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tetrahedron } from '@cadfixer/mesh-topology/fixtures';
import { CancellationSource } from '@cadfixer/shared';
import { booleanUnion, booleanDifference, booleanIntersection } from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
describe('pinned Manifold boolean artifact', () => {
  it('performs and validates union, difference, and intersection', async () => {
    const backend = await createManifoldBooleanBackend(binary);
    const a = tetrahedron(),
      b = tetrahedron([0.2, 0.2, 0.2]);
    for (const operation of [booleanUnion, booleanDifference, booleanIntersection]) {
      const result = await operation(backend, a, b, new CancellationSource().token);
      expect(result.outputReport.boundaryEdgeCount).toBe(0);
      expect(result.outputReport.nonManifoldEdgeCount).toBe(0);
      expect(result.mesh.indices.length).toBeGreaterThan(0);
    }
  });
});
