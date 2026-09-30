/** A rendezvous: send resolves only when the consumer has processed the value
 * and asks for another. There is no accumulating queue. */
export interface BoundedChannel<T> extends AsyncIterable<T> {
  send(value: T): Promise<void>;
  end(): void;
  fail(cause: unknown): void;
}
export function createBoundedChannel<T>(): BoundedChannel<T> {
  let waiting:
    { resolve: (value: IteratorResult<T>) => void; reject: (cause: unknown) => void } | undefined;
  let consumed: { resolve: () => void; reject: (cause: unknown) => void } | undefined;
  let pending: { value: T } | undefined;
  let ended = false;
  let delivered = false;
  let failed = false;
  let failure = new Error('The record stream failed');
  const next = (): Promise<IteratorResult<T>> => {
    if (delivered) {
      const previous = consumed;
      consumed = undefined;
      delivered = false;
      previous?.resolve();
    }
    if (failed) return Promise.reject(failure);
    if (pending !== undefined) {
      delivered = true;
      const value = pending.value;
      pending = undefined;
      return Promise.resolve({ value, done: false });
    }
    if (ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
    });
  };
  return {
    [Symbol.asyncIterator]: () => ({ next }),
    send(value): Promise<void> {
      if (failed) return Promise.reject(failure);
      if (ended || consumed !== undefined)
        return Promise.reject(new Error('The channel must drain before reuse'));
      const ready = new Promise<void>((resolve, reject) => {
        consumed = { resolve, reject };
      });
      if (waiting === undefined) pending = { value };
      else {
        delivered = true;
        const reader = waiting;
        waiting = undefined;
        reader.resolve({ value, done: false });
      }
      return ready;
    },
    end(): void {
      ended = true;
      const reader = waiting;
      waiting = undefined;
      reader?.resolve({ value: undefined, done: true });
    },
    fail(cause): void {
      failed = true;
      failure = cause instanceof Error ? cause : new Error('The record stream failed', { cause });
      pending = undefined;
      const writer = consumed;
      consumed = undefined;
      writer?.reject(failure);
      const reader = waiting;
      waiting = undefined;
      reader?.reject(failure);
    },
  };
}
