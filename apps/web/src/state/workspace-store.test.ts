import { describe, expect, it, vi } from 'vitest';
import { SelfTestState, StatusSeverity, WorkspaceStore } from './workspace-store';
import { WorkflowId } from './workflows';

describe('WorkspaceStore', () => {
  it('starts with no model, since nothing can be imported yet', () => {
    const store = new WorkspaceStore();

    expect(store.getSnapshot().hasModel).toBe(false);
    expect(store.getSnapshot().selectedWorkflow).toBeUndefined();
  });

  it('returns a new snapshot object on change so useSyncExternalStore re-renders', () => {
    const store = new WorkspaceStore();
    const before = store.getSnapshot();

    store.pushStatus(StatusSeverity.Info, 'something happened');

    expect(store.getSnapshot()).not.toBe(before);
  });

  it('returns a stable snapshot when nothing changed, so React does not loop', () => {
    const store = new WorkspaceStore();
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const store = new WorkspaceStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.selectWorkflow(WorkflowId.Repair);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.selectWorkflow(undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('shows newest status first', () => {
    const store = new WorkspaceStore();

    store.pushStatus(StatusSeverity.Info, 'first');
    store.pushStatus(StatusSeverity.Error, 'second');

    expect(store.getSnapshot().status.map((entry) => entry.message)).toEqual(['second', 'first']);
  });

  it('bounds the status log so a long session cannot grow it without limit', () => {
    const store = new WorkspaceStore();

    for (let index = 0; index < 200; index += 1) {
      store.pushStatus(StatusSeverity.Info, `entry ${String(index)}`);
    }

    const { status } = store.getSnapshot();
    expect(status).toHaveLength(50);
    expect(status[0]?.message).toBe('entry 199');
  });

  it('gives every entry a distinct id, including duplicate messages', () => {
    const store = new WorkspaceStore();

    store.pushStatus(StatusSeverity.Info, 'same');
    store.pushStatus(StatusSeverity.Info, 'same');

    const ids = store.getSnapshot().status.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('tracks runtime self-test state', () => {
    const store = new WorkspaceStore();

    store.setRuntime({ selfTest: SelfTestState.Running, progress: 0.5, detail: 'chunk 8/16' });

    expect(store.getSnapshot().runtime).toEqual({
      selfTest: SelfTestState.Running,
      progress: 0.5,
      detail: 'chunk 8/16',
    });
  });
});
