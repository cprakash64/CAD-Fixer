import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  SharedCancellationSource,
  isSharedCancellationSupported,
  uncancellable,
  type CancellationToken,
} from '@cadfixer/shared';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { CANCEL_POLL_INTERVAL, RepairCancelled } from './cancellation';
import {
  selectDuplicateFaces,
  selectRepeatedPositionFaces,
  selectZeroAreaFaces,
  solveWinding,
} from './operations';
import { prepareConservativeRepair } from './prepare';
import { planConservativeRepair } from './plan';
import { executeConservativeRepair } from './pipeline';
import { RepairOperation } from './contract';
import { buildRepairView } from './view';
import { rebuildCandidate } from './rebuild';

/**
 * GENUINE INTERRUPTION, proven at the engine level.
 *
 * The distinction this file exists to hold: before Stage 3B-1C the repair
 * pipeline observed cancellation only BETWEEN phases, so a cancel could stop the
 * result being published but could not stop the work. These tests fail if the
 * polls move back out of the loops, because they cancel MID-LOOP and assert that
 * the loop stopped early — not merely that the caller threw away the answer.
 *
 * The counting token is the instrument. It reports "not cancelled" for a fixed
 * number of reads and "cancelled" afterwards, and it records how many times it
 * was read. A loop that polls only at its boundaries reads it once or twice; a
 * loop that polls at a bounded interval reads it once per batch and stops within
 * one batch of the flip.
 */

/** A token that flips after `flipAfterReads` reads, and counts every read. */
function countingToken(flipAfterReads: number): CancellationToken & { readonly reads: number } {
  let reads = 0;
  return {
    get reads(): number {
      return reads;
    },
    get isCancelled(): boolean {
      reads += 1;
      return reads > flipAfterReads;
    },
    onCancelled: () => () => undefined,
  };
}

/**
 * A grid of independent triangles, half of them exact duplicates.
 *
 * Large enough that every polled loop runs for several batch intervals, which is
 * what makes "did it stop early" a meaningful question.
 */
function duplicateHeavyMesh(faces: number): CanonicalMesh {
  const positions = createPositionArray(faces * 9);
  const indices = createIndexArray(faces * 3);
  for (let face = 0; face < faces; face += 1) {
    // Every second face repeats the previous face's coordinates exactly.
    const source = face % 2 === 0 ? face : face - 1;
    const x = (source % 512) * 2;
    const y = Math.floor(source / 512) * 2;
    const base = face * 9;
    positions[base] = x;
    positions[base + 1] = y;
    positions[base + 2] = 0;
    positions[base + 3] = x + 1;
    positions[base + 4] = y;
    positions[base + 5] = 0;
    positions[base + 6] = x;
    positions[base + 7] = y + 1;
    positions[base + 8] = 0;
  }
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  return { positions, indices, metadata: {} };
}

/** Two adjacent triangles per quad, wound inconsistently, so winding has work. */
function windingHeavyMesh(quads: number): CanonicalMesh {
  const faces = quads * 2;
  const positions = createPositionArray(faces * 9);
  const indices = createIndexArray(faces * 3);
  for (let quad = 0; quad < quads; quad += 1) {
    const x = quad % 256;
    const y = Math.floor(quad / 256);
    const corners: readonly (readonly [number, number, number])[] = [
      [x, y, 0],
      [x + 1, y, 0],
      [x + 1, y + 1, 0],
      [x, y + 1, 0],
    ];
    // First triangle forward, second REVERSED: they disagree across the shared
    // diagonal, which is exactly what the parity solve has to walk.
    const order = [[0, 1, 2], [0, 2, 3].reverse()];
    for (const [t, triangle] of order.entries()) {
      const base = (quad * 2 + t) * 9;
      for (const [c, cornerIndex] of triangle.entries()) {
        const corner = corners[cornerIndex] ?? [0, 0, 0];
        positions[base + c * 3] = corner[0];
        positions[base + c * 3 + 1] = corner[1];
        positions[base + c * 3 + 2] = corner[2];
      }
    }
  }
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  return { positions, indices, metadata: {} };
}

describe('the shared signal is a real cross-thread primitive', () => {
  it('is available in this environment', () => {
    // Node has SharedArrayBuffer unconditionally; the browser needs cross-origin
    // isolation, which the deployment mandates. If this ever fails, the
    // isolation policy — not a fallback — is the answer.
    expect(isSharedCancellationSupported()).toBe(true);
  });

  it('publishes a flip through the buffer, not through an object reference', () => {
    const source = new SharedCancellationSource();
    // A SECOND view over the same memory, standing in for the worker's view.
    const observer = new Int32Array(source.buffer);

    expect(Atomics.load(observer, 0)).toBe(0);
    source.cancel();
    expect(Atomics.load(observer, 0)).toBe(1);
  });

  it('costs exactly four bytes', () => {
    expect(new SharedCancellationSource().buffer.byteLength).toBe(4);
  });

  it('is idempotent', () => {
    const source = new SharedCancellationSource();
    source.cancel();
    source.cancel();
    expect(source.isCancelled).toBe(true);
  });
});

describe('CC02: cancellation is observed inside the duplicate-selection loop', () => {
  it('stops within one batch of the flip instead of scanning every face', () => {
    const mesh = duplicateHeavyMesh(CANCEL_POLL_INTERVAL * 4);
    const view = buildRepairView(mesh);
    const token = countingToken(1);

    expect(() => selectDuplicateFaces(view, token)).toThrow(RepairCancelled);

    /*
     * THE LOAD-BEARING ASSERTION. The loop polls once per batch, so flipping on
     * the second read means it stopped after roughly two batches — not after
     * 131,072 faces. A boundary-only implementation would have polled once,
     * completed the whole scan, and never thrown from inside the loop at all.
     */
    expect(token.reads).toBeGreaterThan(1);
    expect(token.reads).toBeLessThan(6);
  });

  it('completes normally when nothing cancels it', () => {
    const mesh = duplicateHeavyMesh(2048);
    const view = buildRepairView(mesh);
    const selection = selectDuplicateFaces(view, uncancellable);
    expect(selection.removeCount).toBeGreaterThan(0);
  });
});

describe('CC03: cancellation is observed inside the degenerate-selection loops', () => {
  it('interrupts the repeated-position scan', () => {
    const mesh = duplicateHeavyMesh(CANCEL_POLL_INTERVAL * 3);
    const view = buildRepairView(mesh);
    const token = countingToken(1);

    expect(() => selectRepeatedPositionFaces(view, token)).toThrow(RepairCancelled);
    expect(token.reads).toBeLessThan(6);
  });

  it('interrupts the zero-area scan', () => {
    const mesh = duplicateHeavyMesh(CANCEL_POLL_INTERVAL * 3);
    const view = buildRepairView(mesh);
    const token = countingToken(1);

    expect(() => selectZeroAreaFaces(view, token)).toThrow(RepairCancelled);
    expect(token.reads).toBeLessThan(6);
  });
});

describe('CC05: cancellation is observed inside the winding parity traversal', () => {
  it('interrupts the solve rather than completing it', () => {
    const mesh = windingHeavyMesh(CANCEL_POLL_INTERVAL);
    const view = buildRepairView(mesh);
    const token = countingToken(1);

    expect(() => solveWinding(view, undefined, token)).toThrow(RepairCancelled);
    expect(token.reads).toBeGreaterThan(1);
  });

  it('solves normally when nothing cancels it', () => {
    const mesh = windingHeavyMesh(64);
    const view = buildRepairView(mesh);
    const solution = solveWinding(view, undefined, uncancellable);
    expect(solution.flipCount).toBeGreaterThan(0);
  });
});

describe('CC04/CC06: cancellation reaches preparation and compaction', () => {
  it('interrupts prepareConservativeRepair rather than returning a partial plan', () => {
    const mesh = duplicateHeavyMesh(CANCEL_POLL_INTERVAL * 2);
    const report = analyseTopology(mesh, {
      documentId: 'm',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;
    const token = countingToken(1);

    expect(() =>
      prepareConservativeRepair(
        mesh,
        report,
        [RepairOperation.RemoveDuplicateFaces, RepairOperation.UnifyWinding],
        undefined,
        token,
      ),
    ).toThrow(RepairCancelled);
  });
});

describe('CC08: a cancel observed after the work still yields no candidate', () => {
  it('throws rather than returning geometry the caller could commit', () => {
    const mesh = duplicateHeavyMesh(4096);
    const report = analyseTopology(mesh, {
      documentId: 'm',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;
    const { plan, view, prepared } = planConservativeRepair({
      mesh,
      report,
      documentId: 'm',
      partId: 'part-1',
      sourceRevision: 1,
      requested: [RepairOperation.RemoveDuplicateFaces],
    });

    // Cancelled from the very first poll inside execution: whatever phase it
    // lands in, no candidate may come back.
    const alreadyCancelled: CancellationToken = {
      isCancelled: true,
      onCancelled: () => () => undefined,
    };

    expect(() =>
      executeConservativeRepair({
        source: mesh,
        plan,
        sourceReport: report,
        cancellation: alreadyCancelled,
        documentId: 'm',
        partId: 'part-1',
        revision: 1,
        view,
        prepared,
      }),
    ).toThrow(RepairCancelled);
  });
});

describe('CC10/CC11: cancelling twice, then retrying', () => {
  it('is idempotent and leaves the engine able to repair again', () => {
    const mesh = duplicateHeavyMesh(2048);
    const report = analyseTopology(mesh, {
      documentId: 'm',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;

    const source = new SharedCancellationSource();
    source.cancel();
    source.cancel();

    expect(() =>
      prepareConservativeRepair(
        mesh,
        report,
        [RepairOperation.RemoveDuplicateFaces],
        undefined,
        source.token,
      ),
    ).toThrow(RepairCancelled);

    // A FRESH signal, as every operation gets. The retry must be unaffected by
    // the previous operation's cancellation.
    const retry = prepareConservativeRepair(
      mesh,
      report,
      [RepairOperation.RemoveDuplicateFaces],
      undefined,
      new SharedCancellationSource().token,
    );
    expect(retry.removalCount).toBeGreaterThan(0);
  });
});

describe('CC14: a cancelled repair leaves the source mesh byte-identical', () => {
  it('never writes to the mesh it was given', () => {
    // Small: the claim is that the source is never WRITTEN, which does not need
    // a mesh large enough to make the interruption itself interesting.
    const mesh = duplicateHeavyMesh(4096);
    const positionsBefore = Uint8Array.from(
      new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
    );
    const indicesBefore = Uint8Array.from(
      new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
    );
    const report = analyseTopology(mesh, {
      documentId: 'm',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;

    expect(() =>
      prepareConservativeRepair(
        mesh,
        report,
        [RepairOperation.RemoveDuplicateFaces],
        undefined,
        countingToken(0),
      ),
    ).toThrow(RepairCancelled);

    // Byte-level, not value-level: the claim is that the source was never
    // written, and comparing bytes is the only way to say that exactly.
    expect(
      new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
    ).toEqual(positionsBefore);
    expect(
      new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
    ).toEqual(indicesBefore);
  });
});

/* ----------------------------------------------------------------- CC01 -- */

describe('CC01: cancellation observed before any work begins', () => {
  /*
   * The degenerate case, and the one most easily broken by an "optimisation"
   * that hoists the first poll out of a loop. An already-cancelled token must
   * stop the pass at its very first check, before a single face is examined.
   */
  it('stops a selection pass at its first poll', () => {
    const mesh = duplicateHeavyMesh(CANCEL_POLL_INTERVAL * 4);
    const view = buildRepairView(mesh);
    const cancelled: CancellationToken = { isCancelled: true, onCancelled: () => () => undefined };

    expect(() => selectDuplicateFaces(view, cancelled)).toThrow(RepairCancelled);
  });

  it('stops the whole pipeline before it produces anything', () => {
    const mesh = duplicateHeavyMesh(2_048);
    const report = analyseTopology(mesh, {
      documentId: 'm',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;
    const view = buildRepairView(mesh);
    const { plan, prepared } = planConservativeRepair({
      mesh,
      report,
      documentId: 'm',
      partId: 'part-1',
      sourceRevision: 1,
      requested: [RepairOperation.RemoveDuplicateFaces],
      cancellation: uncancellable,
    });
    const cancelled: CancellationToken = { isCancelled: true, onCancelled: () => () => undefined };

    expect(() =>
      executeConservativeRepair({
        source: mesh,
        plan,
        sourceReport: report,
        cancellation: cancelled,
        documentId: 'm',
        partId: 'part-1',
        revision: 1,
        view,
        prepared,
      }),
    ).toThrow(RepairCancelled);
  });
});

/* ----------------------------------------------------------------- CC06 -- */

describe('CC06: cancellation is observed inside the face copy and flip', () => {
  /*
   * DEDICATED, not inherited from a pipeline test. Compaction is the phase that
   * actually writes the candidate's vertices: it copies nine floats and three
   * indices per surviving face and rewrites the winding of every flipped one. A
   * pipeline-level test proves the pipeline stopped somewhere; this proves the
   * copy itself stops, which is the only phase whose cost scales with the
   * candidate rather than with the source.
   */
  it('stops the compaction pass rather than copying every surviving face', () => {
    const faces = CANCEL_POLL_INTERVAL * 4;
    const mesh = duplicateHeavyMesh(faces);
    // Remove nothing and flip nothing: the copy is then the whole of the work,
    // so an early exit can only be the copy loop exiting early.
    const removeMask = new Uint8Array(faces);
    const flipMask = new Uint8Array(faces);
    for (let f = 0; f < faces; f += 1) flipMask[f] = 1;

    let batches = 0;
    let processed = 0;
    expect(() =>
      rebuildCandidate(mesh, faces, removeMask, flipMask, {
        onBatch: (done: number): void => {
          batches += 1;
          processed = done;
          // Cancel once the copy is demonstrably under way, never on the first
          // batch — otherwise this would be CC01 wearing a different name.
          if (batches >= 2) throw new RepairCancelled();
        },
      }),
    ).toThrow(RepairCancelled);

    // THE PROOF OF EARLY EXIT: the copy stopped partway through the faces.
    expect(processed).toBeLessThan(faces);
    expect(batches).toBeGreaterThan(1);
  });

  it('copies every face when nothing cancels it', () => {
    const faces = 1_024;
    const mesh = duplicateHeavyMesh(faces);
    const rebuilt = rebuildCandidate(mesh, faces, new Uint8Array(faces), undefined, {});
    expect(triangleCount(rebuilt.mesh)).toBe(faces);
  });
});

/* ----------------------------------------------------------------- CC07 -- */

describe('CC07: cancellation is observed inside candidate topology validation', () => {
  /*
   * THE PHASE THAT MADE THIS STAGE NECESSARY. A candidate is re-analysed by
   * Stage 2 before it may be accepted, and that analysis is the longest single
   * span of work in a repair. If it polls only at its phase boundaries then a
   * cancel during validation waits for a whole phase — seconds on a large model
   * — which is precisely the "cancellation that cannot cancel" this stage
   * removes.
   *
   * Asserted through the ABSTRACT token. `mesh-topology` knows nothing about
   * SharedArrayBuffer and must not: it is handed a `CancellationToken` and that
   * is the whole of its contract.
   */
  it('stops the analysis partway through rather than completing it', () => {
    const mesh = duplicateHeavyMesh(CANCEL_POLL_INTERVAL * 4);
    const token = countingToken(3);

    let lastFraction = 0;
    expect(() =>
      analyseTopology(mesh, {
        documentId: 'm',
        partId: 'part-1',
        documentRevision: 1,
        cancellation: token,
        onProgress: ({ fraction }) => {
          lastFraction = fraction;
        },
      }),
    ).toThrow();

    // processed < total, expressed as the analyser's own published progress:
    // it never reached completion.
    expect(lastFraction).toBeLessThan(1);
    // And it polled from INSIDE the work, not merely at a couple of boundaries.
    expect(token.reads).toBeGreaterThan(3);
  });

  it('completes and reports a full analysis when nothing cancels it', () => {
    const mesh = duplicateHeavyMesh(2_048);
    let lastFraction = 0;
    const { report } = analyseTopology(mesh, {
      documentId: 'm',
      partId: 'part-1',
      documentRevision: 1,
      cancellation: uncancellable,
      onProgress: ({ fraction }) => {
        lastFraction = fraction;
      },
    });
    expect(lastFraction).toBe(1);
    expect(report.sourceFaceCount).toBe(2_048);
  });
});
