import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppErrorCode,
  isAppError,
  resetOperationIdSequenceForTesting,
  resourceLimitExceeded,
  type OperationId,
} from '@cadfixer/shared';
import { GeometryCoordinator } from './coordinator';
import { createLinkedEndpoints } from './linked-endpoints';
import { PROTOCOL_CHANNEL } from './protocol';
import { createSelfTestHandler } from './self-test';
import { GeometryWorkerHost, type OperationHandler } from './worker-host';

/**
 * Exercises the coordinator and worker host against each other over an
 * in-memory transport.
 *
 * WHAT THIS PROVES: correlation, progress delivery, structured error transport,
 * cooperative cancellation, and teardown.
 *
 * WHAT IT DOES NOT PROVE: structured cloning and buffer detachment, because the
 * linked transport passes references. Real transfer semantics are covered by
 * the Playwright suite against an actual module worker.
 */

/**
 * A microtask yield is sufficient here: the linked transport delivers messages
 * on the microtask queue, so a queued `cancel` lands before the handler's next
 * chunk. The real worker entry point uses a macrotask, because a real port
 * delivers on the macrotask queue.
 */
const yieldToEventLoop = (): Promise<void> => Promise.resolve();

function buildPayload(byteLength: number): { bytes: ArrayBuffer; expectedChecksum: number } {
  const bytes = new ArrayBuffer(byteLength);
  const view = new Uint8Array(bytes);
  let expectedChecksum = 0;
  for (let index = 0; index < view.length; index += 1) {
    const value = index % 97;
    view[index] = value;
    expectedChecksum = (expectedChecksum + value) >>> 0;
  }
  return { bytes, expectedChecksum };
}

interface Harness {
  readonly coordinator: GeometryCoordinator;
  readonly onDiagnostic: ReturnType<typeof vi.fn>;
  readonly dispose: () => void;
}

function createHarness(
  handler: OperationHandler<'runtime/self-test'> = createSelfTestHandler({ yieldToEventLoop }),
): Harness {
  const [clientEndpoint, workerEndpoint] = createLinkedEndpoints();
  const host = new GeometryWorkerHost(workerEndpoint);
  host.register('runtime/self-test', handler);
  const stopHost = host.start();

  const onDiagnostic = vi.fn();
  const coordinator = new GeometryCoordinator(clientEndpoint, { onDiagnostic });

  return {
    coordinator,
    onDiagnostic,
    dispose: (): void => {
      coordinator.dispose();
      stopHost();
    },
  };
}

beforeEach(() => {
  resetOperationIdSequenceForTesting();
});

describe('request and result', () => {
  it('resolves with the value the handler produced', async () => {
    const harness = createHarness();
    const { bytes, expectedChecksum } = buildPayload(1024);

    const result = await harness.coordinator.dispatch(
      'runtime/self-test',
      { bytes, chunks: 4 },
      { transfer: [bytes] },
    ).promise;

    expect(result.byteLength).toBe(1024);
    expect(result.checksum).toBe(expectedChecksum);
    harness.dispose();
  });

  it('keeps concurrent operations separate', async () => {
    const harness = createHarness();
    const first = buildPayload(512);
    const second = buildPayload(2048);

    const [firstResult, secondResult] = await Promise.all([
      harness.coordinator.dispatch('runtime/self-test', { bytes: first.bytes, chunks: 2 }).promise,
      harness.coordinator.dispatch('runtime/self-test', { bytes: second.bytes, chunks: 3 }).promise,
    ]);

    expect(firstResult.byteLength).toBe(512);
    expect(firstResult.checksum).toBe(first.expectedChecksum);
    expect(secondResult.byteLength).toBe(2048);
    expect(secondResult.checksum).toBe(second.expectedChecksum);
    harness.dispose();
  });

  it('clears the pending entry once an operation settles', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(256);

    await harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 1 }).promise;

    expect(harness.coordinator.pendingCount).toBe(0);
    harness.dispose();
  });
});

describe('progress', () => {
  it('reports monotonic progress ending at 1', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(1024);
    const fractions: number[] = [];

    await harness.coordinator.dispatch(
      'runtime/self-test',
      { bytes, chunks: 4 },
      {
        onProgress: (update) => {
          fractions.push(update.fraction);
        },
      },
    ).promise;

    expect(fractions).toEqual([0.25, 0.5, 0.75, 1]);
    harness.dispose();
  });

  it('does not require a progress listener', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(256);

    await expect(
      harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 2 }).promise,
    ).resolves.toBeDefined();
    harness.dispose();
  });
});

describe('error transport', () => {
  it('rejects with the handler error code preserved across the boundary', async () => {
    const harness = createHarness(() =>
      Promise.reject(
        resourceLimitExceeded('Mesh exceeds the worker memory budget.', {
          limitBytes: 1024,
        }),
      ),
    );
    const { bytes } = buildPayload(64);

    const promise = harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 1 }).promise;

    await expect(promise).rejects.toMatchObject({
      code: AppErrorCode.ResourceLimitExceeded,
      details: { limitBytes: 1024 },
    });
    harness.dispose();
  });

  it('converts a handler that throws a plain Error into an internal error', async () => {
    const harness = createHarness(() => {
      throw new TypeError('cannot read properties of undefined');
    });
    const { bytes } = buildPayload(64);

    await expect(
      harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 1 }).promise,
    ).rejects.toMatchObject({ code: AppErrorCode.Internal });
    harness.dispose();
  });

  it('rejects malformed payloads rather than trusting them', async () => {
    const harness = createHarness();

    await expect(
      harness.coordinator.dispatch(
        'runtime/self-test',
        // Deliberately wrong shape, as a hostile or buggy caller would send.
        { bytes: 'not a buffer' as unknown as ArrayBuffer, chunks: 1 },
      ).promise,
    ).rejects.toMatchObject({ code: AppErrorCode.MalformedFile });
    harness.dispose();
  });

  it('rejects an out-of-range chunk count', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(64);

    await expect(
      harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 100_000 }).promise,
    ).rejects.toMatchObject({ code: AppErrorCode.MalformedFile });
    harness.dispose();
  });

  it('answers a request for an unregistered operation instead of going silent', async () => {
    // Built by hand rather than through the harness: the coordinator's typed
    // `dispatch` cannot express an unknown operation, and this asserts the
    // worker host answers a raw request it does not recognise.
    const received: unknown[] = [];
    const [client, worker] = createLinkedEndpoints();
    const host = new GeometryWorkerHost(worker);
    const stopHost = host.start();
    client.addMessageListener((message) => {
      received.push(message);
    });

    client.postMessage(
      {
        channel: PROTOCOL_CHANNEL,
        kind: 'request',
        id: 'op-999' as OperationId,
        operation: 'geometry/does-not-exist',
        payload: {},
      },
      [],
    );
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    expect(received[0]).toMatchObject({
      kind: 'error',
      id: 'op-999',
      error: { code: AppErrorCode.Internal },
    });
    stopHost();
  });
});

describe('cancellation', () => {
  it('rejects with OPERATION_CANCELLED when cancelled mid-flight', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(8192);

    const handle = harness.coordinator.dispatch(
      'runtime/self-test',
      { bytes, chunks: 64 },
      {
        onProgress: (update) => {
          if (update.fraction > 0.1) handle.cancel();
        },
      },
    );

    await expect(handle.promise).rejects.toMatchObject({
      code: AppErrorCode.OperationCancelled,
    });
    harness.dispose();
  });

  it('ignores cancellation of an operation that already finished', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(256);
    const handle = harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 1 });

    await handle.promise;

    expect(() => {
      handle.cancel();
    }).not.toThrow();
    expect(harness.onDiagnostic).not.toHaveBeenCalled();
    harness.dispose();
  });
});

describe('protocol robustness', () => {
  it('reports a message that is not part of the protocol', async () => {
    const [client, worker] = createLinkedEndpoints();
    const onDiagnostic = vi.fn();
    const coordinator = new GeometryCoordinator(client, { onDiagnostic });

    worker.postMessage({ hello: 'from somewhere else' }, []);
    await vi.waitFor(() => {
      expect(onDiagnostic).toHaveBeenCalledTimes(1);
    });

    expect(onDiagnostic.mock.calls[0]?.[0]).toContain('outside the protocol');
    coordinator.dispose();
  });

  it('reports a well-formed message for an operation it does not know', async () => {
    const [client, worker] = createLinkedEndpoints();
    const onDiagnostic = vi.fn();
    const coordinator = new GeometryCoordinator(client, { onDiagnostic });

    worker.postMessage(
      { channel: PROTOCOL_CHANNEL, kind: 'result', id: 'op-404' as OperationId, value: {} },
      [],
    );
    await vi.waitFor(() => {
      expect(onDiagnostic).toHaveBeenCalledTimes(1);
    });

    expect(onDiagnostic.mock.calls[0]?.[0]).toContain('unknown operation');
    coordinator.dispose();
  });
});

describe('teardown', () => {
  it('rejects in-flight operations on dispose rather than leaving them hanging', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(8192);

    const handle = harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 64 });
    harness.coordinator.dispose();

    await expect(handle.promise).rejects.toMatchObject({
      code: AppErrorCode.OperationCancelled,
    });
  });

  it('rejects a dispatch attempted after dispose', () => {
    const harness = createHarness();
    const { bytes } = buildPayload(64);
    harness.coordinator.dispose();

    try {
      harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 1 });
      expect.unreachable('dispatch should have thrown after dispose');
    } catch (caught) {
      expect(isAppError(caught)).toBe(true);
      if (!isAppError(caught)) return;
      expect(caught.code).toBe(AppErrorCode.Internal);
    }
  });

  it('fails every pending operation when the transport dies', async () => {
    const harness = createHarness();
    const { bytes } = buildPayload(8192);

    const handle = harness.coordinator.dispatch('runtime/self-test', { bytes, chunks: 64 });
    harness.coordinator.failAllPending(
      resourceLimitExceeded('The geometry worker was terminated.'),
    );

    await expect(handle.promise).rejects.toMatchObject({
      code: AppErrorCode.ResourceLimitExceeded,
    });
    harness.dispose();
  });
});
