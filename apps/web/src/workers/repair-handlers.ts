import { computeBounds, triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  executeConservativeRepair,
  planConservativeRepair,
  RepairAcceptance,
  RepairCancelled,
} from '@cadfixer/mesh-repair';
import {
  meshByteLength,
  requestAnalysisWorkspace,
  type OperationHandler,
  type RenderSnapshot,
} from '@cadfixer/geometry-runtime';
import {
  invalidState,
  isAppError,
  operationCancelled,
  type resourceLimitExceeded,
} from '@cadfixer/shared';
import { buildRenderSnapshot, repairCandidates, residentModels } from './stl-handlers';

/**
 * WORKER HANDLERS FOR CONSERVATIVE REPAIR.
 *
 * FOUR OPERATIONS, NOT ONE. Planning must be observable without allocating a
 * candidate, and applying must be a separate, explicitly confirmed act. A
 * single `repair/apply` would make preview impossible and would make an
 * accidental resend destructive.
 *
 * `model/analyze` is untouched. Analysis stays read-only; hiding a repair verb
 * inside it would make every diagnosis a potential mutation.
 *
 * THE AUTHORITATIVE MODEL IS NEVER WRITTEN except by `repair/commit`, and only
 * after every guard in `RepairCandidateStore.prepareCommit` has passed. A
 * failure at any earlier point leaves M0 exactly as it was.
 *
 * NO GEOMETRY KERNEL. These are CAD Fixer's own exact-topology operations. No
 * Manifold, Geogram or PMP code is imported here or anywhere in the
 * application — the bundle scan checks it.
 */

function isMesh(value: CanonicalMesh | { code: string }): value is CanonicalMesh {
  return !isAppError(value);
}

/** Peak the repair will hold: M0 and the candidate coexist by design. */
function preflight(
  operation: string,
  mesh: CanonicalMesh,
  faceCount: number,
): ReturnType<typeof resourceLimitExceeded> | undefined {
  const authoritative = meshByteLength(mesh);
  const workspace = estimateTopologyWorkspaceBytes(faceCount, faceCount * 3);
  // Authoritative + candidate + connectivity + validation workspace.
  const peak = authoritative * 2 + faceCount * 3 * 24 + workspace;
  return requestAnalysisWorkspace(operation, peak, { faceCount });
}

export const repairPlanHandler: OperationHandler<'repair/plan'> = (payload, context) => {
  const resolved = residentModels.resolve(payload.handle);
  if (!isMesh(resolved)) throw resolved;

  const faceCount = triangleCount(resolved);
  const refusal = preflight('repair/plan', resolved, faceCount);
  if (refusal) throw refusal;

  context.reportProgress(0, 'planning repair');
  const report = analyseTopology(resolved, {
    modelId: payload.handle.modelId,
    modelRevision: payload.handle.revision,
    cancellation: context.cancellation,
  }).report;
  context.throwIfCancelled();

  const { plan } = planConservativeRepair({
    mesh: resolved,
    report,
    modelId: payload.handle.modelId,
    sourceRevision: payload.handle.revision,
    requested: payload.requested,
    ...(payload.memoryBudgetBytes === undefined
      ? {}
      : { memoryBudgetBytes: payload.memoryBudgetBytes }),
  });
  context.reportProgress(1, 'planned');

  return Promise.resolve({ value: { handle: payload.handle, plan } });
};

export const repairCreateCandidateHandler: OperationHandler<'repair/create-candidate'> = (
  payload,
  context,
) => {
  const resolved = residentModels.resolve(payload.handle);
  if (!isMesh(resolved)) throw resolved;

  const faceCount = triangleCount(resolved);
  const refusal = preflight('repair/create-candidate', resolved, faceCount);
  if (refusal) throw refusal;

  context.reportProgress(0, 'analysing');
  const report = analyseTopology(resolved, {
    modelId: payload.handle.modelId,
    modelRevision: payload.handle.revision,
    cancellation: context.cancellation,
  }).report;
  context.throwIfCancelled();

  const { plan, view, prepared } = planConservativeRepair({
    mesh: resolved,
    report,
    modelId: payload.handle.modelId,
    sourceRevision: payload.handle.revision,
    requested: payload.requested,
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

  return Promise.resolve({
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
  });
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

  /*
   * THE ATOMIC STEP. `replace` re-checks the revision and swaps one map entry.
   * If it refuses, the candidate stays RESOLVED and retryable — the failure
   * must not consume it, or a transient race would destroy a valid repair.
   */
  const next = residentModels.replace(payload.expectedSource, prepared);
  if (isAppError(next)) throw next;
  repairCandidates.markCommitted(payload.candidate);

  const validation = repairCandidates.validationOf(payload.candidate);
  const render = buildRenderSnapshot(prepared);
  context.reportProgress(1, 'applied');

  return Promise.resolve({
    value: {
      handle: next,
      parentRevision: payload.expectedSource.revision,
      // Deterministic identity: lineage, parent and plan. NOT a wall clock —
      // two repairs a millisecond apart must still be distinguishable by what
      // they did, not by when.
      repairRecordId: `${next.modelId}@${String(payload.expectedSource.revision)}->${String(next.revision)}#${payload.planHash}`,
      appliedOperations: validation?.applied ?? [],
      render,
      residentBytes: meshByteLength(prepared),
    },
    transfer: [render.positions.buffer, render.normals.buffer],
  });
};

export const repairDiscardHandler: OperationHandler<'repair/discard'> = (payload) => {
  return Promise.resolve({ value: { released: repairCandidates.discard(payload.candidate) } });
};
