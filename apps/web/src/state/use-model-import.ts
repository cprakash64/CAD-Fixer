import { useCallback, useRef } from 'react';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import { importStlFile, ImportPhase, type ImportSession } from '../runtime/import-service';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { ImportState, StatusSeverity, type ImportToken } from './workspace-store';

/**
 * Connects the import service to the workspace store.
 *
 * The component layer calls `importFile` and renders state. It never touches
 * buffers, never parses, and never computes anything about the mesh — all of
 * that happened in the worker before this hook sees a result.
 */

const PHASE_TO_STATE: Readonly<Record<ImportPhase, ImportState>> = {
  [ImportPhase.Screening]: ImportState.Screening,
  [ImportPhase.Reading]: ImportState.Reading,
  [ImportPhase.Parsing]: ImportState.Parsing,
  [ImportPhase.Validating]: ImportState.Validating,
  [ImportPhase.Complete]: ImportState.Ready,
};

export interface ModelImportControls {
  // Declared as function-typed properties rather than methods so they can be
  // destructured safely: a method signature carries an implicit `this`.
  readonly importFile: (file: File) => void;
  readonly cancelImport: () => void;
  readonly isImporting: boolean;
}

export function useModelImport(): ModelImportControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { importProgress } = useWorkspaceState();
  const sessionRef = useRef<ImportSession | undefined>(undefined);

  const importFile = useCallback(
    (file: File): void => {
      if (client === undefined) {
        store.pushStatus(StatusSeverity.Error, 'The geometry worker is not ready yet.');
        return;
      }

      // The previous attempt is cancelled rather than left to finish. Even so,
      // it may already be past the point where cancellation can take effect, so
      // correctness does not depend on this — the token below is what actually
      // guarantees a superseded result cannot install itself.
      sessionRef.current?.cancel();

      const token: ImportToken = store.beginImport(file.name);

      const session = importStlFile({
        file,
        client,
        callbacks: {
          onProgress: (progress) => {
            store.reportImportProgress(token, {
              state: PHASE_TO_STATE[progress.phase],
              fraction: progress.fraction,
              fileName: file.name,
              ...(progress.note === undefined ? {} : { note: progress.note }),
            });
          },
        },
      });
      sessionRef.current = session;

      session.promise.then(
        (result) => {
          // The model being replaced, captured BEFORE the commit so it can be
          // released afterwards. Releasing it earlier would break the
          // transactional guarantee: if this import had failed, the previous
          // model must still be there.
          const replaced = store.getSnapshot().model?.handle;

          const installed = store.commitImport(token, {
            handle: result.handle,
            parts: result.parts,
            render: result.render,
            bounds: result.bounds,
            triangleCount: result.triangleCount,
            vertexCount: result.vertexCount,
            validation: result.validation,
            warnings: result.warnings,
            residentBytes: result.residentBytes,
            source: {
              fileName: file.name,
              fileBytes: file.size,
              formatId: 'stl',
              encoding: result.encoding,
              unit: result.unit,
              importedAt: Date.now(),
            },
          });

          // A superseded import says nothing at all. Reporting "Loaded A" after
          // B is already on screen would describe a model the user is not
          // looking at. Its geometry is released instead, so a discarded import
          // does not leave a model resident in the worker forever.
          if (!installed) {
            client.releaseModel(result.handle.documentId).promise.catch(() => undefined);
            return;
          }

          // Commit succeeded, so the old model is genuinely superseded and its
          // worker-side memory can go.
          if (replaced !== undefined) {
            client.releaseModel(replaced.documentId).promise.catch(() => undefined);
          }

          sessionRef.current = undefined;
          store.pushStatus(
            StatusSeverity.Success,
            `Loaded ${file.name}: ${result.triangleCount.toLocaleString()} triangles (${result.encoding} STL).`,
          );
          for (const warning of result.warnings) {
            store.pushStatus(StatusSeverity.Warning, warning.message);
          }
        },
        (cause: unknown) => {
          const error = toAppError(cause);

          // `failImport` ignores a stale token, so a superseded import cannot
          // put the interface into an error state belonging to nothing, and
          // cannot disturb the model that is actually loaded.
          if (!store.failImport(token)) return;

          sessionRef.current = undefined;
          if (error.code === AppErrorCode.OperationCancelled) {
            store.pushStatus(StatusSeverity.Info, `Import of ${file.name} was cancelled.`);
          } else {
            store.pushStatus(StatusSeverity.Error, `${file.name}: ${error.message}`);
          }
        },
      );
    },
    [client, store],
  );

  const cancelImport = useCallback((): void => {
    sessionRef.current?.cancel();
  }, []);

  const isImporting =
    importProgress.state !== ImportState.Idle &&
    importProgress.state !== ImportState.Ready &&
    importProgress.state !== ImportState.Error;

  return { importFile, cancelImport, isImporting };
}
