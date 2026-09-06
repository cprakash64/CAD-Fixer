import { describe, expect, it, vi } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import {
  HoleFillStatus,
  type DocumentHandle,
  type OperationHandle,
  type SendForFillResult,
} from '@cadfixer/geometry-runtime';
import { HoleFillCancelled, HoleFillService } from './hole-fill-service';
import type { GeometryClient } from './geometry-client';

/**
 * THE DISPOSABLE FILL WORKER'S LIFECYCLE, including the paths nobody wants.
 *
 * HP30 (cancellation), HP32 (a forced worker failure and a retry) and the
 * repeated success/refusal/cancel cycle live here rather than in the engine
 * suite, because none of them is geometry: there is no mesh that expresses "the
 * user pressed Cancel".
 *
 * WHY A WORKER DOUBLE RATHER THAN A REJECTED PROMISE. The failure path under
 * test is not "the promise rejected" — it is whether the `error` LISTENER runs,
 * whether the ports are closed, whether the worker reference is released,
 * whether the AUTHORITATIVE operation is cancelled too, and whether the next
 * operation can start. A hand-rejected promise proves none of that because it
 * never touches the worker at all.
 */

const handle: DocumentHandle = { documentId: 'model-1', revision: 3 } as DocumentHandle;
const PART = 'part-1';
const LOOP = 'bl-7-4-0123456789abcdef';

class FakeWorker extends EventTarget {
  public terminated = 0;
  public readonly posted: unknown[] = [];

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public terminate(): void {
    this.terminated += 1;
  }

  /** Fires the same `error` event a failing module worker fires. */
  public failToLoad(): void {
    this.dispatchEvent(new Event('error'));
  }

  public started(operationId: string, faceCount: number): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: { kind: 'started', operationId, faceCount } }),
    );
  }
}

interface PendingSend {
  resolve(value: SendForFillResult): void;
  reject(reason: unknown): void;
  cancelled: number;
}

interface Harness {
  service: HoleFillService;
  workers: FakeWorker[];
  sends: PendingSend[];
}

function summary(): SendForFillResult['summary'] {
  return {
    boundaryVertexCount: 4,
    sourceFaceCount: 8,
    patchFaceCount: 2,
    addedVertexCount: 0,
    boundaryLoopsBefore: 2,
    boundaryLoopsAfter: 1,
    selectedLoopRemoved: true,
    degeneratePatchFaces: 0,
    duplicatePatchFaces: 0,
    foreignPatchCorners: 0,
    opposingBoundaryEdges: 4,
    agreeingBoundaryEdges: 0,
    invalidPatchSourcePairs: 0,
    invalidPatchPatchPairs: 0,
    broadphaseCandidates: 12,
    broadphaseAabbTests: 40,
    broadphaseNodeVisits: 6,
    narrowphaseChecks: 12,
    narrowphaseRefusals: 0,
    planarityRatio: 0,
    projectionAxis: 2,
    eulerApplicable: true,
    eulerBefore: 0,
    eulerAfter: 1,
    eulerPassed: true,
    totalDurationMs: 1,
    phaseMilliseconds: {
      loopResolution: 0,
      eligibility: 0,
      planarity: 0,
      triangulation: 0,
      candidateAssembly: 0,
      structuralValidation: 0,
      topologyValidation: 0,
      broadphase: 0,
      narrowphase: 0,
    },
  };
}

function harness(): Harness {
  const workers: FakeWorker[] = [];
  const sends: PendingSend[] = [];

  const client = {
    sendForFill: vi.fn((): OperationHandle<SendForFillResult> => {
      const pending: PendingSend = {
        resolve: () => undefined,
        reject: () => undefined,
        cancelled: 0,
      };
      const promise = new Promise<SendForFillResult>((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
      });
      sends.push(pending);
      return {
        id: `op-${String(sends.length)}`,
        promise,
        cancel: (): void => {
          pending.cancelled += 1;
        },
      } as unknown as OperationHandle<SendForFillResult>;
    }),
  } as unknown as GeometryClient;

  const service = new HoleFillService(client, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });

  return { service, workers, sends };
}

const start = (service: HoleFillService): ReturnType<HoleFillService['run']> =>
  service.run({ handle, partId: PART, boundaryLoopId: LOOP });

describe('HP30: cancellation is termination, and it settles', () => {
  it('terminates the fill worker, cancels the authoritative side, and rejects', async () => {
    const { service, workers, sends } = harness();
    const session = start(service);
    expect(service.liveWorkerCount).toBe(1);
    expect(service.liveChannelCount).toBe(1);

    session.cancel();

    const cause = await session.promise.catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(HoleFillCancelled);

    // TERMINATION, not a flag nothing reads.
    expect(workers[0]?.terminated).toBeGreaterThan(0);
    // AND the authoritative operation, which would otherwise wait forever on a
    // channel a dead worker will never answer.
    expect(sends[0]?.cancelled).toBeGreaterThan(0);

    expect(service.liveWorkerCount).toBe(0);
    expect(service.liveChannelCount).toBe(0);
    expect(service.activeOperation).toBeUndefined();
  });

  it('is idempotent: cancelling twice is not a fault', async () => {
    const { service } = harness();
    const session = start(service);
    session.cancel();
    session.cancel();
    await expect(session.promise).rejects.toBeInstanceOf(HoleFillCancelled);
    expect(service.liveWorkerCount).toBe(0);
  });

  it('DISCARDS a result that arrives after cancellation', async () => {
    const { service, sends } = harness();
    const session = start(service);
    session.cancel();

    // The authoritative side settles late, as it would if the reply crossed
    // the channel just before the terminate landed.
    sends[0]?.resolve({
      status: HoleFillStatus.ValidCandidate,
      summary: summary(),
      intersectionSamples: new Uint32Array(0),
      samplesTruncated: false,
    });

    await expect(session.promise).rejects.toBeInstanceOf(HoleFillCancelled);
  });

  it('allows a retry on a FRESH worker after a cancellation', async () => {
    const { service, workers, sends } = harness();
    const first = start(service);
    first.cancel();
    await first.promise.catch(() => undefined);

    const second = start(service);
    expect(workers).toHaveLength(2);
    expect(workers[1]).not.toBe(workers[0]);
    expect(service.liveWorkerCount).toBe(1);

    sends[1]?.resolve({
      status: HoleFillStatus.ValidCandidate,
      summary: summary(),
      intersectionSamples: new Uint32Array(0),
      samplesTruncated: false,
    });
    await expect(second.promise).resolves.toMatchObject({
      status: HoleFillStatus.ValidCandidate,
    });
    expect(service.liveWorkerCount).toBe(0);
  });
});

describe('HP32: a fill worker that fails is reported, released, and retryable', () => {
  it('turns a real worker error event into a typed failure', async () => {
    const { service, workers, sends } = harness();
    const session = start(service);

    workers[0]?.failToLoad();

    const cause = await session.promise.catch((error: unknown) => error);
    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.Internal);

    // Everything the operation owned is released, not merely forgotten.
    expect(workers[0]?.terminated).toBeGreaterThan(0);
    expect(sends[0]?.cancelled).toBeGreaterThan(0);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.liveChannelCount).toBe(0);
    expect(service.activeOperation).toBeUndefined();
  });

  it('surfaces an authoritative-side refusal without leaving anything pending', async () => {
    const { service, workers, sends } = harness();
    const session = start(service);

    sends[0]?.reject(new Error('this part is above the ceiling'));

    const cause = await session.promise.catch((error: unknown) => error);
    expect(isAppError(cause)).toBe(true);
    expect(workers[0]?.terminated).toBeGreaterThan(0);
    expect(service.liveWorkerCount).toBe(0);
    expect(service.activeOperation).toBeUndefined();
  });

  it('runs a full lifecycle without leaking a worker or a channel', async () => {
    /*
     * success → success → refusal → cancel → retry → forced failure → retry.
     * Zero live workers before, exactly one while running, zero after each.
     */
    const { service, workers, sends } = harness();
    expect(service.liveWorkerCount).toBe(0);

    const settleWith = async (
      status: SendForFillResult['status'],
      index: number,
    ): Promise<void> => {
      const session = start(service);
      expect(service.liveWorkerCount).toBe(1);
      expect(service.liveChannelCount).toBe(1);
      sends[index]?.resolve({
        status,
        summary: summary(),
        intersectionSamples: new Uint32Array(0),
        samplesTruncated: false,
      });
      await session.promise;
      expect(service.liveWorkerCount).toBe(0);
      expect(service.liveChannelCount).toBe(0);
      expect(service.activeOperation).toBeUndefined();
    };

    await settleWith(HoleFillStatus.ValidCandidate, 0);
    await settleWith(HoleFillStatus.ValidCandidate, 1);
    await settleWith(HoleFillStatus.RefusedNonPlanar, 2);

    const cancelled = start(service);
    cancelled.cancel();
    await cancelled.promise.catch(() => undefined);
    expect(service.liveWorkerCount).toBe(0);

    await settleWith(HoleFillStatus.ValidCandidate, 4);

    const failed = start(service);
    workers[5]?.failToLoad();
    await failed.promise.catch(() => undefined);
    expect(service.liveWorkerCount).toBe(0);

    await settleWith(HoleFillStatus.ValidCandidate, 6);

    // One worker per operation, every one of them terminated.
    expect(workers).toHaveLength(7);
    for (const worker of workers) expect(worker.terminated).toBeGreaterThan(0);
  });
});

describe('one fill at a time', () => {
  it('disposes the first when a second starts', async () => {
    const { service, workers, sends } = harness();
    const first = start(service);
    const second = start(service);

    expect(workers).toHaveLength(2);
    expect(workers[0]?.terminated).toBeGreaterThan(0);
    expect(sends[0]?.cancelled).toBeGreaterThan(0);
    expect(service.liveWorkerCount).toBe(1);

    await expect(first.promise).rejects.toBeInstanceOf(HoleFillCancelled);

    sends[1]?.resolve({
      status: HoleFillStatus.ValidCandidate,
      summary: summary(),
      intersectionSamples: new Uint32Array(0),
      samplesTruncated: false,
    });
    await expect(second.promise).resolves.toMatchObject({
      status: HoleFillStatus.ValidCandidate,
    });
  });
});

describe('progress is scalars', () => {
  it('reports a face count and nothing else', () => {
    const { service, workers } = harness();
    const seen: number[] = [];
    service.run({ handle, partId: PART, boundaryLoopId: LOOP, onStarted: (n) => seen.push(n) });
    const operationId = service.activeOperation ?? '';
    workers[0]?.started(operationId, 4_096);
    workers[0]?.started('some-other-operation', 99);
    expect(seen).toEqual([4_096]);
  });
});
