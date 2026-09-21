import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { AppErrorCode, CancellationSource, uncancellable } from '@cadfixer/shared';
import {
  BooleanOperationController,
  type BooleanWorkerFactory,
} from './boolean-operation-controller';
import type { BooleanOperationReply, BooleanOperationRequest } from './boolean-operation-protocol';

function tetra(offset = 0): CanonicalMesh {
  const positions = createPositionArray(12);
  positions.set([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0, offset, 0, 1]);
  const indices = createIndexArray(12);
  indices.set([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  return { positions, indices, metadata: {} };
}

class FakeWorker {
  public terminated = false;
  public request: BooleanOperationRequest | undefined;
  private message: ((event: MessageEvent<BooleanOperationReply>) => void) | undefined;
  private error: (() => void) | undefined;
  public postMessage(message: BooleanOperationRequest): void {
    this.request = message;
  }
  public addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent<BooleanOperationReply>) => void) | (() => void),
  ): void {
    if (type === 'message') this.message = listener;
    else this.error = listener as () => void;
  }
  public terminate(): void {
    this.terminated = true;
  }
  public reply(message: BooleanOperationReply): void {
    this.message?.({ data: message } as MessageEvent<BooleanOperationReply>);
  }
  public crash(): void {
    this.error?.();
  }
}

function setup(): { controller: BooleanOperationController; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const factory: BooleanWorkerFactory = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
  return { controller: new BooleanOperationController(factory), workers };
}

describe('disposable Boolean operation controller', () => {
  it('terminates and settles cancellation, then recovers for success', async () => {
    const { controller, workers } = setup();
    const cancellation = new CancellationSource();
    const cancelled = controller.run('union', tetra(), tetra(0.2), cancellation.token);
    cancellation.cancel();
    await expect(cancelled).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    expect(workers[0]?.terminated).toBe(true);
    const successful = controller.run('union', tetra(), tetra(0.2), uncancellable);
    const request = workers[1]?.request;
    expect(request).toBeDefined();
    if (request === undefined) return;
    workers[1]?.reply({
      kind: 'result',
      operationId: request.operationId,
      positions: tetra().positions,
      indices: tetra().indices,
    });
    await expect(successful).resolves.toMatchObject({ indices: { length: 12 } });
    expect(controller.stats).toEqual({ active: 0, created: 2, terminated: 2 });
  });

  it('terminates a superseded worker and refuses an over-budget input before spawn', async () => {
    const { controller, workers } = setup();
    const first = controller.run('union', tetra(), tetra(0.2), uncancellable);
    const second = controller.run('difference', tetra(), tetra(0.2), uncancellable);
    await expect(first).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    expect(workers[0]?.terminated).toBe(true);
    const huge = { ...tetra(), indices: new Uint32Array(6_000_003) };
    expect(() => controller.run('union', huge, tetra(), uncancellable)).toThrow(/input triangles/);
    expect(workers).toHaveLength(2);
    controller.dispose();
    await expect(second).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
  });

  it('refuses pre-cancel before spawn and terminates on document release', async () => {
    const { controller, workers } = setup();
    const alreadyCancelled = new CancellationSource();
    alreadyCancelled.cancel();
    expect(() => controller.run('union', tetra(), tetra(0.2), alreadyCancelled.token)).toThrow(
      /cancelled/i,
    );
    expect(workers).toHaveLength(0);
    const active = controller.run('union', tetra(), tetra(0.2), uncancellable, {
      owner: { documentId: 'doc-1', generation: 1 },
    });
    controller.cancelDocument('doc-1');
    await expect(active).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    expect(controller.stats.active).toBe(0);
  });

  it('maps a child crash to internal failure and releases the worker', async () => {
    const { controller, workers } = setup();
    const result = controller.run('intersection', tetra(), tetra(0.2), uncancellable);
    workers[0]?.crash();
    await expect(result).rejects.toMatchObject({ code: AppErrorCode.Internal });
    expect(controller.stats.active).toBe(0);
    expect(workers[0]?.terminated).toBe(true);
  });
});
