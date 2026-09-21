import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { pickPartTriangle } from './pick-part';
function part(z: number, flip = false): Mesh {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new Float32BufferAttribute(
      flip ? [-1, -1, z, 0, 1, z, 1, -1, z] : [-1, -1, z, 1, -1, z, 0, 1, z],
      3,
    ),
  );
  g.computeVertexNormals();
  return new Mesh(g, new MeshBasicMaterial({ side: DoubleSide }));
}
const camera = new PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 0, 5);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
describe('viewport picking seam', () => {
  it('chooses the nearest overlapping part and retains stable identity', () => {
    const parts = new Map([
      ['far', part(0)],
      ['near', part(1)],
    ]);
    expect(pickPartTriangle(camera, [0, 0], parts)?.partId).toBe('near');
    expect(pickPartTriangle(camera, [0, 0], parts)?.triangleIndex).toBe(0);
  });
  it('supports repeated placements and back-facing triangles', () => {
    const a = part(0, true);
    a.position.set(2, 0, 0);
    const b = part(0, true);
    const parts = new Map([
      ['a', a],
      ['b', b],
    ]);
    expect(pickPartTriangle(camera, [0, 0], parts)?.partId).toBe('b');
  });
  it('returns the transformed world point and normal with a rotated camera', () => {
    const mesh = part(0);
    mesh.rotation.set(0.35, 0.55, 0.2);
    mesh.position.set(1.5, -0.4, 0.7);
    mesh.updateMatrixWorld(true);
    const target = new Vector3(0, -1 / 3, 0).applyMatrix4(mesh.matrixWorld);
    const rotated = new PerspectiveCamera(45, 1, 0.1, 100);
    rotated.position.set(7, 4, 8);
    rotated.lookAt(target);
    rotated.updateMatrixWorld();
    const projected = target.clone().project(rotated);
    const hit = pickPartTriangle(rotated, [projected.x, projected.y], new Map([['rotated', mesh]]));
    expect(hit?.partId).toBe('rotated');
    expect(hit?.triangleIndex).toBe(0);
    expect(hit?.point[0]).toBeCloseTo(target.x, 5);
    expect(hit?.point[1]).toBeCloseTo(target.y, 5);
    expect(hit?.point[2]).toBeCloseTo(target.z, 5);
    const expectedNormal = new Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
    expect(hit?.normal[0]).toBeCloseTo(expectedNormal.x, 5);
    expect(hit?.normal[1]).toBeCloseTo(expectedNormal.y, 5);
    expect(hit?.normal[2]).toBeCloseTo(expectedNormal.z, 5);
  });
  it('picks the same triangle when the camera is zoomed near and far', () => {
    const mesh = part(0);
    for (const distance of [2, 25]) {
      const zoomed = new PerspectiveCamera(distance === 2 ? 30 : 65, 1, 0.01, 100);
      zoomed.position.set(0, 0, distance);
      zoomed.lookAt(0, 0, 0);
      zoomed.updateMatrixWorld();
      expect(pickPartTriangle(zoomed, [0, 0], new Map([['zoom', mesh]]))).toMatchObject({
        partId: 'zoom',
        triangleIndex: 0,
      });
    }
  });
  it('selects deterministically on both sides of a shared edge', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.computeVertexNormals();
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
    const parts = new Map([['square', mesh]]);
    const epsilon = 1e-5;
    const a = new Vector3(-epsilon, -epsilon, 0).project(camera);
    const b = new Vector3(epsilon, epsilon, 0).project(camera);
    expect(pickPartTriangle(camera, [a.x, a.y], parts)?.triangleIndex).toBe(0);
    expect(pickPartTriangle(camera, [b.x, b.y], parts)?.triangleIndex).toBe(1);
    const edge = new Vector3(0, 0, 0).project(camera);
    expect(pickPartTriangle(camera, [edge.x, edge.y], parts)?.triangleIndex).toBe(0);
  });
});
