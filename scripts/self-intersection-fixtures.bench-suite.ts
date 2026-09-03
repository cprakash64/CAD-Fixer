import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureById } from '@cadfixer/repair-evaluation';
import { recoverVertexIdentity } from '@cadfixer/mesh-topology';
import { triangleCount } from '@cadfixer/mesh-core';

/**
 * Stage 3C-1A-R1 — exports the Stage 3A R16/R17/R18 fixtures for the
 * self-intersection harness. RESEARCH ONLY.
 *
 * WHY THIS EXISTS AND WHY IT LIVES IN scripts/. The Stage 3C-1A report claimed
 * these three were unreachable because they lived in a generated tree. That was
 * WRONG: they are built by `@cadfixer/repair-evaluation`, a tracked
 * research package, and are reproducible from source at any time. This suite
 * regenerates them rather than inventing substitutes.
 *
 * It also performs the conversion the diagnostic requires. The corpus emits a
 * triangle SOUP — every corner its own vertex — while the diagnostic reasons
 * about TOPOLOGICAL vertices, because distinguishing a legitimate shared edge
 * from an overlap is only possible once shared vertices are actually shared.
 * That recovery uses Stage 2's exact stored-coordinate identity, the same
 * function the product uses, so no second merging rule is introduced here.
 */

const IDS = ['R16', 'R17', 'R18'] as const;

interface ExportedFixture {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly intentionalDefects: readonly string[];
  readonly soupFaceCount: number;
  readonly topologicalVertexCount: number;
  readonly positions: number[];
  readonly triangles: number[];
  readonly sha256: string;
}

describe('Stage 3C-1A-R1 fixture export', () => {
  it('regenerates R16, R17 and R18 in topological-vertex form', () => {
    const exported: ExportedFixture[] = [];

    for (const id of IDS) {
      // `fixtureById` is typed as total over the corpus ids, so no presence
      // guard is possible here; a missing id would be a compile error.
      const fixture = fixtureById(id);

      const mesh = fixture.build();
      const identity = recoverVertexIdentity(mesh);

      // One position per TOPOLOGICAL vertex, read back through the
      // representative corner so the stored coordinate is preserved exactly.
      const positions: number[] = [];
      for (let v = 0; v < identity.vertexCount; v += 1) {
        const corner = identity.vertexRepresentativeCorner[v] ?? 0;
        positions.push(
          mesh.positions[corner * 3] ?? 0,
          mesh.positions[corner * 3 + 1] ?? 0,
          mesh.positions[corner * 3 + 2] ?? 0,
        );
      }

      const triangles: number[] = [];
      for (const corner of mesh.indices) {
        triangles.push(identity.cornerToVertex[corner] ?? 0);
      }

      const hash = createHash('sha256');
      hash.update(new Uint8Array(Float64Array.from(positions).buffer));
      hash.update(new Uint8Array(Uint32Array.from(triangles).buffer));

      exported.push({
        id: fixture.id,
        title: fixture.title,
        description: fixture.description,
        intentionalDefects: fixture.intentionalDefects,
        soupFaceCount: triangleCount(mesh),
        topologicalVertexCount: identity.vertexCount,
        positions,
        triangles,
        sha256: hash.digest('hex'),
      });
    }

    expect(exported).toHaveLength(3);

    const target = new URL(
      '../experiments/self-intersection/generated-fixtures.json',
      import.meta.url,
    );
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          note: 'Stage 3A R16/R17/R18 regenerated for the Stage 3C self-intersection harness. RESEARCH ONLY. Regenerate with: npx vitest run --config vitest.bench.config.ts scripts/self-intersection-fixtures.bench-suite.ts',
          source: 'packages/repair-evaluation/src/corpus.ts',
          generatedAt: new Date().toISOString(),
          fixtures: exported,
        },
        null,
        1,
      )}\n`,
    );

    for (const f of exported) {
      process.stdout.write(
        `${f.id} "${f.title}" soupFaces=${String(f.soupFaceCount)} topoVerts=${String(f.topologicalVertexCount)} sha256=${f.sha256.slice(0, 16)}…\n`,
      );
    }
  });
});
