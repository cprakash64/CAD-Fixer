/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import { tetrahedron } from '@cadfixer/mesh-topology/fixtures';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CancellationSource } from '@cadfixer/shared';
import {
  booleanDifference,
  booleanIntersection,
  booleanUnion,
  type BooleanBackend,
} from './boolean-adapter';
const a = tetrahedron(),
  b = tetrahedron([0.2, 0.2, 0.2]);
const backend: BooleanBackend = {
  async operate(_kind, left) {
    return left;
  },
};
describe('validated boolean seam', () => {
  it('accepts eligible closed inputs and checks the backend result', async () => {
    const result = await booleanUnion(backend, a, b, new CancellationSource().token);
    expect(result.outputReport.boundaryEdgeCount).toBe(0);
    expect(result.mesh).toBe(a);
    await expect(
      booleanDifference(backend, a, b, new CancellationSource().token),
    ).resolves.toBeDefined();
    await expect(
      booleanIntersection(backend, a, b, new CancellationSource().token),
    ).resolves.toBeDefined();
  });
  it('refuses open soup before invoking the backend', async () => {
    let invoked = false;
    const bad: BooleanBackend = {
      async operate() {
        invoked = true;
        return a;
      },
    };
    const open: CanonicalMesh = {
      positions: createPositionArray(9),
      indices: createIndexArray(3),
      metadata: {},
    };
    open.positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    open.indices.set([0, 1, 2]);
    await expect(booleanUnion(bad, open, b, new CancellationSource().token)).rejects.toThrow(
      /closed, manifold/,
    );
    expect(invoked).toBe(false);
  });
  it('rejects invalid kernel output rather than trusting success', async () => {
    const broken: BooleanBackend = {
      async operate() {
        return { positions: createPositionArray(9), indices: createIndexArray(3), metadata: {} };
      },
    };
    await expect(booleanUnion(broken, a, b, new CancellationSource().token)).rejects.toThrow();
  });
  it('honors cancellation before kernel invocation', async () => {
    const cancelled = new CancellationSource();
    cancelled.cancel();
    await expect(booleanUnion(backend, a, b, cancelled.token)).rejects.toThrow();
  });
});
