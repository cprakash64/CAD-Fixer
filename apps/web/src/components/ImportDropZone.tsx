import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  describeFormat,
  FILE_INPUT_ACCEPT,
  isFormatImplemented,
  screenFile,
  SUPPORTED_EXTENSIONS,
} from '@cadfixer/file-formats';
import { ImportState, StatusSeverity } from '../state/workspace-store';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useModelImport } from '../state/use-model-import';

/**
 * File intake surface.
 *
 * WHAT THIS COMPONENT DOES NOT DO: it does not read file contents, parse
 * anything, or touch a buffer. It hands a `File` to the import service, which
 * is the single place in the application that calls `arrayBuffer()`. Keeping
 * that out of components is what makes the memory behaviour of a 500 MB import
 * something you can reason about by reading one file.
 *
 * Screening by name and size still happens first, but only as a usability
 * filter — it establishes no trust. The parser in the worker is the real
 * boundary. See `@cadfixer/file-formats/screening`.
 */
export function ImportDropZone(): ReactNode {
  const store = useWorkspaceStore();
  const { importProgress, geometrySessionLost } = useWorkspaceState();
  const { importFile, cancelImport, isImporting } = useModelImport();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setDragging] = useState(false);

  const handleFiles = useCallback(
    (files: readonly File[]): void => {
      const file = files[0];
      if (file === undefined) {
        store.pushStatus(StatusSeverity.Error, 'No file was received from that drop.');
        return;
      }
      if (files.length > 1) {
        store.pushStatus(
          StatusSeverity.Info,
          `Only one model can be open at a time. Using ${file.name}.`,
        );
      }

      const screening = screenFile({ name: file.name, size: file.size });
      if (!screening.accepted) {
        store.pushStatus(StatusSeverity.Error, `${file.name}: ${screening.message}`);
        return;
      }

      // OBJ and 3MF have descriptors but no codec. Saying so plainly beats
      // starting an import that can only fail deeper in. Capability is read from
      // the declaration rather than the registry, because the registry is
      // populated inside the worker and is empty on this thread.
      if (!isFormatImplemented(screening.claimedFormat)) {
        store.pushStatus(
          StatusSeverity.Warning,
          `${describeFormat(screening.claimedFormat).label} import is not implemented yet. Only STL can be opened.`,
        );
        return;
      }

      importFile(file);
    },
    [importFile, store],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      setDragging(false);
      handleFiles([...event.dataTransfer.files]);
    },
    [handleFiles],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    // Required for the element to be a valid drop target at all.
    event.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>): void => {
    // `dragleave` also fires when the pointer crosses onto a child element, so
    // dropping the highlight unconditionally makes it flicker. Only clear it
    // when the pointer has genuinely left the zone.
    const movingTo = event.relatedTarget;
    if (movingTo instanceof Node && event.currentTarget.contains(movingTo)) return;
    setDragging(false);
  }, []);

  const percent = Math.round(importProgress.fraction * 100);

  return (
    <section className="import" aria-label="Import a model">
      <div
        className={isDragging ? 'import__zone import__zone--active' : 'import__zone'}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        data-testid="drop-zone"
      >
        <p className="import__headline">Drop an STL file here</p>
        <p className="import__detail">
          Accepted extensions: {SUPPORTED_EXTENSIONS.join(', ')} — only STL can be opened so far.
          Files are read on this device and never uploaded.
        </p>

        {/* Drag and drop is never the only route in: a file picker keeps the
            surface reachable by keyboard and by assistive technology. */}
        <button
          type="button"
          className="import__browse"
          onClick={() => inputRef.current?.click()}
          disabled={isImporting}
          data-testid="browse-button"
        >
          Choose a file
        </button>

        <input
          ref={inputRef}
          type="file"
          className="import__input"
          accept={FILE_INPUT_ACCEPT}
          data-testid="file-input"
          onChange={(event) => {
            handleFiles([...(event.target.files ?? [])]);
            // Reset so selecting the same file twice fires a change event again.
            event.target.value = '';
          }}
        />
      </div>

      {geometrySessionLost !== undefined ? (
        <p className="import__lost" role="alert" data-testid="session-lost">
          The geometry session was lost: {geometrySessionLost} The model was held in memory by that
          worker and cannot be recovered. Open the file again to continue.
        </p>
      ) : null}

      {isImporting ? (
        <div className="import__progress" data-testid="import-progress">
          <div className="import__progress-row">
            <span data-testid="import-phase">{describePhase(importProgress.state)}</span>
            <span>{percent}%</span>
          </div>
          <progress
            className="import__bar"
            max={100}
            value={percent}
            aria-label={`Import progress: ${describePhase(importProgress.state)}`}
          />
          <button
            type="button"
            className="import__cancel"
            onClick={cancelImport}
            data-testid="cancel-import"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
}

function describePhase(state: ImportState): string {
  switch (state) {
    case ImportState.Screening:
      return 'Checking file';
    case ImportState.Reading:
      return 'Reading file';
    case ImportState.Parsing:
      return 'Parsing geometry';
    case ImportState.Validating:
      return 'Validating structure';
    case ImportState.Ready:
      return 'Ready';
    case ImportState.Error:
      return 'Failed';
    case ImportState.Idle:
    default:
      return 'Idle';
  }
}
