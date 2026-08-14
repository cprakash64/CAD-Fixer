import { useCallback, useRef, type ReactNode } from 'react';
import { toAppError } from '@cadfixer/shared';
import type { OperationHandle } from '@cadfixer/geometry-runtime';
import { useGeometryClient } from '../runtime/client-context';
import { SelfTestState, StatusSeverity } from '../state/workspace-store';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';

/**
 * Runtime diagnostics.
 *
 * The self-test is a diagnostic, not a geometry feature and not a stand-in for
 * one. It proves the worker boundary actually functions in a real browser:
 * module worker startup, buffer transfer out and back, chunked progress, and
 * cancellation. The expected checksum is computed on the main thread BEFORE the
 * buffer is transferred, so the comparison is a genuine round-trip integrity
 * check rather than the worker marking its own work.
 *
 * It also reports `crossOriginIsolated`, which determines whether multithreaded
 * WebAssembly will be available later.
 */

const SELF_TEST_BYTES = 256 * 1024;
const SELF_TEST_CHUNKS = 16;

function buildSelfTestBuffer(): { buffer: ArrayBuffer; expectedChecksum: number } {
  const buffer = new ArrayBuffer(SELF_TEST_BYTES);
  const view = new Uint8Array(buffer);
  let expectedChecksum = 0;
  for (let index = 0; index < view.length; index += 1) {
    const value = index % 251;
    view[index] = value;
    expectedChecksum = (expectedChecksum + value) >>> 0;
  }
  return { buffer, expectedChecksum };
}

export function RuntimePanel(): ReactNode {
  const store = useWorkspaceStore();
  const { runtime } = useWorkspaceState();
  const handleRef = useRef<OperationHandle<unknown> | undefined>(undefined);
  // The shared worker, not a second one: spinning up another worker here would
  // mean a second copy of the parser resident for a diagnostic button.
  const client = useGeometryClient();

  const runSelfTest = useCallback((): void => {
    if (client === undefined) return;

    const { buffer, expectedChecksum } = buildSelfTestBuffer();
    store.setRuntime({ selfTest: SelfTestState.Running, progress: 0 });

    const handle = client.runSelfTest(buffer, SELF_TEST_CHUNKS, (update) => {
      store.setRuntime({
        selfTest: SelfTestState.Running,
        progress: update.fraction,
        ...(update.note === undefined ? {} : { detail: update.note }),
      });
    });
    handleRef.current = handle;

    handle.promise.then(
      (result) => {
        handleRef.current = undefined;
        const checksumMatches = result.checksum === expectedChecksum;
        const sizeMatches = result.byteLength === SELF_TEST_BYTES;

        if (checksumMatches && sizeMatches) {
          store.setRuntime({ selfTest: SelfTestState.Passed, progress: 1 });
          store.pushStatus(
            StatusSeverity.Success,
            `Worker self-test passed: ${String(SELF_TEST_BYTES)} bytes transferred and returned intact.`,
          );
          return;
        }

        store.setRuntime({ selfTest: SelfTestState.Failed, progress: 1 });
        store.pushStatus(
          StatusSeverity.Error,
          'Worker self-test failed: the returned buffer did not match what was sent.',
        );
      },
      (cause: unknown) => {
        handleRef.current = undefined;
        const error = toAppError(cause);
        store.setRuntime({ selfTest: SelfTestState.Failed, progress: 0 });
        store.pushStatus(StatusSeverity.Error, `Worker self-test failed: ${error.message}`);
      },
    );
  }, [client, store]);

  const cancelSelfTest = useCallback((): void => {
    handleRef.current?.cancel();
  }, []);

  const isRunning = runtime.selfTest === SelfTestState.Running;
  const isolated = globalThis.crossOriginIsolated;

  return (
    <section className="runtime" aria-label="Runtime diagnostics">
      <h2 className="runtime__heading">Runtime</h2>

      <dl className="runtime__facts">
        <div className="runtime__fact">
          <dt>Cross-origin isolated</dt>
          <dd data-testid="isolation-state">{isolated ? 'yes' : 'no'}</dd>
        </div>
        <div className="runtime__fact">
          <dt>Geometry worker</dt>
          <dd data-testid="self-test-state">{runtime.selfTest}</dd>
        </div>
      </dl>

      <div className="runtime__actions">
        <button
          type="button"
          className="runtime__run"
          onClick={runSelfTest}
          disabled={isRunning}
          data-testid="run-self-test"
        >
          Run worker self-test
        </button>
        <button
          type="button"
          className="runtime__cancel"
          onClick={cancelSelfTest}
          disabled={!isRunning}
          data-testid="cancel-self-test"
        >
          Cancel
        </button>
      </div>

      {isRunning ? (
        <>
          <progress
            className="runtime__progress"
            max={1}
            value={runtime.progress}
            data-testid="self-test-progress"
          />
          {runtime.detail === undefined ? null : (
            <p className="runtime__detail" data-testid="self-test-detail">
              {runtime.detail}
            </p>
          )}
        </>
      ) : null}

      <p className="runtime__note">
        A diagnostic that exercises the worker boundary. It performs no geometry work.
      </p>
    </section>
  );
}
