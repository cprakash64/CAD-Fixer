/**
 * PEAK SCRATCH MODEL FOR THE TOPOLOGY ANALYSIS.
 *
 * The preflight check has to answer one question: how much memory will be live
 * AT THE SAME TIME. Summing "the bytes each stage allocates" does not answer it,
 * because stages differ in what survives them — the vertex hash table dies with
 * canonicalisation, while the edge arrays it produces stay live to the very end
 * and are still there when every later stage allocates on top of them.
 *
 * So each stage reports two numbers:
 *
 *   retained  — still live when the NEXT stage allocates, and therefore part of
 *               the live set for the whole remainder of the analysis
 *   transient — released when the stage returns
 *
 * and the peak is modelled as:
 *
 *   sum(retained over all stages) + max(transient over all stages)
 *
 * The sum is the live set at the end of the analysis, which is the moment every
 * retained array coexists. Adding the single largest transient covers whichever
 * stage allocates the most on top of it. This is an upper bound rather than an
 * exact trace: an early stage's transient is charged against the late-stage
 * retained set even though the two never actually coexist. That direction of
 * error is the safe one for a preflight, and it is far more accurate than the
 * previous model, which summed every stage's total and still missed several
 * arrays entirely.
 *
 * SUBARRAYS DO NOT SHRINK ANYTHING. `x.subarray(0, n)` shares the original
 * buffer, so a trimmed view keeps the full allocation alive. Estimates below are
 * written against the allocation, not the view — getting this wrong would
 * under-count by megabytes on a large model.
 */

export interface StageMemory {
  /** Bytes still live once the stage returns. */
  readonly retained: number;
  /** Bytes released when the stage returns. */
  readonly transient: number;
}

export function stage(retained: number, transient: number): StageMemory {
  return { retained, transient };
}

/** Live set at the end, plus the largest single transient on top of it. */
export function peakOf(stages: readonly StageMemory[]): number {
  let retained = 0;
  let largestTransient = 0;
  for (const entry of stages) {
    retained += entry.retained;
    if (entry.transient > largestTransient) largestTransient = entry.transient;
  }
  return retained + largestTransient;
}
