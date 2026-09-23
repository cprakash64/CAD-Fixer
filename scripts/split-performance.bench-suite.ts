import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CancellationSource } from '@cadfixer/shared';
import {
  splitWithConnectors,
  type BooleanBackend,
  type BooleanKind,
  type SplitConnector,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../apps/web/src/workers/manifold-boolean-backend';

function sphere(segments: number, rings: number, radius = 20): CanonicalMesh {
  const vertexTotal = 2 + (rings - 1) * segments,
    triangleTotal = segments * 2 + (rings - 2) * segments * 2,
    positions = createPositionArray(vertexTotal * 3),
    indices = createIndexArray(triangleTotal * 3);
  positions.set([0, 0, radius], 0);
  let p = 3;
  for (let ring = 1; ring < rings; ring++) {
    const phi = (ring / rings) * Math.PI,
      z = Math.cos(phi) * radius,
      rr = Math.sin(phi) * radius;
    for (let segment = 0; segment < segments; segment++) {
      const theta = (segment / segments) * Math.PI * 2;
      positions.set([Math.cos(theta) * rr, Math.sin(theta) * rr, z], p);
      p += 3;
    }
  }
  const south = vertexTotal - 1;
  positions.set([0, 0, -radius], south * 3);
  let at = 0;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.set([0, 1 + segment, 1 + next], at);
    at += 3;
  }
  for (let ring = 0; ring < rings - 2; ring++) {
    const row = 1 + ring * segments,
      nextRow = row + segments;
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      indices.set([row + segment, nextRow + segment, row + next], at);
      at += 3;
      indices.set([row + next, nextRow + segment, nextRow + next], at);
      at += 3;
    }
  }
  const last = 1 + (rings - 2) * segments;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.set([last + segment, south, last + next], at);
    at += 3;
  }
  return { positions, indices, metadata: {} };
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

describe('Stage 7B Split performance qualification', () => {
  it('records three runs at approximately 10k, 100k, and 500k triangles', async () => {
    const wasm = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm'),
      base = await createManifoldBooleanBackend(wasm),
      rows = [
        { label: '10k', mesh: sphere(72, 72) },
        { label: '100k', mesh: sphere(224, 224) },
        { label: '500k', mesh: sphere(500, 500) },
      ],
      connectors: readonly { label: string; value: SplitConnector }[] = [
        { label: 'none', value: { kind: 'none' } },
        {
          label: 'pin',
          value: { kind: 'pin', count: 1, diameter: 2, depth: 3, clearance: 0.2, maleSide: 'A' },
        },
        {
          label: 'dovetail',
          value: {
            kind: 'dovetail',
            width: 4,
            length: 6,
            depth: 3,
            clearance: 0.2,
            maleSide: 'A',
            orientationDegrees: 0,
          },
        },
      ];
    for (const row of rows) {
      for (const connector of connectors) {
        if (row.label === '500k' && connector.label === 'dovetail') continue;
        const totals: number[] = [],
          booleanTotals: number[] = [];
        for (let run = 0; run < 3; run++) {
          let booleanMs = 0;
          const measured: BooleanBackend = {
            operate: async (kind: BooleanKind, a, b, cancellation) => {
              const started = performance.now(),
                result = await base.operate(kind, a, b, cancellation);
              booleanMs += performance.now() - started;
              return result;
            },
          };
          const started = performance.now();
          await splitWithConnectors(
            measured,
            row.mesh,
            { plane: { origin: [0, 0, 0], normal: [0, 0, 1] }, connector: connector.value },
            new CancellationSource().token,
          );
          totals.push(performance.now() - started);
          booleanTotals.push(booleanMs);
        }
        const summary = (values: readonly number[]): string =>
          `${Math.min(...values).toFixed(0)}/${median(values).toFixed(0)}/${Math.max(...values).toFixed(0)}`;
        console.warn(
          `[split] ${row.label} ${String(row.mesh.indices.length / 3)} tri ${connector.label}: ` +
            `boolean min/median/max ${summary(booleanTotals)}ms; total ${summary(totals)}ms; ` +
            `validation+placement ${summary(totals.map((value, index) => value - (booleanTotals[index] ?? 0)))}ms`,
        );
        expect(totals.every(Number.isFinite)).toBe(true);
      }
    }
  });
});
