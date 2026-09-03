import { describe, expect, it } from 'vitest';
import { CancelState, adoptSharedCancellation } from '@cadfixer/shared';
import { GeometryCoordinator } from './coordinator';
import { PROTOCOL_CHANNEL, type RequestMessage } from './protocol';
import type { MessageEndpoint } from './endpoint';

/**
 * THE CANCELLATION SIGNAL IS PER-OPERATION, and that is a correctness property
 * rather than a tidiness one.
 *
 * If two repairs shared a control word, cancelling the first would stop the
 * second — and the second is the one the user is waiting on, because they
 * changed their selection and started again. The failure would look like "repair
 * randomly cancels itself", which is close to undiagnosable from a bug report.
 *
 * These tests drive the real `GeometryCoordinator` against a recording endpoint,
 * so they assert what actually goes on the wire rather than what a mock was told
 * to return.
 */

interface Recorded {
  readonly messages: unknown[];
  readonly endpoint: MessageEndpoint;
  /** Delivers a worker-to-main message through the REAL listener. */
  deliver(message: unknown): void;
}

function recordingEndpoint(): Recorded {
  const messages: unknown[] = [];
  let listener: ((message: unknown) => void) | undefined;
  return {
    messages,
    deliver(message: unknown): void {
      listener?.(message);
    },
    endpoint: {
      postMessage(message: unknown): void {
        messages.push(message);
      },
      addMessageListener(next: (message: unknown) => void): () => void {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  };
}

function requestsIn(messages: readonly unknown[]): RequestMessage[] {
  return messages.filter(
    (message): message is RequestMessage =>
      typeof message === 'object' &&
      message !== null &&
      (message as { kind?: unknown }).kind === 'request',
  );
}

function cancelsIn(messages: readonly unknown[]): { id: string }[] {
  return messages.filter(
    (message): message is { id: string } =>
      typeof message === 'object' &&
      message !== null &&
      (message as { kind?: unknown }).kind === 'cancel',
  );
}

function coordinator(recorded: Recorded): GeometryCoordinator {
  return new GeometryCoordinator(recorded.endpoint, {
    onDiagnostic: () => undefined,
  });
}

describe('an interruptible operation carries its own shared signal', () => {
  it('puts a four-byte control word on the request envelope', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);

    runtime.dispatch('model/release', { modelId: 'model-1' }, { interruptible: true });

    const [request] = requestsIn(recorded.messages);
    expect(request?.cancellation).toBeInstanceOf(SharedArrayBuffer);
    expect(request?.cancellation?.byteLength).toBe(4);
  });

  it('omits the control word when the operation did not ask for one', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);

    runtime.dispatch('model/release', { modelId: 'model-1' });

    const [request] = requestsIn(recorded.messages);
    expect(request?.cancellation).toBeUndefined();
    // And the handle says so, so a caller can tell what kind of Cancel it has.
    expect(runtime.dispatch('model/release', { modelId: 'model-2' }).interruptible).toBe(false);
  });

  it('reports interruptibility on the handle', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);

    const handle = runtime.dispatch(
      'model/release',
      { modelId: 'model-1' },
      { interruptible: true },
    );
    expect(handle.interruptible).toBe(true);
  });
});

describe('the atomic store happens before the cancel message', () => {
  /**
   * THE ORDER IS THE WHOLE ARGUMENT. `postMessage` cannot reach a worker that is
   * inside a synchronous loop, so a `cancel()` that posted first and stored
   * second would make the flag's visibility depend on the very mechanism the
   * flag exists to bypass.
   */
  it('sets the shared word, and only then posts', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);
    const handle = runtime.dispatch(
      'model/release',
      { modelId: 'model-1' },
      { interruptible: true },
    );

    const [request] = requestsIn(recorded.messages);
    const buffer = request?.cancellation;
    expect(buffer).toBeInstanceOf(SharedArrayBuffer);
    if (buffer === undefined) return;

    // The worker's view of the same memory.
    const observed = adoptSharedCancellation(buffer);
    expect(observed.isCancelled).toBe(false);

    let flaggedWhenCancelPosted: boolean | undefined;
    const recordingPost = recorded.endpoint.postMessage.bind(recorded.endpoint);
    Object.assign(recorded.endpoint, {
      postMessage(message: unknown): void {
        if (
          typeof message === 'object' &&
          message !== null &&
          (message as { kind?: unknown }).kind === 'cancel'
        ) {
          // Sampled AT THE MOMENT the message is posted: if the store came
          // later, this would be false.
          flaggedWhenCancelPosted = observed.isCancelled;
        }
        recordingPost(message, []);
      },
    });

    handle.cancel();

    expect(flaggedWhenCancelPosted).toBe(true);
    expect(cancelsIn(recorded.messages)).toHaveLength(1);
  });
});

describe('CC09: a stale cancellation cannot reach a later operation', () => {
  it('gives each operation a distinct control word', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);

    const first = runtime.dispatch('model/release', { modelId: 'a' }, { interruptible: true });
    const second = runtime.dispatch('model/release', { modelId: 'b' }, { interruptible: true });

    const [firstRequest, secondRequest] = requestsIn(recorded.messages);
    expect(firstRequest?.cancellation).not.toBe(secondRequest?.cancellation);
    expect(first.id).not.toBe(second.id);
  });

  it('leaves the replacement operation running when the old one is cancelled', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);

    const stale = runtime.dispatch('model/release', { modelId: 'a' }, { interruptible: true });
    const live = runtime.dispatch('model/release', { modelId: 'b' }, { interruptible: true });

    const [staleRequest, liveRequest] = requestsIn(recorded.messages);
    const staleBuffer = staleRequest?.cancellation;
    const liveBuffer = liveRequest?.cancellation;
    expect(staleBuffer).toBeInstanceOf(SharedArrayBuffer);
    expect(liveBuffer).toBeInstanceOf(SharedArrayBuffer);
    if (staleBuffer === undefined || liveBuffer === undefined) return;

    stale.cancel();

    // THE ASSERTION THIS FILE EXISTS FOR.
    expect(adoptSharedCancellation(staleBuffer).isCancelled).toBe(true);
    expect(adoptSharedCancellation(liveBuffer).isCancelled).toBe(false);
    expect(new Int32Array(liveBuffer)[0]).toBe(CancelState.Active);
    void live;
  });

  it('is idempotent when the same operation is cancelled twice', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);
    const handle = runtime.dispatch('model/release', { modelId: 'a' }, { interruptible: true });
    const buffer = requestsIn(recorded.messages)[0]?.cancellation;
    if (buffer === undefined) return;

    handle.cancel();
    handle.cancel();

    expect(adoptSharedCancellation(buffer).isCancelled).toBe(true);
    // Two cancels post two messages, which the worker treats idempotently. What
    // must not happen is corruption of the word itself.
    expect(new Int32Array(buffer)[0]).toBe(CancelState.Cancelled);
  });
});

describe('cancellation signals do not outlive their operation', () => {
  /**
   * A `SharedArrayBuffer` per operation is four bytes, which is nothing — until
   * a session runs thousands of operations and keeps every one. The coordinator
   * releases the signal on the terminal message, and this is what proves it
   * rather than assuming it.
   */
  it('releases the signal when the operation resolves', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);
    const handle = runtime.dispatch('model/release', { modelId: 'a' }, { interruptible: true });

    expect(runtime.liveCancellationSignals).toBe(1);

    recorded.deliver({
      channel: PROTOCOL_CHANNEL,
      kind: 'result',
      id: handle.id,
      value: { released: true },
    });

    expect(runtime.liveCancellationSignals).toBe(0);
  });

  it('releases the signal when the operation fails', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);
    const handle = runtime.dispatch('model/release', { modelId: 'a' }, { interruptible: true });
    handle.promise.catch(() => undefined);

    recorded.deliver({
      channel: PROTOCOL_CHANNEL,
      kind: 'error',
      id: handle.id,
      error: { code: 'INTERNAL', message: 'boom', details: {} },
    });

    expect(runtime.liveCancellationSignals).toBe(0);
  });

  it('cancels and releases every signal when the runtime is disposed', () => {
    const recorded = recordingEndpoint();
    const runtime = coordinator(recorded);
    const handle = runtime.dispatch('model/release', { modelId: 'a' }, { interruptible: true });
    handle.promise.catch(() => undefined);
    const buffer = requestsIn(recorded.messages)[0]?.cancellation;

    runtime.dispose();

    expect(runtime.liveCancellationSignals).toBe(0);
    // Disposing tells the worker to stop, so a torn-down runtime does not leave
    // a worker burning a core on a result nothing will receive.
    if (buffer !== undefined) {
      expect(adoptSharedCancellation(buffer).isCancelled).toBe(true);
    }
  });
});
