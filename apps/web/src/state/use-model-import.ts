import { useCallback, useRef } from 'react';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import { importStlFile, ImportPhase, type ImportSession } from '../runtime/import-service';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { ImportState, StatusSeverity } from './workspace-store';

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

      // A second import while one is running replaces it. The in-flight one is
      // cancelled rather than left to finish and overwrite the newer result.
      sessionRef.current?.cancel();

      const session = importStlFile({
        file,
        client,
        callbacks: {
          onProgress: (progress) => {
            store.setImportProgress({
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
          if (sessionRef.current !== session) return;
          sessionRef.current = undefined;

          store.setModel({
            mesh: result.mesh,
            renderNormals: result.renderNormals,
            bounds: result.bounds,
            triangleCount: result.triangleCount,
            vertexCount: result.vertexCount,
            validation: result.validation,
            warnings: result.warnings,
            source: {
              fileName: file.name,
              fileBytes: file.size,
              formatId: 'stl',
              encoding: result.encoding,
              importedAt: Date.now(),
            },
          });

          store.pushStatus(
            StatusSeverity.Success,
            `Loaded ${file.name}: ${result.triangleCount.toLocaleString()} triangles (${result.encoding} STL).`,
          );
          for (const warning of result.warnings) {
            store.pushStatus(StatusSeverity.Warning, warning.message);
          }
        },
        (cause: unknown) => {
          if (sessionRef.current !== session) return;
          sessionRef.current = undefined;

          const error = toAppError(cause);

          // A failed or cancelled import must not disturb the model already
          // loaded. `failImport` deliberately leaves `model` alone.
          store.failImport();

          if (error.code === AppErrorCode.OperationCancelled) {
            store.pushStatus(StatusSeverity.Info, `Import of ${file.name} was cancelled.`);
          } else {
            store.pushStatus(StatusSeverity.Error, `${file.name}: ${error.message}`);
          }
          store.resetImportProgress();
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
