import {
  assertMeshStructure,
  computeBounds,
  triangleCount,
  vertexCount,
} from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import { analyseTopology, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  executeConservativeRepair,
  planConservativeRepair,
  restoreFromInverse,
  RepairAcceptance,
  RepairCancelled,
} from '@cadfixer/mesh-repair';
import {
  meshByteLength,
  requestRepairPeak,
  type ModelHandle,
  type OperationHandler,
  type RenderSnapshot,
} from '@cadfixer/geometry-runtime';
import {
  invalidState,
  isAppError,
  operationCancelled,
  type CancellationToken,
  type resourceLimitExceeded,
} from '@cadfixer/shared';
import {
  buildRenderSnapshot,
  repairCandidates,
  repairHistory,
  residentModels,
  topologyReports,
  yieldToEventLoop,
} from './stl-handlers';

/**
 * WORKER HANDLERS FOR CONSERVATIVE REPAIR.
 *
 * FIVE OPERATIONS, NOT ONE. Planning must be observable without allocating a
 * candidate; applying must be a separate, explicitly confirmed act; and undoing
 * must be its own transaction rather than a view the UI can fake. A single
 * `repair/apply` would make preview impossible and would make an accidental
 * resend destructive.
 *
 * `model/analyze` is untouched. Analysis stays read-only; hiding a repair verb
 * inside it would make every diagnosis a potential mutation.
 *
 * THE AUTHORITATIVE MODEL IS NEVER WRITTEN except by `repair/commit` and
 * `repair/undo`, and only after every guard in `RepairCandidateStore` or
 * `RepairHistoryStore` has passed. A failure at any earlier point leaves the
 * current revision exactly as it was.
 *
 * NO GEOMETRY KERNEL. These are CAD Fixer's own exact-topology operations. No
 * Manifold, Geogram or PMP code is imported here or anywhere in the
 * application — the bundle scan checks it.
 */

function isMesh(value: CanonicalMesh | { code: string }): value is CanonicalMesh {
  return !isAppError(value);
}

/**
 * Peak the repair will hold: M0 and the candidate coexist by design.
 *
 * REFUSAL HAPPENS HERE, before any bulk array exists. `callerCeilingBytes` may
 * only narrow the product ceiling — `requestRepairPeak` enforces that — so a
 * message can make CAD Fixer more cautious and never less.
 */
function preflight(
  operation: string,
  mesh: CanonicalMesh,
  faceCount: number,
  callerCeilingBytes: number | undefined,
): ReturnType<typeof resourceLimitExceeded> | undefined {
  const authoritative = meshByteLength(mesh);
  const workspace = estimateTopologyWorkspaceBytes(faceCount, faceCount * 3);
  // Authoritative + candidate + connectivity + validation workspace.
  const peak = authoritative * 2 + faceCount * 3 * 24 + workspace;
  return requestRepairPeak(operation, peak, { faceCount, peak }, callerCeilingBytes);
}

/**
 * The topology report a repair is planned from.
 *
 * Reuses the cached report for this exact revision when there is one, and
 * analyses otherwise. Geometry at a revision is immutable — `replace` produces a
 * new revision rather than mutating in place — so a cached report describes
 * precisely the mesh this handle resolves to. The cache compares the revision
 * rather than assuming it, so a report for an earlier revision is never reused.
 *
 * Without this, opening the repair workflow analysed the model a second time and
 * building a candidate analysed it a third, all to reproduce the report the
 * application had already shown the user.
 */
function reportFor(
  mesh: CanonicalMesh,
  handle: ModelHandle,
  cancellation: CancellationToken,
): TopologyReport {
  const cached = topologyReports.get(handle);
  if (cached !== undefined) return cached;

  const report = analyseTopology(mesh, {
    modelId: handle.modelId,
    modelRevision: handle.revision,
    cancellation,
  }).report;
  topologyReports.set(handle, report);
  return report;
}

export const repairPlanHandler: OperationHandler<'repair/plan'> = async (payload, context) => {
  const resolved = residentModels.resolve(payload.handle);
  if (!isMesh(resolved)) throw resolved;

  const faceCount = triangleCount(resolved);
  const refusal = preflight('repair/plan', resolved, faceCount, payload.memoryBudgetBytes);
  if (refusal) throw refusal;

  context.reportProgress(0, 'planning repair');
  const report = reportFor(resolved, payload.handle, context.cancellation);

  // Yield once so a cancel queued during the analysis is observed rather than
  // being overtaken by the result. Planning allocates no candidate, so this is
  // the only window it needs.
  await yieldToEventLoop();
  context.throwIfCancelled();

  const { plan } = planConservativeRepair({
    mesh: resolved,
    report,
    modelId: payload.handle.modelId,
    sourceRevision: payload.handle.revision,
    requested: payload.requested,
    cancellation: context.cancellation,
    ...(payload.memoryBudgetBytes === undefined
      ? {}
      : { memoryBudgetBytes: payload.memoryBudgetBytes }),
  });
  context.reportProgress(1, 'planned');

  return { value: { handle: payload.handle, plan } };
};

/**
 * CANCELLATION, and what it can honestly mean here.
 *
 * A worker handler that never returns to the event loop cannot be cancelled: the
 * cancel arrives as a MESSAGE, and the message queue is not read while a
 * synchronous handler is running, so a polled flag never changes. The repair
 * pipeline is synchronous by design — it is one deterministic pass that either
 * produces a validated candidate or does not — so this handler is `async` and
 * yields at the points where a decision can still be unmade.
 *
 * WHAT THE USER GETS. A cancel is observed at the next yield, and no candidate is
 * ever REGISTERED: the pipeline's output is dropped on the floor and the store
 * never learns it existed. So "cancelled" means exactly what it says — no
 * preview, nothing committable, nothing resident, and the model untouched.
 *
 * WHAT IT DOES NOT MEAN. The pipeline pass already under way runs to completion
 * before the cancel is seen; the work is discarded, not interrupted mid-array.
 * This is the same contract topology analysis has had since Stage 2, and it is
 * stated rather than implied because the difference is observable on a very
 * large model.
 */
export const repairCreateCandidateHandler: OperationHandler<'repair/create-candidate'> = async (
  payload,
  context,
) => {
  const resolved = residentModels.resolve(payload.handle);
  if (!isMesh(resolved)) throw resolved;

  const faceCount = triangleCount(resolved);
  const refusal = preflight(
    'repair/create-candidate',
    resolved,
    faceCount,
    payload.memoryBudgetBytes,
  );
  if (refusal) throw refusal;

  context.reportProgress(0, 'analysing');
  const report = reportFor(resolved, payload.handle, context.cancellation);

  // The first cancellation window: analysis is the longest phase before any
  // candidate memory is touched, so a cancel arriving during it is honoured
  // before the pipeline allocates anything at all.
  await yieldToEventLoop();
  context.throwIfCancelled();

  const { plan, view, prepared } = planConservativeRepair({
    mesh: resolved,
    report,
    modelId: payload.handle.modelId,
    sourceRevision: payload.handle.revision,
    requested: payload.requested,
    cancellation: context.cancellation,
    ...(payload.memoryBudgetBytes === undefined
      ? {}
      : { memoryBudgetBytes: payload.memoryBudgetBytes }),
  });

  /*
   * COMMIT WHAT WAS PREVIEWED. The caller names the plan it saw; if a freshly
   * computed plan differs, the model or the request changed underneath it and
   * building a candidate would silently apply something else.
   */
  if (plan.planHash !== payload.planHash) {
    throw invalidState('The model changed since this repair was planned.', {
      expected: payload.planHash,
      computed: plan.planHash,
    });
  }

  let outcome;
  try {
    outcome = executeConservativeRepair({
      source: resolved,
      plan,
      sourceReport: report,
      cancellation: context.cancellation,
      modelId: payload.handle.modelId,
      revision: payload.handle.revision,
      view,
      prepared,
      ...(payload.sampleLimit === undefined ? {} : { sampleLimit: payload.sampleLimit }),
      onProgress: (fraction, note) => {
        context.reportProgress(fraction, note);
      },
    });
  } catch (cause) {
    // Cancellation is converted to the protocol's own error rather than
    // escaping as an unrecognised class. M0 is untouched either way: the
    // pipeline only ever wrote to a candidate.
    if (cause instanceof RepairCancelled) throw operationCancelled('Repair was cancelled.');
    throw cause;
  }

  /*
   * THE SECOND CANCELLATION WINDOW, and the load-bearing one. It sits BEFORE the
   * candidate is registered, so a cancel that arrives while the pipeline was
   * running leaves nothing in the store: no handle to commit, no geometry
   * resident, no preview. Yielding after registration would have created a
   * candidate that only a discard could clean up, and a cancel that leaks memory
   * is not a cancel.
   */
  await yieldToEventLoop();
  if (context.cancellation.isCancelled) throw operationCancelled('Repair was cancelled.');

  // A rejected or no-op result registers NO candidate, so there is nothing
  // committable lying around for a caller to find.
  const candidate =
    outcome.candidate !== undefined && outcome.validation.acceptance === RepairAcceptance.Accepted
      ? repairCandidates.create(
          payload.handle,
          outcome.candidate,
          outcome.validation,
          outcome.inverse,
        )
      : undefined;

  const render: RenderSnapshot | undefined =
    outcome.candidate === undefined ? undefined : buildRenderSnapshot(outcome.candidate);

  return {
    value: {
      candidate,
      source: payload.handle,
      plan,
      validation: outcome.validation,
      counts: outcome.counts,
      samples: outcome.samples,
      inverseBytes: outcome.inverse?.byteLength ?? 0,
      candidateBounds:
        outcome.candidate === undefined ? undefined : computeBounds(outcome.candidate),
      render,
    },
    ...(render === undefined ? {} : { transfer: [render.positions.buffer, render.normals.buffer] }),
  };
};

export const repairCommitHandler: OperationHandler<'repair/commit'> = (payload, context) => {
  const currentRevision = residentModels.revisionOf(payload.expectedSource.modelId);
  const prepared = repairCandidates.prepareCommit(
    {
      candidate: payload.candidate,
      expectedSource: payload.expectedSource,
      planHash: payload.planHash,
    },
    currentRevision,
  );
  if (isAppError(prepared)) throw prepared;

  // The inverse patch is read BEFORE the candidate is consumed: `markCommitted`
  // releases the candidate's references, and undo needs the patch afterwards.
  const inverse = repairCandidates.inverseOf(payload.candidate);
  const validation = repairCandidates.validationOf(payload.candidate);

  /*
   * THE ATOMIC STEP. `replace` re-checks the revision and swaps one map entry.
   * If it refuses, the candidate stays RESOLVED and retryable — the failure
   * must not consume it, or a transient race would destroy a valid repair.
   */
  const next = residentModels.replace(payload.expectedSource, prepared);
  if (isAppError(next)) throw next;
  repairCandidates.markCommitted(payload.candidate);

  // Deterministic identity: lineage, parent and plan. NOT a wall clock — two
  // repairs a millisecond apart must still be distinguishable by what they did,
  // not by when they happened.
  const repairRecordId = `${next.modelId}@${String(payload.expectedSource.revision)}->${String(next.revision)}#${payload.planHash}`;

  const entry = repairHistory.record({
    recordId: repairRecordId,
    source: payload.expectedSource,
    result: next,
    appliedOperations: validation?.applied ?? [],
    planHash: payload.planHash,
    inverse,
  });

  const render = buildRenderSnapshot(prepared);
  context.reportProgress(1, 'applied');

  return Promise.resolve({
    value: {
      handle: next,
      parentRevision: payload.expectedSource.revision,
      repairRecordId,
      appliedOperations: validation?.applied ?? [],
      render,
      residentBytes: meshByteLength(prepared),
      triangleCount: triangleCount(prepared),
      vertexCount: vertexCount(prepared),
      bounds: computeBounds(prepared),
      undoable: entry.undoable,
    },
    transfer: [render.positions.buffer, render.normals.buffer],
  });
};

export const repairDiscardHandler: OperationHandler<'repair/discard'> = (payload) => {
  return Promise.resolve({ value: { released: repairCandidates.discard(payload.candidate) } });
};

/**
 * UNDO — the inverse transaction.
 *
 * A NEW MONOTONIC REVISION, not a revival of the old one. Reactivating revision
 * N after N+1 existed would make "is this handle stale?" unanswerable: two
 * different meshes would have worn the same revision number, and every guard in
 * the runtime is built on that number only ever moving forwards. See ADR 0011.
 *
 * The result is validated like any other geometry output. `restoreFromInverse`
 * promises byte-identical coordinates, original face order, original groups and
 * original metadata — but a promise is not a check, and rule 11 says a returned
 * mesh is not success.
 */
export const repairUndoHandler: OperationHandler<'repair/undo'> = (payload, context) => {
  const current = residentModels.resolve(payload.handle);
  if (!isMesh(current)) throw current;

  const currentRevision = residentModels.revisionOf(payload.handle.modelId);
  const preparation = repairHistory.prepareUndo(payload.recordId, payload.handle, currentRevision);
  if (isAppError(preparation)) throw preparation;

  context.reportProgress(0.1, 'restoring previous version');
  const restored = restoreFromInverse(current, preparation.patch);

  // Rule 11: the output of a geometry operation is validated before it is
  // accepted, no matter how confident the operation is.
  assertMeshStructure(restored, 'repair/undo');

  if (triangleCount(restored) !== preparation.patch.sourceFaceCount) {
    throw invalidState('The restored model does not have the expected number of triangles.', {
      expected: preparation.patch.sourceFaceCount,
      actual: triangleCount(restored),
    });
  }

  const next = residentModels.replace(payload.handle, restored);
  if (isAppError(next)) throw next;
  repairHistory.markUndone(payload.recordId);

  const render = buildRenderSnapshot(restored);
  context.reportProgress(1, 'restored');

  return Promise.resolve({
    value: {
      handle: next,
      revertedRevision: payload.handle.revision,
      restoredRevision: preparation.entry.parentRevision,
      recordId: payload.recordId,
      appliedOperations: preparation.entry.appliedOperations,
      render,
      residentBytes: meshByteLength(restored),
      triangleCount: triangleCount(restored),
      vertexCount: vertexCount(restored),
      bounds: computeBounds(restored),
    },
    transfer: [render.positions.buffer, render.normals.buffer],
  });
};
