import { MAX_IMPORT_GEOMETRY_BYTES, type ImportGeometryCost } from '@cadfixer/mesh-core';
import { formatBytes, formatCount, resourceLimitExceeded, type AppError } from '@cadfixer/shared';

/**
 * Session-level memory accounting for the resident geometry runtime.
 *
 * TWO BUDGETS, DELIBERATELY SEPARATE. `ImportBudget` in `@cadfixer/file-formats`
 * bounds a single parser allocation — "may this parse commit these arrays?".
 * This one bounds what the WORKSPACE holds and what a single operation may
 * allocate on top of it.
 *
 * WHAT THIS IS NOT, AND STAGE 6D-R3 MADE IT STOP PRETENDING OTHERWISE. It is an
 * application allocation budget, not a measurement of process or free memory. A
 * browser will not tell us how much memory is available: `performance.memory` is
 * Chromium-only, heap-only, and excludes the off-heap allocations that typed
 * arrays mostly are. Every ceiling here therefore bounds bytes CAD FIXER CHOOSES
 * TO ALLOCATE and is CALIBRATED against measured Chromium footprint, rather than
 * claiming to predict it. `maxImportPeakBytes` claimed to predict it, was
 * measured wrong by up to 81x in both directions, and is gone.
 *
 * All arithmetic is in doubles, which represent integers exactly to 2^53. Every
 * quantity here is a byte count derived from counts the readers and the document
 * gate already bound, so no term can approach that limit — but inputs are
 * validated anyway, because a NaN would otherwise pass every comparison
 * silently.
 */

export interface SessionMemoryBudget {
  /** Ceiling on authoritative geometry held in the worker, across all models. */
  readonly maxResidentBytes: number;
  /**
   * Ceiling on the geometry ONE DOCUMENT costs to open: its canonical buffers
   * plus the render snapshot built from them, counted once per DISTINCT mesh.
   *
   * IT DOES NOT NAME A PROCESS PEAK, and nothing here claims to know one. It
   * bounds bytes CAD Fixer chooses to allocate, and the value is calibrated
   * against measured Chromium footprint in `mesh-core`'s `import-cost.ts`,
   * where the measurements are recorded beside the number they produced.
   *
   * THE CURRENT DOCUMENT IS DELIBERATELY NOT A TERM. See `checkImportGeometry`.
   */
  readonly maxImportGeometryBytes: number;
  /** Ceiling on modelled peak during an export. */
  readonly maxExportPeakBytes: number;
  /** Ceiling on scratch space a single analysis may request. */
  readonly maxAnalysisWorkspaceBytes: number;
  /**
   * Ceiling on modelled peak during a conservative repair.
   *
   * SEPARATE FROM THE ANALYSIS CEILING, deliberately. A repair peak is a
   * different quantity: the authoritative mesh and the candidate coexist by
   * design — that coexistence IS the safety property — so the peak is both
   * meshes plus connectivity plus the validation workspace, not the workspace
   * alone. Checking a repair peak against an analysis-workspace ceiling would be
   * comparing two different things and calling the answer a limit.
   */
  readonly maxRepairPeakBytes: number;
}

/**
 * Defaults sized from the measured shape of the problem.
 *
 * `maxImportGeometryBytes` is `mesh-core`'s, not a copy: the measurements that
 * produced it are recorded beside the constant, in the module that also owns the
 * render-snapshot allocation it bounds. Restating the number here would be a
 * second answer to the same question.
 *
 * See docs/PERFORMANCE_BASELINE.md and docs/release/RESOURCE_POLICY.md for the
 * measurements the rest come from.
 */
export const DEFAULT_SESSION_MEMORY_BUDGET: SessionMemoryBudget = {
  maxResidentBytes: 768 * 1024 * 1024,
  maxImportGeometryBytes: MAX_IMPORT_GEOMETRY_BYTES,
  maxExportPeakBytes: 1536 * 1024 * 1024,
  maxAnalysisWorkspaceBytes: 1024 * 1024 * 1024,
  maxRepairPeakBytes: 1024 * 1024 * 1024,
};

export interface MemoryEstimate {
  readonly modelledPeakBytes: number;
  readonly breakdown: Readonly<Record<string, number>>;
}

/**
 * Models peak bytes during an export.
 *
 * The resident mesh stays live while the writer's output buffer is built. ASCII
 * additionally holds encoded chunks before they are concatenated, which is why
 * the caller supplies the expected output size rather than this guessing.
 */
export function estimateExportPeak(residentBytes: number, outputBytes: number): MemoryEstimate {
  const breakdown = {
    resident: residentBytes,
    output: outputBytes,
    // The chunk list is held while the final contiguous buffer is filled.
    writerChunks: outputBytes,
  };
  return { modelledPeakBytes: sum(breakdown), breakdown };
}

export type MemoryCheck = AppError | undefined;

function sum(breakdown: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(breakdown)) {
    // A non-finite term would make every comparison below silently false.
    if (!Number.isFinite(value) || value < 0) return Number.POSITIVE_INFINITY;
    total += value;
  }
  return total;
}

function reject(
  operation: string,
  requested: number,
  limit: number,
  breakdown: Readonly<Record<string, number>>,
): AppError {
  return resourceLimitExceeded(
    'This would use more memory than CAD Fixer allows for one session.',
    { operation, requested, limit, ...breakdown },
  );
}

/**
 * Asks whether a document may become authoritative at the geometry it costs.
 *
 * RUNS BEFORE THE ALLOCATION IT BOUNDS. The render snapshot is the larger of
 * the two terms and has not been built when this is called, so a refusal
 * prevents it outright. The canonical buffers ARE already allocated — no gate
 * can be earlier than the reader for an indexed format, whose triangle count is
 * a fact about the file's contents rather than its length — and they are bounded
 * independently, by each reader's own limits and by the document gate.
 *
 * THE CURRENT DOCUMENT IS NOT A TERM, AND THAT IS A MEASURED DECISION, not an
 * omission. Replacing a 300 MiB model with another one was measured in Chromium
 * and the second import's footprint did not stack on the first: the outgoing
 * document's buffers are released as the successor commits, and the peak the
 * second import reaches is its own. Adding the outgoing document would make the
 * gate refuse a file purely because of what the user happened to open before it,
 * which is the behaviour the retired estimator had.
 *
 * NON-FINITE OR NEGATIVE TERMS REFUSE. A `NaN` compares false against every
 * ceiling, so a corrupted measurement would otherwise pass silently.
 */
export function checkImportGeometry(
  cost: ImportGeometryCost,
  budget: SessionMemoryBudget = DEFAULT_SESSION_MEMORY_BUDGET,
): MemoryCheck {
  const breakdown = {
    canonicalBytes: cost.canonicalBytes,
    renderSnapshotBytes: cost.renderSnapshotBytes,
    distinctMeshCount: cost.distinctMeshCount,
    distinctTriangleCount: cost.distinctTriangleCount,
  };
  const total = sum({
    canonicalBytes: cost.canonicalBytes,
    renderSnapshotBytes: cost.renderSnapshotBytes,
  });
  if (total > budget.maxImportGeometryBytes) {
    return resourceLimitExceeded(
      `Opening this model would need ${formatBytes(total)} of geometry and render buffers; ` +
        `CAD Fixer's limit is ${formatBytes(budget.maxImportGeometryBytes)}.`,
      {
        operation: 'session/import-geometry',
        requested: total,
        limit: budget.maxImportGeometryBytes,
        ...breakdown,
      },
    );
  }
  return undefined;
}

export function checkExportPeak(
  estimate: MemoryEstimate,
  budget: SessionMemoryBudget = DEFAULT_SESSION_MEMORY_BUDGET,
): MemoryCheck {
  if (estimate.modelledPeakBytes > budget.maxExportPeakBytes) {
    return reject(
      'session/export-peak',
      estimate.modelledPeakBytes,
      budget.maxExportPeakBytes,
      estimate.breakdown,
    );
  }
  return undefined;
}

/**
 * Asks whether an analysis may allocate the scratch space it estimates needing.
 *
 * The reservation point for topology diagnostics. Analysis workspaces can be
 * several times the size of the mesh — vertex canonicalisation records, edge
 * arrays, adjacency — so the request is made BEFORE allocating, and refusal is
 * a typed `RESOURCE_LIMIT_EXCEEDED` rather than an out-of-memory crash.
 *
 * `details` carries counts and byte estimates only. Never geometry.
 */
export function requestAnalysisWorkspace(
  operation: string,
  estimatedBytes: number,
  context: Readonly<Record<string, number>> = {},
  budget: SessionMemoryBudget = DEFAULT_SESSION_MEMORY_BUDGET,
): MemoryCheck {
  const limit = budget.maxAnalysisWorkspaceBytes;
  if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
    return reject(operation, Number.POSITIVE_INFINITY, limit, context);
  }
  if (estimatedBytes <= limit) return undefined;

  /*
   * THE SPECIFIC SENTENCE WHENEVER THE CALLER SAID WHAT IT IS MEASURING.
   * `faceCount` is what every production caller passes and is the number the
   * user can act on — "this part has 6,291,454 triangles" is a fact about their
   * model, where "too much memory" is a fact about ours. A caller that measures
   * something else still gets a typed refusal; it just gets the general one.
   */
  const faceCount = context.faceCount;
  return faceCount === undefined || !Number.isFinite(faceCount)
    ? reject(operation, estimatedBytes, limit, context)
    : rejectWorkspace(operation, estimatedBytes, limit, faceCount, context);
}

/**
 * The refusal a workspace request produces, with the numbers in it.
 *
 * SEPARATE FROM `reject` BECAUSE IT HAS SOMETHING TO SAY. Stage 6D-R2 recorded
 * that the generic sentence — "This would use more memory than CAD Fixer allows
 * for one session" — names no metric and no value, and R3 measured it being
 * shown to a user whose model had simply grown past the analysis ceiling. A
 * refusal the reader cannot act on is indistinguishable from a fault.
 */
function rejectWorkspace(
  operation: string,
  estimatedBytes: number,
  limit: number,
  faceCount: number,
  context: Readonly<Record<string, number>>,
): AppError {
  return resourceLimitExceeded(
    `This part has ${formatCount(faceCount)} triangles, which needs ` +
      `${formatBytes(estimatedBytes)} of working memory; CAD Fixer's limit for this ` +
      `is ${formatBytes(limit)}.`,
    { operation, requested: estimatedBytes, limit, ...context },
  );
}

/**
 * Asks whether a conservative repair may proceed at its modelled peak.
 *
 * REFUSAL HAPPENS BEFORE ANY BULK ALLOCATION, which is the whole point: a repair
 * that cannot fit must leave the user's model exactly as it was, loaded,
 * viewable and exportable. An out-of-memory crash mid-rebuild would take the tab
 * and the session with it.
 *
 * `callerCeilingBytes` can only NARROW the budget, never widen it. The protocol
 * lets a caller state a tighter ceiling than the product's own — a support or
 * diagnostic scenario on a constrained device — and a caller that asks for more
 * than the product allows still gets the product's answer.
 *
 * `context` carries counts and byte estimates only. Never geometry.
 */
export function requestRepairPeak(
  operation: string,
  estimatedBytes: number,
  context: Readonly<Record<string, number>> = {},
  callerCeilingBytes?: number,
  budget: SessionMemoryBudget = DEFAULT_SESSION_MEMORY_BUDGET,
): MemoryCheck {
  const ceiling =
    callerCeilingBytes === undefined || !Number.isFinite(callerCeilingBytes)
      ? budget.maxRepairPeakBytes
      : Math.min(budget.maxRepairPeakBytes, Math.max(0, callerCeilingBytes));

  if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
    return reject(operation, Number.POSITIVE_INFINITY, ceiling, context);
  }
  if (estimatedBytes > ceiling) {
    return reject(operation, estimatedBytes, ceiling, context);
  }
  return undefined;
}
