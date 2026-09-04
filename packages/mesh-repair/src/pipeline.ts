import { computeBounds, triangleCount, validateMeshStructure } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from '@cadfixer/mesh-topology';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import type { CancellationToken } from '@cadfixer/shared';
import {
  BoundsComparison,
  DEFAULT_CHANGE_SAMPLE_LIMIT,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairRegression,
  REPAIR_VALIDATION_VERSION,
  VolumeComparison,
  type ConservativeRepairPlan,
  type RepairChangeCounts,
  type RepairChangeSamples,
  type RepairValidation,
} from './contract';
import { CANCEL_POLL_MASK, RepairCancelled } from './cancellation';
import { buildInversePatch, type RepairInversePatch } from './inverse';
import { WindingOutcome } from './operations';
import { predictAfterRemoval } from './predict';
import { prepareConservativeRepair, type PreparedRepair } from './prepare';
import { rebuildCandidate } from './rebuild';
import { buildRepairView, type RepairView } from './view';

/**
 * Runs the planned operations against a CANDIDATE and validates the result.
 *
 * THE AUTHORITATIVE MESH IS NEVER TOUCHED. Every stage reads the source and
 * writes masks; one compaction at the end produces the candidate. There is no
 * point at which partially repaired geometry is authoritative, because the
 * authoritative mesh is never written at all — commit replaces a reference.
 *
 * STAGED ATTRIBUTION. Each removal stage is validated on its own before the
 * next runs, so a failure names the operation that caused it instead of
 * reporting that "repair failed". A stage that violates its conservative
 * invariants stops the pipeline; it does NOT trigger a second repair to make
 * the first one's damage go away.
 */

export interface RepairExecutionInput {
  readonly source: CanonicalMesh;
  readonly plan: ConservativeRepairPlan;
  readonly sourceReport: TopologyReport;
  readonly cancellation: CancellationToken;
  readonly documentId: string;
  /** The part being repaired. Carried into the candidate's topology report. */
  readonly partId: string;
  readonly revision: number;
  /** Reused from planning so connectivity is not rebuilt. */
  readonly view?: RepairView;
  /** Shared analysis from planning. Recomputed only if absent. */
  readonly prepared?: PreparedRepair;
  readonly sampleLimit?: number;
  onProgress?: (fraction: number, note?: string) => void;
}

export interface RepairExecutionResult {
  readonly candidate: CanonicalMesh | undefined;
  readonly validation: RepairValidation;
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  readonly inverse: RepairInversePatch | undefined;
  readonly candidateToSourceFace: Uint32Array | undefined;
}

export function executeConservativeRepair(input: RepairExecutionInput): RepairExecutionResult {
  const { source, plan, sourceReport, cancellation } = input;
  const sampleLimit = input.sampleLimit ?? DEFAULT_CHANGE_SAMPLE_LIMIT;
  const view = input.view ?? buildRepairView(source, { cancellation });
  const faceCount = view.faceCount;

  const applicable = (operation: RepairOperation): boolean =>
    plan.decisions.some(
      (entry) => entry.operation === operation && entry.decision === RepairDecision.Applicable,
    );

  const throwIfCancelled = (): void => {
    if (cancellation.isCancelled) throw new RepairCancelled();
  };

  /*
   * NO-OP SHORT CIRCUIT. When the plan permits nothing, no candidate is
   * allocated at all — not an empty one, and not a copy. There is then nothing
   * committable, which is the correct outcome: committing a byte-identical
   * "repair" would burn a revision and an undo step for no change.
   */
  if (plan.order.length === 0) {
    return noOp(input, sourceReport, sampleLimit);
  }

  /* ------------------------------- removals and winding, computed once -- */

  const prepared =
    input.prepared ??
    prepareConservativeRepair(source, sourceReport, plan.requested, view, cancellation);

  const cumulative = new Uint8Array(faceCount);
  const perOperation = new Map<RepairOperation, Uint8Array>();
  for (const stage of prepared.stages) {
    throwIfCancelled();
    if (!stage.safe) {
      // The plan should already have refused this; if it did not, stop here
      // rather than build a candidate whose safety was never established.
      return refused(input, sourceReport, stage.operation, sampleLimit, stage);
    }
    if (!applicable(stage.operation)) continue;
    perOperation.set(stage.operation, stage.mask);
    // The removal mask union. One pass per applicable stage, so on a large model
    // with several stages this is several times the face count — polled rather
    // than trusted to be quick.
    for (let face = 0; face < faceCount; face += 1) {
      if ((face & CANCEL_POLL_MASK) === 0) throwIfCancelled();
      if (stage.mask[face] === 1) cumulative[face] = 1;
    }
  }
  input.onProgress?.(0.25, 'selecting faces');

  let flipMask: Uint8Array | undefined;
  let flipCount = 0;
  if (applicable(RepairOperation.UnifyWinding)) {
    throwIfCancelled();
    const solution = prepared.winding;
    if (solution?.outcome !== WindingOutcome.Solved) {
      return blocked(input, sourceReport, RepairOperation.UnifyWinding, sampleLimit);
    }
    flipMask = prepared.sourceFlipMask;
    flipCount = prepared.flipCount;
  }
  input.onProgress?.(0.45, 'solving winding');

  /* ------------------------------------------------------- compact + check -- */

  throwIfCancelled();
  const rebuilt = rebuildCandidate(source, faceCount, cumulative, flipMask, {
    onBatch: () => {
      throwIfCancelled();
    },
  });
  input.onProgress?.(0.7, 'building candidate');

  throwIfCancelled();
  const structural = validateMeshStructure(rebuilt.mesh);

  /*
   * ANNOUNCED BEFORE IT RUNS, not after it finishes.
   *
   * Re-analysing the candidate is the single longest span in a repair, and it
   * used to be reported only once it was already over — so the interface spent
   * that whole span claiming it was still "building candidate". A progress label
   * that describes the previous phase is a small dishonesty with a practical
   * cost: it is also the phase a user is most likely to cancel during, and
   * neither they nor a test could tell they were in it.
   */
  input.onProgress?.(0.75, 'validating candidate');
  const after = analyseTopology(rebuilt.mesh, {
    documentId: input.documentId,
    documentRevision: input.revision,
    partId: input.partId,
    cancellation,
    sampleLimit: 4096,
    // Forwarded so the longest span of a repair advances a progress bar instead
    // of appearing to hang, and so a cancel during it is attributable to THIS
    // phase rather than to the pipeline in general.
    onProgress: ({ fraction }) => {
      input.onProgress?.(0.75 + fraction * 0.2, 'validating candidate');
    },
  }).report;
  input.onProgress?.(0.95, 'judging candidate');

  const validation = validate(
    plan,
    sourceReport,
    after,
    structural.valid,
    source,
    rebuilt.mesh,
    cumulative,
    perOperation,
    flipCount,
    fullyRemovedComponents(view, cumulative),
    predictAfterRemoval(view, cumulative),
  );

  const counts: RepairChangeCounts = {
    removedDuplicateFaces: countMask(perOperation.get(RepairOperation.RemoveDuplicateFaces)),
    removedRepeatedPositionFaces: countMask(
      perOperation.get(RepairOperation.RemoveRepeatedPositionFaces),
    ),
    removedZeroAreaFaces: countMask(perOperation.get(RepairOperation.RemoveZeroAreaFaces)),
    flippedFaces: flipCount,
    sourceFaceCount: faceCount,
    candidateFaceCount: triangleCount(rebuilt.mesh),
  };

  const samples = buildSamples(perOperation, rebuilt.flippedSourceFaces, sampleLimit);

  if (validation.acceptance !== RepairAcceptance.Accepted) {
    // A rejected candidate produces no geometry and no inverse patch. Returning
    // the mesh anyway would leave something committable lying around.
    return {
      candidate: undefined,
      validation,
      counts,
      samples,
      inverse: undefined,
      candidateToSourceFace: undefined,
    };
  }

  return {
    candidate: rebuilt.mesh,
    validation,
    counts,
    samples,
    inverse: buildInversePatch(source, rebuilt.removedSourceFaces, rebuilt.flippedSourceFaces),
    candidateToSourceFace: rebuilt.candidateToSourceFace,
  };
}

/*
 * `RepairCancelled` now lives in `./cancellation` and is re-exported here.
 *
 * IT MUST BE ONE CLASS. The worker handler converts it with `instanceof`, and
 * two identically-shaped classes would make that check silently false for
 * anything thrown by the selection loops — cancellation would surface as an
 * internal failure instead of a cancellation.
 */

/**
 * Components whose every face was removed.
 *
 * Component count MAY legitimately fall: deleting an isolated zero-area sliver
 * that formed its own component removes that component, and rejecting the
 * repair for it would refuse a correct result. What must never happen is a
 * component appearing — that means the surface was torn — or disappearing
 * without every one of its faces having been deleted.
 */
function fullyRemovedComponents(view: RepairView, removed: Uint8Array): number {
  const total = new Map<number, number>();
  const deleted = new Map<number, number>();
  for (let face = 0; face < view.faceCount; face += 1) {
    const component = view.components.faceComponent[face] ?? 0;
    total.set(component, (total.get(component) ?? 0) + 1);
    if (removed[face] === 1) deleted.set(component, (deleted.get(component) ?? 0) + 1);
  }
  let gone = 0;
  for (const [component, count] of total) {
    if ((deleted.get(component) ?? 0) === count) gone += 1;
  }
  return gone;
}

function refused(
  input: RepairExecutionInput,
  before: TopologyReport,
  operation: RepairOperation,
  sampleLimit: number,
  safety: { boundaryDelta: number; nonManifoldDelta: number },
): RepairExecutionResult {
  const base = noOp(input, before, sampleLimit);
  return {
    ...base,
    validation: {
      ...base.validation,
      acceptance: RepairAcceptance.RejectedRegression,
      failedOperation: operation,
      regressions: [
        ...(safety.boundaryDelta > 0 ? [RepairRegression.BoundaryEdgesIncreased] : []),
        ...(safety.nonManifoldDelta > 0 ? [RepairRegression.NonManifoldEdgesIncreased] : []),
      ],
      warnings: [
        `Removing these faces would change connectivity (boundary ${safety.boundaryDelta >= 0 ? '+' : ''}${String(safety.boundaryDelta)}, non-manifold ${safety.nonManifoldDelta >= 0 ? '+' : ''}${String(safety.nonManifoldDelta)}). The operation was refused.`,
      ],
    },
  };
}

function noOp(
  input: RepairExecutionInput,
  before: TopologyReport,
  sampleLimit: number,
): RepairExecutionResult {
  const faces = triangleCount(input.source);
  return {
    candidate: undefined,
    validation: {
      schemaVersion: REPAIR_VALIDATION_VERSION,
      acceptance: RepairAcceptance.NoOp,
      requested: input.plan.requested,
      applied: [],
      before,
      after: before,
      deltas: zeroDeltas(),
      structurallyValid: true,
      surfaceAreaBefore: before.totalSurfaceArea,
      surfaceAreaAfter: before.totalSurfaceArea,
      volumeComparison: VolumeComparison.Unchanged,
      signedVolumeBefore: before.totalSignedVolume,
      signedVolumeAfter: before.totalSignedVolume,
      boundsComparison: BoundsComparison.Identical,
      boundsBefore: computeBounds(input.source),
      boundsAfter: computeBounds(input.source),
      regressions: [],
      warnings: [],
      selfIntersectionStatus: 'not-checked',
      planHash: input.plan.planHash,
    },
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: faces,
      candidateFaceCount: faces,
    },
    samples: {
      removedDuplicateFaces: new Uint32Array(0),
      removedRepeatedPositionFaces: new Uint32Array(0),
      removedZeroAreaFaces: new Uint32Array(0),
      flippedFaces: new Uint32Array(0),
      truncated: false,
      sampleLimit,
    },
    inverse: undefined,
    candidateToSourceFace: undefined,
  };
}

function countMask(mask: Uint8Array | undefined): number {
  if (mask === undefined) return 0;
  let total = 0;
  for (const value of mask) total += value;
  return total;
}

function blocked(
  input: RepairExecutionInput,
  before: TopologyReport,
  operation: RepairOperation,
  sampleLimit: number,
): RepairExecutionResult {
  return {
    candidate: undefined,
    validation: {
      schemaVersion: REPAIR_VALIDATION_VERSION,
      acceptance: RepairAcceptance.BlockedPrecondition,
      failedOperation: operation,
      requested: input.plan.requested,
      applied: [],
      before,
      after: before,
      deltas: zeroDeltas(),
      structurallyValid: true,
      surfaceAreaBefore: before.totalSurfaceArea,
      surfaceAreaAfter: before.totalSurfaceArea,
      volumeComparison: VolumeComparison.Unchanged,
      signedVolumeBefore: before.totalSignedVolume,
      signedVolumeAfter: before.totalSignedVolume,
      boundsComparison: BoundsComparison.Identical,
      boundsBefore: computeBounds(input.source),
      boundsAfter: computeBounds(input.source),
      regressions: [],
      warnings: ['A precondition failed after earlier stages; no candidate was produced.'],
      selfIntersectionStatus: 'not-checked',
      planHash: input.plan.planHash,
    },
    counts: {
      removedDuplicateFaces: 0,
      removedRepeatedPositionFaces: 0,
      removedZeroAreaFaces: 0,
      flippedFaces: 0,
      sourceFaceCount: triangleCount(input.source),
      candidateFaceCount: triangleCount(input.source),
    },
    samples: {
      removedDuplicateFaces: new Uint32Array(0),
      removedRepeatedPositionFaces: new Uint32Array(0),
      removedZeroAreaFaces: new Uint32Array(0),
      flippedFaces: new Uint32Array(0),
      truncated: false,
      sampleLimit,
    },
    inverse: undefined,
    candidateToSourceFace: undefined,
  };
}

function zeroDeltas(): RepairValidation['deltas'] {
  return {
    triangles: 0,
    topologicalVertices: 0,
    components: 0,
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    nonManifoldVertices: 0,
    windingConflicts: 0,
    sameOrientationDuplicates: 0,
    reversedOrientationDuplicates: 0,
    repeatedPositionFaces: 0,
    zeroAreaFaces: 0,
  };
}

/**
 * The independent verdict.
 *
 * Every check compares CAD Fixer's own analysis of the candidate against its
 * own analysis of the source. The repair code contributes the requested
 * operation list and nothing else — it has no way to declare itself successful.
 */
function validate(
  plan: ConservativeRepairPlan,
  before: TopologyReport,
  after: TopologyReport,
  structurallyValid: boolean,
  source: CanonicalMesh,
  candidate: CanonicalMesh,
  removed: Uint8Array,
  perOperation: Map<RepairOperation, Uint8Array>,
  flipCount: number,
  expectedComponentLoss: number,
  predicted: {
    boundaryEdgeCount: number;
    nonManifoldEdgeCount: number;
    windingConflictCount: number;
    removedArea: number;
  },
): RepairValidation {
  const regressions: RepairRegression[] = [];
  const warnings: string[] = [];

  const deltas: RepairValidation['deltas'] = {
    triangles: after.sourceFaceCount - before.sourceFaceCount,
    topologicalVertices: after.topologicalVertexCount - before.topologicalVertexCount,
    components: after.componentCount - before.componentCount,
    boundaryEdges: after.boundaryEdgeCount - before.boundaryEdgeCount,
    nonManifoldEdges: after.nonManifoldEdgeCount - before.nonManifoldEdgeCount,
    nonManifoldVertices: after.nonManifoldVertexCount - before.nonManifoldVertexCount,
    windingConflicts: after.windingConflictEdgeCount - before.windingConflictEdgeCount,
    sameOrientationDuplicates:
      after.sameOrientationDuplicateCount - before.sameOrientationDuplicateCount,
    reversedOrientationDuplicates:
      after.reversedOrientationDuplicateCount - before.reversedOrientationDuplicateCount,
    repeatedPositionFaces: after.repeatedPositionFaceCount - before.repeatedPositionFaceCount,
    zeroAreaFaces: after.zeroAreaFaceCount - before.zeroAreaFaceCount,
  };

  if (!structurallyValid) regressions.push(RepairRegression.StructurallyInvalid);
  for (const value of candidate.positions) {
    if (!Number.isFinite(value)) {
      regressions.push(RepairRegression.NonFiniteCoordinate);
      break;
    }
  }

  /*
   * PREDICTED, NOT "MUST NOT INCREASE". The source topology plus the removal
   * mask says exactly what the boundary and non-manifold counts should become;
   * the candidate is re-analysed independently and must match. A mismatch means
   * the rebuild produced something the removal does not explain.
   */
  if (after.boundaryEdgeCount !== predicted.boundaryEdgeCount) {
    regressions.push(RepairRegression.BoundaryEdgesIncreased);
  }
  if (after.nonManifoldEdgeCount !== predicted.nonManifoldEdgeCount) {
    regressions.push(RepairRegression.NonManifoldEdgesIncreased);
  }
  if (deltas.nonManifoldVertices > 0) {
    regressions.push(RepairRegression.NonManifoldVerticesIncreased);
  }
  /*
   * When winding unification RAN, the answer must be zero conflicts. When it did
   * not, the conflict count must match what removal predicts — duplicate
   * removal can expose a conflict that a non-manifold edge was masking, and
   * that is explained change, not damage.
   */
  const windingRan = plan.order.includes(RepairOperation.UnifyWinding);
  if (windingRan) {
    if (after.windingConflictEdgeCount !== 0) {
      regressions.push(RepairRegression.WindingConflictsIncreased);
    }
  } else if (after.windingConflictEdgeCount !== predicted.windingConflictCount) {
    regressions.push(RepairRegression.WindingConflictsIncreased);
  }
  if (deltas.reversedOrientationDuplicates !== 0) {
    // Reversed duplicates are NEVER touched by this stage. Any change means an
    // operation reached geometry it was not permitted to reach.
    regressions.push(RepairRegression.ReversedDuplicatesChanged);
  }
  // A component may only disappear when every one of its faces was removed.
  // Any other change — especially an INCREASE, which means the surface was torn
  // apart — is a regression.
  if (deltas.components !== -expectedComponentLoss) {
    regressions.push(RepairRegression.ComponentCountChanged);
  }

  const applied: RepairOperation[] = [];
  for (const operation of plan.order) {
    applied.push(operation);
    if (
      operation === RepairOperation.RemoveDuplicateFaces &&
      deltas.sameOrientationDuplicates > 0
    ) {
      regressions.push(RepairRegression.TargetDefectNotRemoved);
    }
    if (
      operation === RepairOperation.RemoveRepeatedPositionFaces &&
      deltas.repeatedPositionFaces > 0
    ) {
      regressions.push(RepairRegression.TargetDefectNotRemoved);
    }
    if (operation === RepairOperation.RemoveZeroAreaFaces && deltas.zeroAreaFaces > 0) {
      regressions.push(RepairRegression.TargetDefectNotRemoved);
    }
    if (operation === RepairOperation.UnifyWinding && after.windingConflictEdgeCount !== 0) {
      regressions.push(RepairRegression.TargetDefectNotRemoved);
    }
  }

  let expectedRemoved = 0;
  for (const value of removed) expectedRemoved += value;
  if (before.sourceFaceCount - after.sourceFaceCount !== expectedRemoved) {
    regressions.push(RepairRegression.UnexpectedFaceCountChange);
  }

  /*
   * SURFACE AREA, against the PREDICTED total rather than the original.
   *
   * Stage 2 sums every face, so a duplicated triangle contributes its area
   * twice and removing the copy legitimately reduces the total — Stage 3A-1's
   * R03 criterion says exactly this. Degenerate faces contribute zero, so
   * removing them must not move it, and a flip never changes a triangle's area.
   * The expected total is therefore `before - removedArea`, computed from the
   * source.
   *
   * Compared relatively, not bit-exactly: summation ORDER changes when faces are
   * removed and float addition is not associative, so demanding bit-equality
   * would fail a correct repair.
   */
  const expectedArea = before.totalSurfaceArea - predicted.removedArea;
  const areaScale = Math.max(1, Math.abs(before.totalSurfaceArea));
  if (Math.abs(after.totalSurfaceArea - expectedArea) > areaScale * 1e-9) {
    regressions.push(RepairRegression.SurfaceAreaChanged);
  }

  /*
   * VOLUME is recorded, never used as the acceptance oracle. Winding
   * unification changes algebraic signed volume BY DESIGN, because it changes
   * orientation — and this stage makes no claim about which orientation is
   * physically outward.
   */
  const volumeChanged =
    Math.abs(after.totalSignedVolume - before.totalSignedVolume) >
    Math.max(1, Math.abs(before.totalSignedVolume)) * 1e-9;
  let volumeComparison: VolumeComparison;
  if (!volumeChanged) volumeComparison = VolumeComparison.Unchanged;
  else if (flipCount > 0) volumeComparison = VolumeComparison.ChangedByOrientation;
  else volumeComparison = VolumeComparison.ChangedUnexpectedly;
  if (volumeComparison === VolumeComparison.ChangedUnexpectedly) {
    warnings.push('Signed volume changed although no face was flipped.');
  }

  const boundsBefore = computeBounds(source);
  const boundsAfter = computeBounds(candidate);
  const boundsComparison = compareBounds(boundsBefore, boundsAfter, expectedRemoved > 0);
  if (boundsComparison === BoundsComparison.ChangedExplainedByRemovedFaces) {
    warnings.push(
      'The bounding box changed. Removed zero-area or duplicate faces defined an extreme coordinate.',
    );
  }
  if (boundsComparison === BoundsComparison.ChangedUnexplained) {
    warnings.push('The bounding box changed and removed faces do not explain it.');
  }

  void perOperation;

  const acceptance =
    regressions.length > 0 ? RepairAcceptance.RejectedRegression : RepairAcceptance.Accepted;

  return {
    schemaVersion: REPAIR_VALIDATION_VERSION,
    acceptance,
    requested: plan.requested,
    applied,
    before,
    after,
    deltas,
    structurallyValid,
    surfaceAreaBefore: before.totalSurfaceArea,
    surfaceAreaAfter: after.totalSurfaceArea,
    volumeComparison,
    signedVolumeBefore: before.totalSignedVolume,
    signedVolumeAfter: after.totalSignedVolume,
    boundsComparison,
    boundsBefore,
    boundsAfter,
    regressions,
    warnings,
    selfIntersectionStatus: 'not-checked',
    planHash: plan.planHash,
  };
}

/**
 * Bounding-box comparison, WITHOUT making equality a hard gate.
 *
 * A zero-area sliver can legitimately define an extreme coordinate, and
 * removing it legitimately shrinks the box. Refusing that would reject a
 * correct repair, so a change accompanied by removals is attributed and warned
 * about rather than treated as damage. A change with NO removals is
 * unexplained, and says so.
 */
function compareBounds(
  before: ReturnType<typeof computeBounds>,
  after: ReturnType<typeof computeBounds>,
  hadRemovals: boolean,
): BoundsComparison {
  if (before === undefined || after === undefined) return BoundsComparison.NotComparable;
  const same =
    before.min[0] === after.min[0] &&
    before.min[1] === after.min[1] &&
    before.min[2] === after.min[2] &&
    before.max[0] === after.max[0] &&
    before.max[1] === after.max[1] &&
    before.max[2] === after.max[2];
  if (same) return BoundsComparison.Identical;
  return hadRemovals
    ? BoundsComparison.ChangedExplainedByRemovedFaces
    : BoundsComparison.ChangedUnexplained;
}

function buildSamples(
  perOperation: Map<RepairOperation, Uint8Array>,
  flipped: Uint32Array,
  sampleLimit: number,
): RepairChangeSamples {
  let truncated = false;
  const sampleOf = (mask: Uint8Array | undefined): Uint32Array => {
    if (mask === undefined) return new Uint32Array(0);
    const out: number[] = [];
    for (const [face, value] of mask.entries()) {
      if (value !== 1) continue;
      if (out.length >= sampleLimit) {
        truncated = true;
        break;
      }
      out.push(face);
    }
    return Uint32Array.from(out);
  };

  const flippedSample = flipped.length > sampleLimit ? flipped.slice(0, sampleLimit) : flipped;
  if (flipped.length > sampleLimit) truncated = true;

  return {
    removedDuplicateFaces: sampleOf(perOperation.get(RepairOperation.RemoveDuplicateFaces)),
    removedRepeatedPositionFaces: sampleOf(
      perOperation.get(RepairOperation.RemoveRepeatedPositionFaces),
    ),
    removedZeroAreaFaces: sampleOf(perOperation.get(RepairOperation.RemoveZeroAreaFaces)),
    flippedFaces: flippedSample,
    truncated,
    sampleLimit,
  };
}

export { RepairCancelled } from './cancellation';
