import { MAX_UNSHARED_IMPORT_TRIANGLES } from '@cadfixer/mesh-core';
import { formatCount, resourceLimitExceeded, type AppError } from '@cadfixer/shared';

/**
 * Resource limits applied to an import, in one place rather than as magic
 * numbers scattered through the parsers.
 *
 * The parsers consult this BEFORE allocating, so a hostile file is refused
 * while it is still just bytes. Every limit is injectable, which is also what
 * makes the limits testable without generating gigabyte fixtures.
 */
export interface ImportBudget {
  /** Largest input buffer the parser will look at. */
  readonly maxInputBytes: number;
  /** Largest triangle count that may be materialised. */
  readonly maxTriangles: number;
  /**
   * Largest triangle count an UNSHARED-CORNER parse may materialise.
   *
   * THE FORMAT-SPECIFIC HALF OF THE STAGE 6D-R3 IMPORT GATE, and the only
   * ceiling here that is derived from another package rather than chosen. STL
   * preserves the file's triangle stream and never welds, so its canonical
   * bytes AND the render snapshot that follows are both exactly proportional to
   * the triangle count — which a binary STL's LENGTH already states. That makes
   * this the one import where the resource decision can be taken before a single
   * array is allocated, rather than after the reader has returned.
   *
   * DERIVED FROM `MAX_IMPORT_GEOMETRY_BYTES`, never written twice. A number of
   * its own here would drift from the common gate and a file would be fully
   * parsed only to be refused: all of the work and none of the protection.
   */
  readonly maxUnsharedImportTriangles: number;
  /** Largest vertex count that may be materialised. */
  readonly maxVertices: number;
  /** Combined byte size of the typed arrays a parse may allocate. */
  readonly maxOutputBytes: number;
  /**
   * Ceiling on estimated peak working memory: input buffer plus output arrays
   * plus render buffers, all live at once.
   */
  readonly maxEstimatedPeakBytes: number;
  /** Longest single token an ASCII parse will accept, in bytes. */
  readonly maxTokenBytes: number;
}

/**
 * Default limits.
 *
 * Sized from the real shape of the problem rather than picked to look safe: a
 * 512 MiB binary STL is about 10.7 million triangles, which is a large but
 * genuine print file. Refusing at, say, 50 MB would make the product useless
 * for its own audience, and claiming no limit at all would be a lie — the tab
 * dies first.
 *
 * SINCE STAGE 6D-R3 `maxUnsharedImportTriangles` IS WHAT BINDS ON A LARGE STL,
 * at 6,710,886 triangles — a 320 MiB binary file. The output and peak ceilings
 * above it remain because they bound the ARRAY the engine would have to
 * allocate, which is a different failure and needs its own typed refusal. See
 * docs/PERFORMANCE_BASELINE.md for the measured expansion factor and
 * docs/release/RESOURCE_POLICY.md for the measurements behind the new one.
 */
export const DEFAULT_IMPORT_BUDGET: ImportBudget = {
  maxInputBytes: 512 * 1024 * 1024,
  maxTriangles: 20_000_000,
  maxUnsharedImportTriangles: MAX_UNSHARED_IMPORT_TRIANGLES,
  maxVertices: 60_000_000,
  maxOutputBytes: 1024 * 1024 * 1024,
  maxEstimatedPeakBytes: 1536 * 1024 * 1024,
  maxTokenBytes: 1024,
};

/**
 * Largest length any typed array may be given.
 *
 * Independent of our own budget: exceeding it throws a `RangeError` from the
 * engine rather than producing a typed failure, so it is checked first.
 */
export const MAX_TYPED_ARRAY_LENGTH = 2 ** 32 - 1;

export interface AllocationPlan {
  readonly triangles: number;
  readonly vertices: number;
  /**
   * Length of the LONGEST typed array the parse will create — the position
   * array, at three elements per vertex. This, not the vertex count, is what
   * has to be checked against the engine's array limit.
   */
  readonly positionElements: number;
  /** Bytes for positions + indices + render normals. */
  readonly outputBytes: number;
  readonly estimatedPeakBytes: number;
}

/**
 * Computes what a parse of `triangles` triangles would cost.
 *
 * All arithmetic is done in doubles, which represent integers exactly up to
 * 2^53. The largest value that can appear here is bounded by a uint32 triangle
 * count: 2^32 * 50 is about 2.1e11, roughly four orders of magnitude below
 * 2^53, so no term can silently overflow or lose precision. That is what makes
 * the comparisons below trustworthy against an attacker-chosen facet count.
 */
export function planAllocation(triangles: number, inputBytes: number): AllocationPlan {
  const vertices = triangles * 3;
  const positionElements = vertices * 3;
  // Positions: 3 vertices x 3 components x 4 bytes. Indices: 3 x 4 bytes.
  // Render normals match positions.
  const positionBytes = vertices * 3 * 4;
  const indexBytes = vertices * 4;
  const normalBytes = positionBytes;
  const outputBytes = positionBytes + indexBytes + normalBytes;
  return {
    triangles,
    vertices,
    positionElements,
    outputBytes,
    // The input buffer is still live while the output is being filled.
    estimatedPeakBytes: outputBytes + inputBytes,
  };
}

/**
 * Refuses an allocation before it happens.
 *
 * Returns an `AppError` rather than throwing so callers can attach parse
 * context; the caller throws. Details carry sizes and limits — never file
 * contents.
 */
export function checkAllocation(
  plan: AllocationPlan,
  budget: ImportBudget,
  operation: string,
  inputBytes: number,
): AppError | undefined {
  const reject = (reason: string, requested: number, limit: number): AppError =>
    resourceLimitExceeded(reason, {
      operation,
      requested,
      limit,
      inputBytes,
      triangleCount: plan.triangles,
    });

  // A count that is not a whole positive number cannot describe an allocation,
  // and would otherwise sail through every comparison below (NaN compares false
  // against everything) and produce a zero-length array.
  if (!Number.isInteger(plan.triangles) || plan.triangles < 0) {
    return reject('This model declares an impossible triangle count.', plan.triangles, 0);
  }

  // Checked against the LONGEST array, which is positions at three elements per
  // vertex — not the vertex count. This guard exists to turn an engine
  // RangeError into a typed failure, so it has to measure the thing that would
  // actually throw.
  if (plan.positionElements > MAX_TYPED_ARRAY_LENGTH) {
    return reject(
      'This model needs more array elements than the JavaScript engine supports.',
      plan.positionElements,
      MAX_TYPED_ARRAY_LENGTH,
    );
  }
  if (plan.triangles > budget.maxTriangles) {
    return reject(
      'This model has more triangles than CAD Fixer can load.',
      plan.triangles,
      budget.maxTriangles,
    );
  }
  /*
   * REFUSED BEFORE THE FIRST ARRAY. `planAllocation` describes an UNSHARED-corner
   * parse — `vertices = triangles * 3` — which is exactly what the STL readers
   * produce, so the geometry this file would cost to open is fully determined
   * here. The common gate in `commitImportedDocument` would reach the same
   * verdict, hundreds of megabytes later.
   */
  if (plan.triangles > budget.maxUnsharedImportTriangles) {
    return reject(
      `This model has ${formatCount(plan.triangles)} triangles; CAD Fixer's limit for a ` +
        `file that stores every triangle separately is ` +
        `${formatCount(budget.maxUnsharedImportTriangles)}.`,
      plan.triangles,
      budget.maxUnsharedImportTriangles,
    );
  }
  if (plan.vertices > budget.maxVertices) {
    return reject(
      'This model has more vertices than CAD Fixer can load.',
      plan.vertices,
      budget.maxVertices,
    );
  }
  if (plan.outputBytes > budget.maxOutputBytes) {
    return reject(
      'Loading this model would need more memory than CAD Fixer allows.',
      plan.outputBytes,
      budget.maxOutputBytes,
    );
  }
  if (plan.estimatedPeakBytes > budget.maxEstimatedPeakBytes) {
    return reject(
      'Loading this model would exceed the working memory limit.',
      plan.estimatedPeakBytes,
      budget.maxEstimatedPeakBytes,
    );
  }
  return undefined;
}

export function checkInputSize(
  inputBytes: number,
  budget: ImportBudget,
  operation: string,
): AppError | undefined {
  if (inputBytes > budget.maxInputBytes) {
    return resourceLimitExceeded('This file is larger than CAD Fixer can open.', {
      operation,
      requested: inputBytes,
      limit: budget.maxInputBytes,
      inputBytes,
    });
  }
  return undefined;
}
