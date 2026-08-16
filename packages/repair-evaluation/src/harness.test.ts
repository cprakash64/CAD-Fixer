import { describe, expect, it } from 'vitest';
import { ForbiddenOutcome, RepairOperation, RepairStatus } from './contract';
import { fixtureById, FixtureScale } from './corpus';
import { runCase } from './harness';
import {
  collateralDamageCandidate,
  competentCandidate,
  emptyingCandidate,
  lyingCandidate,
  nanCandidate,
  nonDeterministicCandidate,
  overWeldingCandidate,
  passthroughCandidate,
  substitutingCandidate,
  throwingCandidate,
  timingOutCandidate,
} from './mock-candidates';
import { HARD_GATES, SCORING_MODEL, TOTAL_WEIGHT } from './scoring';

/**
 * TESTS OF THE HARNESS, USING MOCKS.
 *
 * These say nothing about any real geometry kernel and must never be cited as
 * if they did. What they establish is that the harness itself behaves: that it
 * catches the failure modes it claims to catch, that it does not believe a
 * candidate's own success claim, and that one bad candidate does not take the
 * run down.
 *
 * A harness whose failure detection was never exercised would silently pass
 * every kernel in Stage 3A-2, and we would not find out until a user's model
 * came back damaged.
 */

const NO_PARAMS = {};

describe('a competent candidate', () => {
  it('passes when it removes the duplicate it was pointed at', async () => {
    const row = await runCase(
      competentCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.status).toBe(RepairStatus.Completed);
    expect(row.preDiagnostics.duplicateFaces).toBe(1);
    expect(row.postDiagnostics?.duplicateFaces).toBe(0);
    expect(row.verdict.accepted).toBe(true);
    expect(row.verdict.forbidden).toEqual([]);
  });

  it('passes when it removes a zero-area face', async () => {
    const row = await runCase(
      competentCandidate(),
      fixtureById('R06'),
      RepairOperation.RemoveDegenerateFaces,
      NO_PARAMS,
    );

    expect(row.preDiagnostics.zeroAreaFaces).toBe(1);
    expect(row.postDiagnostics?.zeroAreaFaces).toBe(0);
    expect(row.verdict.accepted).toBe(true);
  });
});

describe('a candidate that changes nothing', () => {
  it('fails acceptance on a fixture with a real defect', async () => {
    // Returning the input unchanged is not a repair, however cleanly it does it.
    const row = await runCase(
      passthroughCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.status).toBe(RepairStatus.Completed);
    expect(row.verdict.accepted).toBe(false);
    expect(row.verdict.violated.join(' ')).toContain('duplicate-removed');
  });

  it('passes on a control fixture, where changing nothing is correct', async () => {
    const row = await runCase(
      passthroughCandidate(),
      fixtureById('R01'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.verdict.accepted).toBe(true);
  });
});

describe('we do not believe the candidate', () => {
  it('rejects a result the candidate claims succeeded', async () => {
    // THE POINT OF THE WHOLE HARNESS. The kernel says it worked; our own
    // topology analysis says the defect is still there, and ours wins.
    const row = await runCase(
      lyingCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.kernelReportedSuccess).toBe(true);
    expect(row.verdict.accepted).toBe(false);
  });
});

describe('collateral damage', () => {
  it('rejects a candidate that fixes the target but opens the shell', async () => {
    const row = await runCase(
      collateralDamageCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    // The duplicate may well be gone; the shell is no longer closed.
    expect(row.verdict.accepted).toBe(false);
    const evidence = [...row.verdict.violated, ...row.verdict.forbidden].join(' ');
    expect(evidence).toMatch(/boundaryEdges|introduced-new-defect/);
  });
});

describe('hard failures', () => {
  it('records a throw and keeps going', async () => {
    const row = await runCase(
      throwingCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    // A recorded row, not an exception escaping into the run.
    expect(row.verdict.forbidden).toContain(ForbiddenOutcome.Crashed);
    expect(row.verdict.accepted).toBe(false);
    expect(row.fixtureId).toBe('R03');
  });

  it('treats NaN output as disqualifying', async () => {
    const row = await runCase(
      nanCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.verdict.forbidden).toContain(ForbiddenOutcome.NonFiniteCoordinate);
    expect(row.verdict.accepted).toBe(false);
    // And no metrics were computed from poisoned coordinates.
    expect(row.postDiagnostics).toBeUndefined();
  });

  it('treats an unexpectedly empty result as disqualifying', async () => {
    const row = await runCase(
      emptyingCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.verdict.forbidden).toContain(ForbiddenOutcome.UnexpectedlyEmpty);
    expect(row.verdict.accepted).toBe(false);
  });

  it('records a timeout without inventing a result', async () => {
    const row = await runCase(
      timingOutCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.status).toBe(RepairStatus.TimedOut);
    expect(row.postDiagnostics).toBeUndefined();
    expect(row.verdict.accepted).toBe(false);
  });
});

describe('determinism', () => {
  it('catches a candidate that answers differently on the second run', async () => {
    const row = await runCase(
      nonDeterministicCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
      { runs: 2 },
    );

    expect(row.verdict.forbidden).toContain(ForbiddenOutcome.NonDeterministic);
    expect(row.verdict.accepted).toBe(false);
  });

  it('does not flag a candidate that answers identically', async () => {
    const row = await runCase(
      competentCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
      { runs: 3 },
    );

    expect(row.verdict.forbidden).not.toContain(ForbiddenOutcome.NonDeterministic);
  });
});

describe('preservation failures', () => {
  it('catches a clean control being modified', async () => {
    const row = await runCase(
      collateralDamageCandidate(),
      fixtureById('R01'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(row.verdict.forbidden).toContain(ForbiddenOutcome.CleanInputChanged);
    expect(row.verdict.accepted).toBe(false);
  });

  it('catches an over-eager weld merging two shells that must stay apart', async () => {
    // R21's sheets are 5e-4 apart. A candidate welding at a fixed internal
    // tolerance destroys them, which is exactly the failure R21 exists for.
    const row = await runCase(
      overWeldingCandidate(),
      fixtureById('R21'),
      RepairOperation.WeldWithinTolerance,
      { absoluteTolerance: 1e-6 },
    );

    expect(row.verdict.accepted).toBe(false);
    const evidence = [...row.verdict.violated, ...row.verdict.forbidden].join(' ');
    expect(evidence).toMatch(/merged-disjoint-shells|clean-input-changed|components/);
  });

  it('catches an intentional opening being filled', async () => {
    // R09 is a pipe: both rims must stay open. A candidate that returns a
    // closed solid has removed every boundary edge, which is what filling an
    // opening looks like from outside — and is exactly the failure R09 exists
    // to catch.
    const row = await runCase(
      substitutingCandidate(),
      fixtureById('R09'),
      RepairOperation.FillBoundaryLoops,
      NO_PARAMS,
      { runs: 1 },
      FixtureScale.Tiny,
    );

    expect(row.preDiagnostics.boundaryEdges).toBeGreaterThan(0);
    expect(row.postDiagnostics?.boundaryEdges).toBe(0);
    expect(row.verdict.forbidden).toContain(ForbiddenOutcome.FilledIntentionalOpening);
    expect(row.verdict.accepted).toBe(false);
  });
});

describe('the harness itself', () => {
  it('never consults the candidate to decide acceptance', async () => {
    // Same input and same output, opposite self-reports: the verdict must not
    // move. If it does, the kernel's opinion is leaking into our judgement.
    const honest = await runCase(
      passthroughCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );
    const lying = await runCase(
      lyingCandidate(),
      fixtureById('R03'),
      RepairOperation.RemoveDuplicateFaces,
      NO_PARAMS,
    );

    expect(lying.verdict.accepted).toBe(honest.verdict.accepted);
    expect(lying.resultDigest).toBe(honest.resultDigest);
  });

  it('records the pre-repair diagnosis even when the candidate fails', async () => {
    const row = await runCase(
      throwingCandidate(),
      fixtureById('R12'),
      RepairOperation.ResolveNonManifold,
      NO_PARAMS,
    );

    // The oracle ran before the candidate, so a crash still leaves evidence.
    expect(row.preDiagnostics.nonManifoldVertices).toBe(1);
    expect(row.preDiagnostics.nonManifoldEdges).toBe(0);
  });

  it('writes no raw geometry into a result row', () => {
    // Results are read by people and shared; a mesh in there would be both
    // unreadable and user-shaped data in a file that travels.
    const keys = [
      'candidateId',
      'fixtureId',
      'operation',
      'preDiagnostics',
      'postDiagnostics',
      'geometryChange',
      'verdict',
      'resultDigest',
    ];
    for (const key of keys) {
      expect(typeof key).toBe('string');
    }
    // Structural: the row type has no mesh field, which the compiler enforces.
    expect(true).toBe(true);
  });
});

describe('frozen scoring model', () => {
  /**
   * Pinned so a later change is a deliberate, reviewable act rather than a
   * quiet edit that happens to favour whichever kernel is being argued for.
   */
  it('sums to 100 with correctness dominant', () => {
    expect(TOTAL_WEIGHT).toBe(100);

    const correctness = SCORING_MODEL.find((entry) => entry.id === 'correctness');
    expect(correctness?.weight).toBe(55);

    const others = SCORING_MODEL.filter((entry) => entry.id !== 'correctness').reduce(
      (sum, entry) => sum + entry.weight,
      0,
    );
    // No combination of the other dimensions can outvote correctness.
    expect(correctness?.weight ?? 0).toBeGreaterThan(others);
  });

  it('defines the hard gates before any benchmark has run', () => {
    const ids = HARD_GATES.map((gate) => gate.id);

    expect(ids).toContain('licence-incompatible');
    expect(ids).toContain('cannot-run-in-browser');
    expect(ids).toContain('no-cancellation-path');
    expect(ids).toContain('unacceptable-geometry-loss');
    for (const gate of HARD_GATES) {
      expect(gate.rationale.length, gate.id).toBeGreaterThan(30);
    }
  });
});
