import { describe, expect, it, vi } from 'vitest';
import { CancellationSource, uncancellable } from './cancellation';

describe('CancellationSource', () => {
  it('starts uncancelled and flips exactly once', () => {
    const source = new CancellationSource();
    const listener = vi.fn();
    source.token.onCancelled(listener);

    expect(source.token.isCancelled).toBe(false);

    source.cancel();
    source.cancel();

    expect(source.token.isCancelled).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies a listener immediately when cancellation already happened', () => {
    const source = new CancellationSource();
    source.cancel();
    const listener = vi.fn();

    source.token.onCancelled(listener);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not call a listener that unsubscribed first', () => {
    const source = new CancellationSource();
    const listener = vi.fn();
    const unsubscribe = source.token.onCancelled(listener);

    unsubscribe();
    source.cancel();

    expect(listener).not.toHaveBeenCalled();
  });

  it('survives a listener that unsubscribes another listener during notification', () => {
    const source = new CancellationSource();
    const second = vi.fn();
    const unsubscribeSecond = source.token.onCancelled(second);
    source.token.onCancelled(() => {
      unsubscribeSecond();
    });

    expect(() => {
      source.cancel();
    }).not.toThrow();
  });

  it('does not expose cancel through the token', () => {
    const source = new CancellationSource();
    expect(Object.keys(source.token)).not.toContain('cancel');
  });
});

describe('uncancellable', () => {
  it('never reports cancellation', () => {
    const listener = vi.fn();
    uncancellable.onCancelled(listener);

    expect(uncancellable.isCancelled).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
