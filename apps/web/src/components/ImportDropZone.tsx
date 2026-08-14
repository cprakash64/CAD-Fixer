import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  FILE_INPUT_ACCEPT,
  screenFile,
  SUPPORTED_EXTENSIONS,
  type FileScreeningResult,
} from '@cadfixer/file-formats';
import { StatusSeverity } from '../state/workspace-store';
import { useWorkspaceStore } from '../state/store-context';

/**
 * File intake surface.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 * 1. It never reads file contents. Only `name` and `size` are touched — the
 *    properties the browser already exposes without opening the file. There is
 *    no `FileReader`, no `arrayBuffer()`, and no network call anywhere in this
 *    component or anything it imports.
 * 2. It never reports success. Screening a filename is not importing a model.
 *    A file with a supported extension is acknowledged and then explicitly
 *    refused as not implemented, because no parser exists.
 *
 * Screening here is a usability filter, not a security boundary. See
 * `@cadfixer/file-formats/screening`.
 */
export function ImportDropZone(): ReactNode {
  const store = useWorkspaceStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setDragging] = useState(false);

  const reportScreening = useCallback(
    (fileName: string, result: FileScreeningResult): void => {
      if (!result.accepted) {
        store.pushStatus(StatusSeverity.Error, `${fileName}: ${result.message}`);
        return;
      }
      // Screening passed. That is not an import, and saying so would be a lie.
      store.pushStatus(
        StatusSeverity.Warning,
        `${fileName} looks like a supported ${result.claimedFormat.toUpperCase()} file, but importing models is not implemented yet.`,
      );
    },
    [store],
  );

  const handleFiles = useCallback(
    (files: readonly File[]): void => {
      if (files.length === 0) {
        store.pushStatus(StatusSeverity.Error, 'No file was received from that drop.');
        return;
      }
      for (const file of files) {
        reportScreening(file.name, screenFile({ name: file.name, size: file.size }));
      }
    },
    [reportScreening, store],
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

  return (
    <section className="import" aria-label="Import a model">
      <div
        className={isDragging ? 'import__zone import__zone--active' : 'import__zone'}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        data-testid="drop-zone"
      >
        <p className="import__headline">Drop a model here</p>
        <p className="import__detail">
          Accepted extensions: {SUPPORTED_EXTENSIONS.join(', ')}. Files are screened by name only
          and never leave this device.
        </p>
        <button
          type="button"
          className="import__browse"
          onClick={() => inputRef.current?.click()}
          data-testid="browse-button"
        >
          Choose a file
        </button>
        <input
          ref={inputRef}
          type="file"
          className="import__input"
          accept={FILE_INPUT_ACCEPT}
          multiple
          data-testid="file-input"
          onChange={(event) => {
            handleFiles([...(event.target.files ?? [])]);
            // Reset so selecting the same file twice fires a change event again.
            event.target.value = '';
          }}
        />
      </div>
    </section>
  );
}
