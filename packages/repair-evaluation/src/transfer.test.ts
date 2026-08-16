import { describe, expect, it } from 'vitest';
import { summariseReport } from './contract';
import { CORPUS } from './corpus';
import { diagnose } from './harness';
import { fromTransfer, toTransfer } from './transfer';

/**
 * REGRESSION TESTS FOR THE HARNESS BUG THAT FABRICATED STAGE 3A-2 EVIDENCE.
 *
 * The first transfer representation de-indexed every triangle, which destroyed
 * all adjacency. The candidates then answered a question nobody asked: PMP
 * "accepted" the non-manifold fixtures because a pile of disconnected triangles
 * is trivially manifold, and Manifold rejected nearly everything for the same
 * reason in reverse.
 *
 * A bug that makes results LOOK plausible is the dangerous kind, so the
 * property is now asserted directly rather than trusted: whatever crosses to a
 * candidate must carry the same topology CAD Fixer sees.
 */
describe('candidate transfer preserves recovered topology', () => {
  it('keeps every corpus fixture topologically identical across the boundary', () => {
    for (const fixture of CORPUS) {
      const source = fixture.build();
      const before = summariseReport(diagnose(source));

      const transfer = toTransfer(source);
      const roundTripped = fromTransfer(transfer.positions, transfer.triangles);
      const after = summariseReport(diagnose(roundTripped));

      // The whole Stage 2 summary, not a chosen subset: picking fields is how a
      // check like this passes while the interesting property breaks.
      expect(after, `fixture ${fixture.id} changed across transfer`).toEqual(before);
    }
  });

  it('shares vertices rather than emitting soup', () => {
    // A cube has 8 distinct corners and 36 triangle corners. De-indexed soup
    // would report 36 positions, which is precisely the defect.
    const cube = CORPUS.find((fixture) => fixture.id === 'R02');
    expect(cube).toBeDefined();
    if (cube === undefined) return;

    const transfer = toTransfer(cube.build());
    expect(transfer.positions.length / 3).toBe(8);
    expect(transfer.triangles.length).toBe(36);
  });

  it('preserves component count for disjoint and touching fixtures', () => {
    for (const id of ['R12', 'R13', 'R14', 'R15', 'R16', 'R21']) {
      const fixture = CORPUS.find((entry) => entry.id === id);
      expect(fixture, `missing fixture ${id}`).toBeDefined();
      if (fixture === undefined) continue;

      const source = fixture.build();
      const before = diagnose(source);
      const transfer = toTransfer(source);
      const after = diagnose(fromTransfer(transfer.positions, transfer.triangles));
      expect(after.componentCount, `fixture ${id} component count`).toBe(before.componentCount);
    }
  });

  it('keeps the bow-tie a vertex defect, not an edge defect', () => {
    // R12 is the case the de-indexed representation destroyed most completely.
    const bowTie = CORPUS.find((fixture) => fixture.id === 'R12');
    expect(bowTie).toBeDefined();
    if (bowTie === undefined) return;

    const transfer = toTransfer(bowTie.build());
    const report = diagnose(fromTransfer(transfer.positions, transfer.triangles));
    expect(report.nonManifoldVertexCount).toBe(1);
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.isEdgeManifold).toBe(true);
    expect(report.isVertexManifold).toBe(false);
  });

  it('does not weld the deliberately-close sheets in R21', () => {
    const control = CORPUS.find((fixture) => fixture.id === 'R21');
    expect(control).toBeDefined();
    if (control === undefined) return;

    const source = control.build();
    const transfer = toTransfer(source);
    // Exact identity only: the sheets are 5e-4 apart and must stay two
    // components. A tolerance creeping into transfer would silently pre-repair
    // the fixture before any candidate saw it.
    expect(diagnose(fromTransfer(transfer.positions, transfer.triangles)).componentCount).toBe(2);
  });
});
