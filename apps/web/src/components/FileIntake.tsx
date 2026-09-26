import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import {
  describeFormat,
  FILE_INPUT_ACCEPT,
  IMPLEMENTED_FORMATS,
  isFormatImplemented,
  screenFile,
} from '@cadfixer/file-formats';
import { StatusSeverity } from '../state/workspace-store';
import { useWorkspaceStore } from '../state/store-context';
import { useModelImport } from '../state/use-model-import';

/**
 * The single route by which a file enters the application.
 *
 * There are two ways in — the top bar's Open button and a drop onto the
 * viewport — and ONE handler behind both, so screening, the one-file rule and
 * the capability gate cannot drift apart between them. There is also exactly
 * one `<input type="file">`, rendered here.
 *
 * WHAT THIS DOES NOT DO: it does not read file contents, parse anything, or
 * touch a buffer. It hands a `File` to the import service, which is the single
 * place in the application that calls `arrayBuffer()`. Keeping that out of
 * components is what makes the memory behaviour of a 500 MB import something
 * you can reason about by reading one file.
 *
 * Screening by name and size still happens first, but only as a usability
 * filter — it establishes no trust. The parser in the worker is the real
 * boundary. See `@cadfixer/file-formats/screening`.
 */
export interface FileIntake {
  /** Opens the platform file picker. */
  readonly openPicker: () => void;
  /** Screens and imports the first of `files`. */
  readonly handleFiles: (files: readonly File[]) => void;
  readonly isImporting: boolean;
  readonly cancelImport: () => void;
}

const FileIntakeContext = createContext<FileIntake | undefined>(undefined);

export function FileIntakeProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const store = useWorkspaceStore();
  const { importFile, cancelImport, isImporting } = useModelImport();
  const inputRef = useRef<HTMLInputElement>(null);

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

      /*
       * A DESCRIPTOR IS NOT A CODEC.
       *
       * STL, OBJ and 3MF all have readers as of Stage 4A-2B1, so this gate does
       * not fire today — and it stays, because the next format to get a
       * descriptor will reach here before its codec does. Saying so plainly
       * beats starting an import that can only fail deeper in.
       *
       * Capability is read from the declaration rather than from the registry,
       * because codecs register inside the worker and the registry is
       * legitimately empty on this thread.
       */
      if (!isFormatImplemented(screening.claimedFormat)) {
        store.pushStatus(
          StatusSeverity.Warning,
          `${describeFormat(screening.claimedFormat).label} import is not implemented yet. ` +
            `CAD Fixer can open ${describeImplementedFormats()}.`,
        );
        return;
      }

      importFile(file);
    },
    [importFile, store],
  );

  const openPicker = useCallback((): void => {
    inputRef.current?.click();
  }, []);

  const value = useMemo<FileIntake>(
    () => ({ openPicker, handleFiles, isImporting, cancelImport }),
    [cancelImport, handleFiles, isImporting, openPicker],
  );

  return (
    <FileIntakeContext.Provider value={value}>
      {children}
      <input
        ref={inputRef}
        type="file"
        className="file-intake__input"
        accept={FILE_INPUT_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        data-testid="file-input"
        onChange={(event) => {
          handleFiles([...(event.target.files ?? [])]);
          // Reset so selecting the same file twice fires a change event again.
          event.target.value = '';
        }}
      />
    </FileIntakeContext.Provider>
  );
}

export function useFileIntake(): FileIntake {
  const intake = useContext(FileIntakeContext);
  if (intake === undefined) {
    throw new Error('useFileIntake must be used inside <FileIntakeProvider>.');
  }
  return intake;
}

/** The formats this build can actually open, for a message that stays true. */
export function describeImplementedFormats(): string {
  const labels = IMPLEMENTED_FORMATS.map((formatId) => describeFormat(formatId).label);
  if (labels.length <= 1) return labels[0] ?? 'no formats';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
}
