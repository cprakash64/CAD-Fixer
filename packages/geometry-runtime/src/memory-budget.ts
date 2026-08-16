import { resourceLimitExceeded, type AppError } from '@cadfixer/shared';

/**
 * Session-level memory accounting for the resident geometry runtime.
 *
 * TWO BUDGETS, DELIBERATELY SEPARATE. `ImportBudget` in `@cadfixer/file-formats`
 * bounds a single parser allocation — "may this parse commit these arrays?".
 * This one bounds the SESSION — "given what is already resident, may this
 * additional work proceed?". Stage 1 only needed the first, because nothing
 * stayed in memory between operations. Now the worker holds geometry across
 * operations, so peak usage depends on what is already there.
 *
 * WHAT THIS IS NOT. It is an application safety budget, not a measurement of
 * free memory. A browser will not tell us how much memory is actually
 * available: `performance.memory` is Chromium-only, heap-only, and excludes the
 * off-heap allocations that typed arrays mostly are. So this models the bytes
 * WE choose to allocate and refuses before committing them. It cannot prevent
 * an out-of-memory condition caused by other tabs, and does not claim to.
 *
 * All arithmetic is in doubles, which represent integers exactly to 2^53. Every
 * quantity here is a byte count derived from triangle counts bounded by the
 * import budget, so no term can approach that limit — but inputs are validated
 * anyway, because a NaN would otherwise pass every comparison silently.
 */

export interface SessionMemoryBudget {
  /** Ceiling on authoritative geometry held in the worker, across all models. */
  readonly maxResidentBytes: number;
  /** Ceiling on render snapshots held by the main thread. */
  readonly maxRenderBytes: number;
  /**
   * Ceiling on modelled peak during a transactional import, when the outgoing
   * model, the input buffer, and the candidate are all live at once.
   */
  readonly maxImportPeakBytes: number;
  /** Ceiling on modelled peak during an export. */
  readonly maxExportPeakBytes: number;
  /** Ceiling on scratch space a single analysis may request. */
  readonly maxAnalysisWorkspaceBytes: number;
}

/**
 * Defaults sized from the measured shape of the problem.
 *
 * A 100 MiB binary STL is ~2.1M triangles: ~96 MiB resident (positions +
 * indices) and ~144 MiB of render buffers (positions copy + normals). The
 * import peak for replacing one such model with another is roughly
 * resident(96) + input(100) + candidate(96) + candidate render(144) ≈ 436 MiB,
 * which is why the import ceiling is well above the resident one.
 *
 * See docs/PERFORMANCE_BASELINE.md for the measurements these come from.
 */
export const DEFAULT_SESSION_MEMORY_BUDGET: SessionMemoryBudget = {
  maxResidentBytes: 768 * 1024 * 1024,
  maxRenderBytes: 768 * 1024 * 1024,
  maxImportPeakBytes: 1536 * 1024 * 1024,
  maxExportPeakBytes: 1536 * 1024 * 1024,
  maxAnalysisWorkspaceBytes: 1024 * 1024 * 1024,
};

/** Bytes a canonical mesh of this size occupies: positions + indices. */
export function residentBytesFor(triangleCount: number): number {
  const vertices = triangleCount * 3;
  return vertices * 3 * 4 + vertices * 4;
}

/** Bytes a render snapshot occupies: positions copy + normals, non-indexed. */
export function renderBytesFor(triangleCount: number): number {
  const vertices = triangleCount * 3;
  return vertices * 3 * 4 * 2;
}

export interface ImportPeakInputs {
  /** Bytes of geometry already resident, which the import does not free yet. */
  readonly currentResidentBytes: number;
  /** Bytes of render snapshot already held by the main thread. */
  readonly currentRenderBytes: number;
  /** Size of the file buffer being parsed. */
  readonly inputBytes: number;
  /** Triangles the candidate will produce. */
  readonly candidateTriangles: number;
}

export interface MemoryEstimate {
  readonly modelledPeakBytes: number;
  readonly breakdown: Readonly<Record<string, number>>;
}

/**
 * Models peak bytes during a transactional import.
 *
 * The outgoing model is still resident when the candidate is committed — that
 * is what makes the replacement transactional — so both are counted, plus the
 * input buffer, plus the candidate's render snapshot.
 */
export function estimateImportPeak(inputs: ImportPeakInputs): MemoryEstimate {
  const candidateResident = residentBytesFor(inputs.candidateTriangles);
  const candidateRender = renderBytesFor(inputs.candidateTriangles);
  const breakdown = {
    currentResident: inputs.currentResidentBytes,
    currentRender: inputs.currentRenderBytes,
    inputBuffer: inputs.inputBytes,
    candidateResident,
    candidateRender,
  };
  return { modelledPeakBytes: sum(breakdown), breakdown };
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

export function checkImportPeak(
  estimate: MemoryEstimate,
  budget: SessionMemoryBudget = DEFAULT_SESSION_MEMORY_BUDGET,
): MemoryCheck {
  if (estimate.modelledPeakBytes > budget.maxImportPeakBytes) {
    return reject(
      'session/import-peak',
      estimate.modelledPeakBytes,
      budget.maxImportPeakBytes,
      estimate.breakdown,
    );
  }
  return undefined;
}

export function checkResident(
  residentBytes: number,
  renderBytes: number,
  budget: SessionMemoryBudget = DEFAULT_SESSION_MEMORY_BUDGET,
): MemoryCheck {
  if (!Number.isFinite(residentBytes) || residentBytes > budget.maxResidentBytes) {
    return reject('session/resident', residentBytes, budget.maxResidentBytes, { residentBytes });
  }
  if (!Number.isFinite(renderBytes) || renderBytes > budget.maxRenderBytes) {
    return reject('session/render', renderBytes, budget.maxRenderBytes, { renderBytes });
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
  if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
    return reject(operation, Number.POSITIVE_INFINITY, budget.maxAnalysisWorkspaceBytes, context);
  }
  if (estimatedBytes > budget.maxAnalysisWorkspaceBytes) {
    return reject(operation, estimatedBytes, budget.maxAnalysisWorkspaceBytes, context);
  }
  return undefined;
}
