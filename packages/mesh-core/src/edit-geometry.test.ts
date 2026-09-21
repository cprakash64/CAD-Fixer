import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from './mesh';
import {
  classifyEditPlane,
  createEditFrame,
  growEditRegion,
  measureEditPlanarity,
  selectEditSurface,
  transformEditNormal,
  transformEditPoint,
} from './edit-geometry';
import type { PartTransform } from './document';
const mesh = (points: number[], indices: number[]): CanonicalMesh => ({
  positions: createPositionArray(points.length),
  indices: createIndexArray(indices.length),
  metadata: {},
});
function shape(points: number[], indices: number[]): CanonicalMesh {
  const m = mesh(points, indices);
  m.positions.set(points);
  m.indices.set(indices);
  return m;
}
const square = shape([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
describe('bounded surface selection', () => {
  it('grows across exact-coordinate shared edges and returns deterministic order', () => {
    expect(growEditRegion(square, 1, { maxNormalAngleRadians: 0.01, maxTriangles: 2 })).toEqual([
      0, 1,
    ]);
    expect(() =>
      growEditRegion(square, 0, { maxNormalAngleRadians: 0.01, maxTriangles: 1 }),
    ).toThrow(/limit is 1/);
    const cancel = { isCancelled: true, onCancelled: (): (() => void) => () => undefined };
    expect(() =>
      growEditRegion(square, 0, {
        maxNormalAngleRadians: 0.01,
        maxTriangles: 2,
        cancellation: cancel,
      }),
    ).toThrow(/cancelled/);
  });
  it('distinguishes planar from bent geometry and constructs a right-handed frame', () => {
    const s = selectEditSurface(square, 0, { maxNormalAngleRadians: 0.1, maxTriangles: 2 }, 0.001);
    expect(s.planarity.kind).toBe('PLANAR');
    expect(s.triangleIds).toEqual([0, 1]);
    const cross = [
      s.frame.tangentU[1] * s.frame.tangentV[2] - s.frame.tangentU[2] * s.frame.tangentV[1],
      s.frame.tangentU[2] * s.frame.tangentV[0] - s.frame.tangentU[0] * s.frame.tangentV[2],
      s.frame.tangentU[0] * s.frame.tangentV[1] - s.frame.tangentU[1] * s.frame.tangentV[0],
    ];
    expect(cross).toEqual(s.frame.normal);
    const bent = shape([0, 0, 0, 1, 0, 0, 1, 1, 0.2, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
    expect(
      measureEditPlanarity(bent, [0, 1], createEditFrame([0, 0, 0], [0, 0, 1]), 0.01, 0.1).kind,
    ).toBe('NON_PLANAR');
  });
  it('keeps plane tolerance local and explicit', () => {
    const p = createEditFrame([0, 0, 0], [0, 0, 1]);
    expect(classifyEditPlane(p, [0, 0, 0.02], 0.01)).toBe(1);
    expect(classifyEditPlane(p, [0, 0, -0.02], 0.01)).toBe(-1);
    expect(classifyEditPlane(p, [0, 0, 0.005], 0.01)).toBe(0);
  });
  it('transforms point and normal under part rotation and translation', () => {
    const t: PartTransform = [0, 1, 0, -1, 0, 0, 0, 0, 1, 10, 20, 30];
    expect(transformEditPoint([1, 0, 0], t)).toEqual([10, 21, 30]);
    expect(transformEditNormal([1, 0, 0], t)).toEqual([0, 1, 0]);
  });
});
