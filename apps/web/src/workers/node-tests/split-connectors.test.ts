import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  triangleCount,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { CancellationSource } from '@cadfixer/shared';
import {
  dovetailFemaleDimensions,
  meshVolume,
  roundSocketRadius,
  splitWithConnectors,
  type SplitConnector,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
function cube(size = 20): CanonicalMesh {
  const h = size / 2,
    p = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h],
    i = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
function translatedCube(x: number, y: number, z: number, size = 10): CanonicalMesh {
  const mesh = cube(size),
    positions = createPositionArray(mesh.positions.length);
  for (let at = 0; at < positions.length; at += 3) {
    positions[at] = (mesh.positions[at] ?? 0) + x;
    positions[at + 1] = (mesh.positions[at + 1] ?? 0) + y;
    positions[at + 2] = (mesh.positions[at + 2] ?? 0) + z;
  }
  return { ...mesh, positions };
}
function combine(...meshes: readonly CanonicalMesh[]): CanonicalMesh {
  const positions = createPositionArray(
      meshes.reduce((sum, mesh) => sum + mesh.positions.length, 0),
    ),
    indices = createIndexArray(meshes.reduce((sum, mesh) => sum + mesh.indices.length, 0));
  let positionAt = 0,
    indexAt = 0,
    vertexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, positionAt);
    for (const index of mesh.indices) indices[indexAt++] = index + vertexOffset;
    positionAt += mesh.positions.length;
    vertexOffset += mesh.positions.length / 3;
  }
  return { positions, indices, metadata: {} };
}
function indexArray(values: readonly number[]): ReturnType<typeof createIndexArray> {
  const result = createIndexArray(values.length);
  result.set(values);
  return result;
}
function torus(major = 8, minor = 3, around = 64, tube = 24): CanonicalMesh {
  const positions = createPositionArray(around * tube * 3),
    indices = createIndexArray(around * tube * 6);
  let p = 0,
    f = 0;
  for (let i = 0; i < around; i++)
    for (let j = 0; j < tube; j++) {
      const u = (i / around) * Math.PI * 2,
        v = (j / tube) * Math.PI * 2,
        radius = major + minor * Math.cos(v);
      positions.set([radius * Math.cos(u), radius * Math.sin(u), minor * Math.sin(v)], p);
      p += 3;
      const nextI = (i + 1) % around,
        nextJ = (j + 1) % tube,
        a = i * tube + j,
        b = nextI * tube + j,
        c = nextI * tube + nextJ,
        d = i * tube + nextJ;
      indices.set([a, b, d, b, c, d], f);
      f += 6;
    }
  return { positions, indices, metadata: {} };
}
async function runOn(source: CanonicalMesh, connector: SplitConnector): Promise<SplitResult> {
  const backend = await createManifoldBooleanBackend(binary);
  return splitWithConnectors(
    backend,
    source,
    { plane: { origin: [0, 0, 0], normal: [0, 0, 1] }, connector },
    new CancellationSource().token,
  );
}
async function splitAt(
  source: CanonicalMesh,
  origin: readonly [number, number, number],
  normal: readonly [number, number, number],
): Promise<SplitResult> {
  const backend = await createManifoldBooleanBackend(binary);
  return splitWithConnectors(
    backend,
    source,
    { plane: { origin, normal }, connector: { kind: 'none' } },
    new CancellationSource().token,
  );
}
function cylinderMesh(segments = 64, radius = 8, height = 20): CanonicalMesh {
  const positions = createPositionArray(segments * 2 * 3),
    indices = createIndexArray((segments * 2 + (segments - 2) * 2) * 3);
  for (let side = 0; side < 2; side++)
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2,
        at = (side * segments + i) * 3;
      positions.set(
        [Math.cos(angle) * radius, Math.sin(angle) * radius, side ? height / 2 : -height / 2],
        at,
      );
    }
  let at = 0;
  for (let i = 1; i + 1 < segments; i++) {
    indices.set([0, i + 1, i], at);
    at += 3;
    indices.set([segments, segments + i, segments + i + 1], at);
    at += 3;
  }
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    indices.set([i, next, segments + next, i, segments + next, segments + i], at);
    at += 6;
  }
  return { positions, indices, metadata: {} };
}
function concavePrism(): CanonicalMesh {
  const outline = [
      [-6, -6],
      [6, -6],
      [6, -2],
      [-2, -2],
      [-2, 6],
      [-6, 6],
    ] as const,
    positions = createPositionArray(outline.length * 2 * 3),
    faces: number[] = [],
    cap = [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 5],
      [3, 4, 5],
    ] as const;
  for (let side = 0; side < 2; side++)
    outline.forEach(([x, y], i) => {
      positions.set([x, y, side ? 5 : -5], (side * outline.length + i) * 3);
    });
  for (const [a, b, c] of cap) faces.push(a, c, b, a + 6, b + 6, c + 6);
  for (let i = 0; i < 6; i++) {
    const n = (i + 1) % 6;
    faces.push(i, n, n + 6, i, n + 6, i + 6);
  }
  return { positions, indices: indexArray(faces), metadata: {} };
}
async function run(connector: SplitConnector): Promise<SplitResult> {
  const backend = await createManifoldBooleanBackend(binary),
    source = cube();
  return splitWithConnectors(
    backend,
    source,
    { plane: { origin: [0, 0, 0], normal: [1, 0, 0] }, connector },
    new CancellationSource().token,
  );
}

describe('Stage 7B split and connectors', () => {
  it('7B-S01/S12 creates two closed pieces and conserves cube volume', async () => {
    const source = cube(),
      result = await run({ kind: 'none' });
    expect(triangleCount(result.pieceA)).toBeGreaterThan(0);
    expect(triangleCount(result.pieceB)).toBeGreaterThan(0);
    expect(result.cutA.triangleIds.length).toBeGreaterThan(0);
    expect(result.cutB.triangleIds.length).toBeGreaterThan(0);
    expect(result.metrics.volumeRelativeError).toBeLessThan(1e-5);
    expect(meshVolume(result.pieceA) + meshVolume(result.pieceB)).toBeCloseTo(
      meshVolume(source),
      4,
    );
  });
  it('7B-S03/S04 refuses a missing or tangent plane before Boolean work', async () => {
    const backend = await createManifoldBooleanBackend(binary),
      source = cube();
    for (const x of [10, 30])
      await expect(
        splitWithConnectors(
          backend,
          source,
          { plane: { origin: [x, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
          new CancellationSource().token,
        ),
      ).rejects.toThrow(/does not pass through enough/);
  });
  it('7B-P01 adds a round pin and socket with radial clearance', async () => {
    const baseline = await run({ kind: 'none' }),
      result = await run({
        kind: 'pin',
        count: 1,
        diameter: 3,
        depth: 4,
        clearance: 0.2,
        maleSide: 'A',
      });
    expect(result.connector).toMatchObject({ kind: 'pin', clearance: 0.2 });
    // Male A grows into B and the socket is removed from B. These volume
    // directions catch a cavity accidentally built on the non-receiving side.
    expect(meshVolume(result.pieceA)).toBeGreaterThan(meshVolume(baseline.pieceA));
    expect(meshVolume(result.pieceB)).toBeLessThan(meshVolume(baseline.pieceB));
  });
  it('7B-P02/P03/P04 places multiple pins, flips the mating sides, and applies radial clearance once', async () => {
    const baseline = await run({ kind: 'none' }),
      noGap = await run({
        kind: 'pin',
        count: 2,
        diameter: 2,
        depth: 3,
        clearance: 0,
        maleSide: 'B',
      }),
      gap = await run({
        kind: 'pin',
        count: 2,
        diameter: 2,
        depth: 3,
        clearance: 0.4,
        maleSide: 'B',
      });
    expect(meshVolume(noGap.pieceB)).toBeGreaterThan(meshVolume(baseline.pieceB));
    expect(meshVolume(noGap.pieceA)).toBeLessThan(meshVolume(baseline.pieceA));
    expect(meshVolume(gap.pieceA)).toBeLessThan(meshVolume(noGap.pieceA));
    expect(meshVolume(gap.pieceB)).toBeCloseTo(meshVolume(noGap.pieceB), 5);
  });
  it('7B-D01 adds one bounded dovetail', async () => {
    const baseline = await run({ kind: 'none' }),
      result = await run({
        kind: 'dovetail',
        width: 4,
        depth: 3,
        length: 6,
        clearance: 0.2,
        maleSide: 'B',
        orientationDegrees: 90,
      });
    expect(result.connector).toMatchObject({ kind: 'dovetail', orientationDegrees: 90 });
    expect(meshVolume(result.pieceB)).toBeGreaterThan(meshVolume(baseline.pieceB));
    expect(meshVolume(result.pieceA)).toBeLessThan(meshVolume(baseline.pieceA));
  });
  it('7B-D02/D03/D04 aligns both orientations and expands only the female profile', async () => {
    const zero = await run({
        kind: 'dovetail',
        width: 4,
        depth: 3,
        length: 6,
        clearance: 0,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
      gap = await run({
        kind: 'dovetail',
        width: 4,
        depth: 3,
        length: 6,
        clearance: 0.3,
        maleSide: 'A',
        orientationDegrees: 90,
      });
    expect(meshVolume(gap.pieceA)).toBeCloseTo(meshVolume(zero.pieceA), 5);
    expect(meshVolume(gap.pieceB)).toBeLessThan(meshVolume(zero.pieceB));
  });
  it('7B-P05/D06 refuses connectors that do not fit the cut surface', async () => {
    await expect(
      run({ kind: 'pin', count: 1, diameter: 30, depth: 4, clearance: 0.2, maleSide: 'A' }),
    ).rejects.toThrow(/does not fit/);
    await expect(
      run({
        kind: 'dovetail',
        width: 30,
        depth: 3,
        length: 30,
        clearance: 0.2,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
    ).rejects.toThrow(/does not fit/);
  });
  it('7B-P04/D04 defines clearance dimensions directly', () => {
    expect(roundSocketRadius(4, 0.2)).toBe(2.2);
    expect(dovetailFemaleDimensions(8, 12, 0.2)).toEqual({ width: 8.4, length: 12.4 });
  });
  it('7B-C01/C02 keeps placement in material on a cap with a hole and refuses oversize', async () => {
    const source = torus(),
      result = await runOn(source, {
        kind: 'pin',
        count: 1,
        diameter: 1,
        depth: 2,
        clearance: 0.1,
        maleSide: 'A',
      }),
      placement = result.placements[0];
    expect(placement).toBeDefined();
    const radial = Math.hypot(placement?.[0] ?? 0, placement?.[1] ?? 0);
    expect(radial).toBeGreaterThan(5);
    expect(radial).toBeLessThan(11);
    expect(result.cutA.centerEdgeDistance).toBeGreaterThan(0.6);
    await expect(
      runOn(source, {
        kind: 'pin',
        count: 1,
        diameter: 6,
        depth: 2,
        clearance: 0.2,
        maleSide: 'A',
      }),
    ).rejects.toThrow(/edge margin|does not fit/);
  });
  it('7B-C04 places a dovetail in torus material rather than across its hole', async () => {
    const result = await runOn(torus(), {
        kind: 'dovetail',
        width: 1,
        depth: 2,
        length: 2,
        clearance: 0.1,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
      placement = result.placements[0];
    expect(Math.hypot(placement?.[0] ?? 0, placement?.[1] ?? 0)).toBeGreaterThan(5);
  });
  it('7B-C03 chooses deterministic valid regions across disconnected cut loops', async () => {
    const source = combine(translatedCube(0, -12, 0), translatedCube(0, 12, 0)),
      connector: SplitConnector = {
        kind: 'pin',
        count: 2,
        diameter: 2,
        depth: 2,
        clearance: 0.1,
        maleSide: 'A',
      },
      first = await runOn(source, connector),
      second = await runOn(source, connector);
    expect(first.placements).toEqual(second.placements);
    expect(first.placements).toHaveLength(2);
    for (const placement of first.placements) expect(Math.abs(placement[1])).toBeGreaterThan(7);
  });
  it('7B-P07 qualifies four non-overlapping pins with edge inset', async () => {
    const result = await run({
      kind: 'pin',
      count: 4,
      diameter: 2,
      depth: 3,
      clearance: 0.1,
      maleSide: 'A',
    });
    expect(result.placements).toHaveLength(4);
    for (let a = 0; a < result.placements.length; a++)
      for (let b = a + 1; b < result.placements.length; b++) {
        const left = result.placements[a] ?? [0, 0, 0],
          right = result.placements[b] ?? [0, 0, 0];
        expect(
          Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]),
        ).toBeGreaterThan(2);
      }
  });
  it('7B-P06/D05 qualifies explicit safe inset and near-edge refusals', async () => {
    const safePin = await run({
      kind: 'pin',
      count: 1,
      diameter: 2,
      depth: 3,
      clearance: 0.2,
      maleSide: 'A',
    });
    expect(safePin.cutA.centerEdgeDistance).toBeGreaterThan(1.55);
    await expect(
      run({ kind: 'pin', count: 1, diameter: 16, depth: 3, clearance: 0.2, maleSide: 'A' }),
    ).rejects.toThrow(/edge margin|does not fit/);
    await expect(
      run({
        kind: 'dovetail',
        width: 17,
        depth: 3,
        length: 17,
        clearance: 0.2,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
    ).rejects.toThrow(/edge margin|does not fit/);
  });
  it('7B-S02/S05 closes the oblique, near-end, vertex, edge and thin-side plane matrix', async () => {
    await expect(splitAt(cube(), [0, 0, 0], [1, 1, 0])).resolves.toMatchObject({
      connector: { kind: 'none' },
    });
    await expect(splitAt(cube(), [9, 0, 0], [1, 0, 0])).resolves.toMatchObject({
      connector: { kind: 'none' },
    });
    await expect(splitAt(cube(), [10, 10, 10], [1, 1, 1])).rejects.toThrow(
      /does not pass through enough/,
    );
    await expect(splitAt(cube(), [10, 10, 0], [1, 1, 0])).rejects.toThrow(
      /does not pass through enough/,
    );
    await expect(splitAt(cube(), [9.99999, 0, 0], [1, 0, 0])).rejects.toThrow(
      /does not pass through enough/,
    );
  });
  it('7B-SH01 closes cylinder, sphere-like torus, concave, and disconnected-shell shapes', async () => {
    await expect(splitAt(cylinderMesh(), [0, 0, 0], [0, 0, 1])).resolves.toBeDefined();
    await expect(splitAt(torus(), [0, 0, 0], [0, 0, 1])).resolves.toBeDefined();
    await expect(splitAt(concavePrism(), [0, 0, 0], [0, 0, 1])).resolves.toBeDefined();
    await expect(
      splitAt(combine(translatedCube(0, -12, 0), translatedCube(0, 12, 0)), [0, 0, 0], [1, 0, 0]),
    ).resolves.toBeDefined();
  });
});
