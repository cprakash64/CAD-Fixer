import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, IDENTITY_MATRIX4 } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { ModelHandle, OperationContext } from '@cadfixer/geometry-runtime';
import {
  AppErrorCode,
  isAppError,
  SharedCancellationSource,
  uncancellable,
  operationCancelled,
  type CancellationToken,
} from '@cadfixer/shared';
import { repairCreateCandidateHandler, repairPlanHandler } from './repair-handlers';
import { residentModels } from './stl-handlers';

/**
 * THE WORKER'S TWO CANCELLATION CONTRACTS.
 *
 * One: a cancellation observed ANYWHERE inside a repair handler reaches the
 * caller as `OPERATION_CANCELLED`, never as an internal failure. A refusal is
 * not an error and neither is a cancellation, and the panel renders the two in
 * different registers — so misclassifying one is a user-visible defect, not a
 * cosmetic one.
 *
 * Two: a repair that cannot be interrupted is refused rather than run.
 */

function context(
  cancellation: CancellationToken = uncancellable,
  interruptible = true,
): OperationContext {
  return {
    cancellation,
    interruptible,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

/** A grid of independent triangles, half of them exact duplicates. */
function duplicateHeavyMesh(faces: number): CanonicalMesh {
  const positions = createPositionArray(faces * 9);
  const indices = createIndexArray(faces * 3);
  for (let face = 0; face < faces; face += 1) {
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
  return { positions, indices, metadata: { transform: IDENTITY_MATRIX4 } };
}

function residentHandle(faces: number): ModelHandle {
  return residentModels.commit(duplicateHeavyMesh(faces));
}

describe('O9 REGRESSION: a cancellation is never reported as an internal error', () => {
  /*
   * THE DEFECT THIS REPRODUCES. Stage 3B-1C added cancellation polling inside
   * `prepareConservativeRepair`, which runs within `planConservativeRepair` —
   * ABOVE the try/catch that converted `RepairCancelled`. A cancel observed
   * during preparation therefore escaped as an unrecognised class,
   * `toAppError` turned it into INTERNAL_ERROR, and the repair panel rendered
   * "Cancelled" as a candidate ERROR. O9 timed out waiting for a cancelled state
   * that could never arrive.
   *
   * A token that is cancelled from the outset reaches preparation through the
   * handler's own `throwIfCancelled`; one that flips partway reaches the engine
   * loops. Both must arrive as OPERATION_CANCELLED.
   */
  const cancelledFromTheStart: CancellationToken = {
    isCancelled: true,
    onCancelled: () => () => undefined,
  };

  /** Flips after a fixed number of reads, so the flip lands inside the engine. */
  function flipAfter(reads: number): CancellationToken {
    let seen = 0;
    return {
      get isCancelled(): boolean {
        seen += 1;
        return seen > reads;
      },
      onCancelled: () => () => undefined,
    };
  }

  it('reports OPERATION_CANCELLED from repair/create-candidate, not INTERNAL_ERROR', async () => {
    const handle = residentHandle(4_096);
    const cause = await repairCreateCandidateHandler(
      { handle, requested: [], planHash: 'unused' },
      context(cancelledFromTheStart),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.OperationCancelled);
    expect(cause.code).not.toBe(AppErrorCode.Internal);
  });

  it('reports OPERATION_CANCELLED when the flip lands inside preparation', async () => {
    const handle = residentHandle(65_536 * 2);
    const cause = await repairCreateCandidateHandler(
      { handle, requested: [], planHash: 'unused' },
      context(flipAfter(6)),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.OperationCancelled);
  });

  it('reports OPERATION_CANCELLED from repair/plan too', async () => {
    const handle = residentHandle(4_096);
    const cause = await repairPlanHandler(
      { handle, requested: [] },
      context(cancelledFromTheStart),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.OperationCancelled);
  });
});

describe('FAIL CLOSED: a repair that cannot be interrupted is refused', () => {
  /*
   * DEFENCE IN DEPTH. The panel already withholds the workflow when the document
   * is not cross-origin isolated, so in a correct deployment this never fires.
   * It exists for the request the application boundary cannot police: a forged
   * message, or a future caller that forgets to opt in. Running it anyway would
   * present a Cancel control that silently does nothing.
   */
  it('refuses repair/create-candidate without a shared cancellation signal', async () => {
    const handle = residentHandle(256);
    const cause = await repairCreateCandidateHandler(
      { handle, requested: [], planHash: 'unused' },
      context(uncancellable, false),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.InvalidState);
    expect(cause.message).toMatch(/cross-origin isolated/i);
  });

  it('refuses repair/plan without a shared cancellation signal', async () => {
    const handle = residentHandle(256);
    const cause = await repairPlanHandler(
      { handle, requested: [] },
      context(uncancellable, false),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.InvalidState);
  });

  it('does NOT refuse when a real shared signal is present', async () => {
    const source = new SharedCancellationSource();
    const handle = residentHandle(256);
    const cause = await repairPlanHandler(
      { handle, requested: [] },
      context(source.token, true),
    ).catch((error: unknown) => error);

    // It may succeed or fail for unrelated reasons, but never for THIS reason.
    if (isAppError(cause)) {
      expect(cause.message).not.toMatch(/cross-origin isolated/i);
    }
  });
});
