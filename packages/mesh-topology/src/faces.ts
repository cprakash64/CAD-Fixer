import { stage, type StageMemory } from './memory';
/**
 * DEGENERATE AND DUPLICATE FACE ANALYSIS.
 *
 * Both are read-only findings. Nothing is removed, merged, or reinterpreted —
 * a degenerate triangle in the file is a degenerate triangle in the report.
 *
 * DEGENERACY CATEGORIES ARE EXCLUSIVE, and the report says which is which:
 *
 *   repeatedPosition — the face has fewer than three DISTINCT topological
 *                      vertices. Two or more of its corners are the same point.
 *                      Detected from recovered ids, so it is found even though
 *                      the source soup indices are always distinct.
 *
 *   zeroArea         — three distinct topological vertices that are exactly
 *                      collinear, so the cross product is exactly zero.
 *
 * A face counted as `repeatedPosition` is NOT also counted as `zeroArea`, even
 * though it has no area, because the two describe different defects and a user
 * adding the columns should not double-count. Every degenerate face appears in
 * exactly one category.
 *
 * NO EPSILON. Collinearity is exact: the cross product is computed in float64
 * and compared against zero. A "nearly collinear" triangle is a quality
 * question with a scale-relative threshold, which STL's missing unit makes
 * unanswerable here, so Stage 2 does not guess.
 *
 * DUPLICATE FACES are compared by recovered topological ids, so a duplicate is
 * found regardless of where it sits in the file or which corner it starts from:
 *
 *   same orientation     — same cyclic order, e.g. (a,b,c) ≡ (b,c,a) ≡ (c,a,b)
 *   reversed orientation — opposite cyclic order, e.g. (a,c,b)
 *
 * COUNT SEMANTICS — both counts are EXTRA FACES BEYOND THE FIRST, not groups.
 * Three copies of one triangle report two same-orientation duplicates. That is
 * the number a user would have to delete to be left with one of each, which is
 * the question they are actually asking.
 *
 * Duplicates are found by sorting canonical face keys, never by pairwise
 * comparison.
 */

export interface DegeneracyAnalysis {
  /** Faces with fewer than three distinct topological vertices. */
  readonly repeatedPositionCount: number;
  /** Faces with three distinct vertices that are exactly collinear. */
  readonly zeroAreaCount: number;
  /** Face indices, bounded sample, for later overlay use. */
  readonly sampleFaces: Uint32Array;
  readonly sampleTruncated: boolean;
}

export function analyseDegeneracy(
  faceVertices: Uint32Array,
  faceCount: number,
  positions: ArrayLike<number>,
  vertexRepresentativeCorner: Uint32Array,
  sampleLimit: number,
  onBatch?: (processed: number) => void,
): DegeneracyAnalysis {
  let repeatedPositionCount = 0;
  let zeroAreaCount = 0;
  const sample: number[] = [];
  let sampleTruncated = false;

  const FACES_PER_BATCH = 65_536;

  /*
   * TWO PASSES, ONE MONOTONIC SCALE. This function walks the faces twice — once
   * to build keys, once to scan the sorted runs — but `analyseTopology` maps its
   * callback onto a single half-phase measured in faces. Reporting each pass's
   * own index would send the published fraction backwards at the hand-over,
   * which breaks the analyser's monotonic-progress contract. Both passes are
   * therefore reported on a shared 0..faceCount scale, each contributing half.
   */
  for (let f = 0; f < faceCount; f += 1) {
    if (f % FACES_PER_BATCH === 0) onBatch?.(f / 2);

    const base = f * 3;
    const a = faceVertices[base] ?? 0;
    const b = faceVertices[base + 1] ?? 0;
    const c = faceVertices[base + 2] ?? 0;

    let degenerate = false;

    if (a === b || b === c || a === c) {
      repeatedPositionCount += 1;
      degenerate = true;
    } else {
      // Exact collinearity: cross product of the two edge vectors is zero in
      // every component. Computed in float64 — JavaScript arithmetic — from
      // coordinates read through each vertex's representative corner.
      const ax = coordinate(positions, vertexRepresentativeCorner, a, 0);
      const ay = coordinate(positions, vertexRepresentativeCorner, a, 1);
      const az = coordinate(positions, vertexRepresentativeCorner, a, 2);
      const e1x = coordinate(positions, vertexRepresentativeCorner, b, 0) - ax;
      const e1y = coordinate(positions, vertexRepresentativeCorner, b, 1) - ay;
      const e1z = coordinate(positions, vertexRepresentativeCorner, b, 2) - az;
      const e2x = coordinate(positions, vertexRepresentativeCorner, c, 0) - ax;
      const e2y = coordinate(positions, vertexRepresentativeCorner, c, 1) - ay;
      const e2z = coordinate(positions, vertexRepresentativeCorner, c, 2) - az;

      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      if (nx === 0 && ny === 0 && nz === 0) {
        zeroAreaCount += 1;
        degenerate = true;
      }
    }

    if (degenerate) {
      if (sample.length < sampleLimit) sample.push(f);
      else sampleTruncated = true;
    }
  }

  onBatch?.(faceCount);

  return {
    repeatedPositionCount,
    zeroAreaCount,
    sampleFaces: Uint32Array.from(sample),
    sampleTruncated,
  };
}

function coordinate(
  positions: ArrayLike<number>,
  representative: Uint32Array,
  vertex: number,
  axis: number,
): number {
  return positions[(representative[vertex] ?? 0) * 3 + axis] ?? 0;
}

export interface DuplicateAnalysis {
  /** Extra faces beyond the first, same cyclic orientation. */
  readonly sameOrientationCount: number;
  /** Extra faces beyond the first, opposite cyclic orientation. */
  readonly reversedOrientationCount: number;
}

/**
 * Finds duplicate faces by sorting canonical keys.
 *
 * Each non-degenerate face is reduced to its three ids sorted ascending —
 * identical for every rotation AND for the reversal — so all copies of a
 * triangle land adjacent after one sort. Within a run, orientation is then
 * compared against the run's first face to split same from reversed.
 *
 * Faces with repeated vertices are skipped: "duplicate" is not a meaningful
 * classification for a triangle that is already degenerate, and including them
 * would let one defect inflate two different counts.
 *
 * COMPLEXITY — O(F log F) from the sort. No pairwise comparison.
 */
export function analyseDuplicates(
  faceVertices: Uint32Array,
  faceCount: number,
  onBatch?: (processed: number) => void,
): DuplicateAnalysis {
  // Sorted-triple key per face, plus the face index, in typed arrays.
  const keyA = new Uint32Array(faceCount);
  const keyB = new Uint32Array(faceCount);
  const keyC = new Uint32Array(faceCount);
  const order = new Uint32Array(faceCount);
  const usable = new Uint8Array(faceCount);

  const FACES_PER_BATCH = 65_536;

  for (let f = 0; f < faceCount; f += 1) {
    if (f % FACES_PER_BATCH === 0) onBatch?.(f);
    const base = f * 3;
    const a = faceVertices[base] ?? 0;
    const b = faceVertices[base + 1] ?? 0;
    const c = faceVertices[base + 2] ?? 0;
    order[f] = f;
    if (a === b || b === c || a === c) continue;
    usable[f] = 1;

    let lo = a;
    let mid = b;
    let hi = c;
    if (lo > mid) [lo, mid] = [mid, lo];
    if (mid > hi) [mid, hi] = [hi, mid];
    if (lo > mid) [lo, mid] = [mid, lo];
    keyA[f] = lo;
    keyB[f] = mid;
    keyC[f] = hi;
  }

  onBatch?.(faceCount / 2);

  /*
   * THE ONE NON-INTERRUPTIBLE STEP IN TOPOLOGY ANALYSIS.
   *
   * `Array.prototype.sort` runs to completion inside the engine, so no poll can
   * be placed inside it and a cancel requested while it is running is observed
   * only once it returns. It is retained deliberately rather than replaced: it
   * is a single O(N log N) pass whose measured cost is recorded in the Stage
   * 3B-1C report, and rewriting a correct sort to shave cancellation latency
   * would be a large change justified by no evidence.
   *
   * A typed-array-backed sort of INDICES; the comparator reads the key arrays
   * rather than boxed records.
   */
  const sorted = Array.from(order).sort((left, right) => {
    const a = (keyA[left] ?? 0) - (keyA[right] ?? 0);
    if (a !== 0) return a;
    const b = (keyB[left] ?? 0) - (keyB[right] ?? 0);
    if (b !== 0) return b;
    const c = (keyC[left] ?? 0) - (keyC[right] ?? 0);
    if (c !== 0) return c;
    return left - right;
  });

  let sameOrientationCount = 0;
  let reversedOrientationCount = 0;

  let index = 0;
  while (index < faceCount) {
    // Polled on the scan cursor. The run-detection loop below is bounded by the
    // size of one duplicate run, so the cursor is the honest measure of
    // progress through the pass.
    if (index % FACES_PER_BATCH === 0) onBatch?.((faceCount + index) / 2);
    const first = sorted[index] ?? 0;
    if (usable[first] !== 1) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < faceCount) {
      const candidate = sorted[end] ?? 0;
      if (
        usable[candidate] !== 1 ||
        (keyA[candidate] ?? 0) !== (keyA[first] ?? 0) ||
        (keyB[candidate] ?? 0) !== (keyB[first] ?? 0) ||
        (keyC[candidate] ?? 0) !== (keyC[first] ?? 0)
      ) {
        break;
      }
      end += 1;
    }

    // Every face after the first in this run is an extra copy.
    for (let i = index + 1; i < end; i += 1) {
      const candidate = sorted[i] ?? 0;
      if (sameCyclicOrientation(faceVertices, first, candidate)) sameOrientationCount += 1;
      else reversedOrientationCount += 1;
    }

    index = end;
  }

  onBatch?.(faceCount);
  return { sameOrientationCount, reversedOrientationCount };
}

/** True when `other` lists the same three vertices in the same cyclic order. */
function sameCyclicOrientation(faceVertices: Uint32Array, first: number, other: number): boolean {
  const a = faceVertices[first * 3] ?? 0;
  const b = faceVertices[first * 3 + 1] ?? 0;
  const c = faceVertices[first * 3 + 2] ?? 0;
  const x = faceVertices[other * 3] ?? 0;
  const y = faceVertices[other * 3 + 1] ?? 0;
  const z = faceVertices[other * 3 + 2] ?? 0;

  return (
    (x === a && y === b && z === c) ||
    (x === b && y === c && z === a) ||
    (x === c && y === a && z === b)
  );
}

/** Memory profile of the degenerate and duplicate face stages. */
export function estimateFaceAnalysisBytes(faceCount: number): StageMemory {
  // Nothing survives these stages but counts and a bounded sample, which the
  // caller budgets separately.
  const retained = 0;
  // Four Uint32 key/order arrays, one Uint8 usable flag, plus the sorted index
  // array — a JS number array, budgeted at 8 bytes an element.
  const transient = faceCount * (4 * 4 + 1) + faceCount * 8;
  return stage(retained, transient);
}
