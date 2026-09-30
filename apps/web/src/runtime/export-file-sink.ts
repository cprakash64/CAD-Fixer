import { exportBlocked, ExportRefusal, type ExportSink } from '@cadfixer/file-formats';

export interface ExportFileDestination extends ExportSink {
  readonly name: string;
  readonly operationId?: string;
}
interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}
export interface ObjTarget {
  readonly handle: FileSystemFileHandle;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
}
export function objFileName(value: string): string {
  if (value.trim() === '' || value === '.' || value === '..' || /[/\\\0]/u.test(value)) {
    throw new TypeError('Enter a filename without directory separators.');
  }
  return /\.obj$/iu.test(value) ? value : `${value}.obj`;
}
/** Invoke directly in the click handler, before any await. */
export function chooseObjDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (picker === undefined) {
    return Promise.reject(
      exportBlocked(
        ExportRefusal.FileAccessUnavailable,
        'Large OBJ saving requires desktop Chromium file access.',
      ),
    );
  }
  return picker.call(window, { mode: 'readwrite' });
}
function notFound(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'NotFoundError';
}
export async function lookupObjTarget(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<ObjTarget | undefined> {
  try {
    const handle = await directory.getFileHandle(objFileName(name), { create: false });
    const file = await handle.getFile();
    return { handle, name: file.name, size: file.size, lastModified: file.lastModified };
  } catch (cause) {
    if (notFound(cause)) return undefined;
    throw cause;
  }
}
async function sameTarget(a: ObjTarget | undefined, b: ObjTarget | undefined): Promise<boolean> {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.name === b.name &&
    a.size === b.size &&
    a.lastModified === b.lastModified &&
    (await a.handle.isSameEntry(b.handle))
  );
}
export interface ObjDestinationRequest {
  readonly operationId?: string;
  readonly directory: Promise<FileSystemDirectoryHandle>;
  readonly name: string;
  readonly signal: AbortSignal;
  readonly confirm: (target: ObjTarget) => Promise<boolean>;
}
/** No geometry or output buffers. Creation is delayed until the writable is needed. */
export async function selectObjDestination(
  request: ObjDestinationRequest,
): Promise<ExportFileDestination> {
  const operationId = request.operationId ?? crypto.randomUUID();
  const name = objFileName(request.name);
  const directory = await request.directory;
  const check = (): void => {
    request.signal.throwIfAborted();
  };
  check();
  let target = await lookupObjTarget(directory, name);
  // Confirmation never authorizes different metadata or a different entry.
  for (;;) {
    check();
    if (target !== undefined && !(await request.confirm(target))) {
      throw new DOMException('Overwrite cancelled.', 'AbortError');
    }
    check();
    const latest = await lookupObjTarget(directory, name);
    check();
    if (!(await sameTarget(target, latest))) {
      target = latest;
      continue;
    }
    break;
  }
  let created: (ObjTarget & { readonly operationId: string }) | undefined;
  let committed = false;
  let stream: FileSystemWritableFileStream | undefined;
  let aborting: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (created?.operationId !== operationId || committed) return;
    const latest = await lookupObjTarget(directory, name);
    // isSameEntry alone may identify a path reused by an external application.
    // A changed size or timestamp always forfeits cleanup ownership.
    if (await sameTarget(created, latest)) await directory.removeEntry(name);
  };
  const abort = (reason?: unknown): Promise<void> => {
    aborting ??= (async (): Promise<void> => {
      if (committed) return;
      let abortError: unknown;
      try {
        await stream?.abort(reason);
      } catch (cause) {
        abortError = cause;
      }
      await cleanup();
      if (abortError !== undefined)
        throw abortError instanceof Error
          ? abortError
          : new Error('The native writable could not be aborted.');
    })();
    return aborting;
  };
  try {
    let handle = target?.handle;
    if (handle === undefined) {
      // Immediate second absent check, then creation: the API has no exclusive-create flag.
      const appeared = await lookupObjTarget(directory, name);
      check();
      if (appeared !== undefined) return await selectObjDestination({ ...request, operationId });
      const beforeCreation = Date.now();
      handle = await directory.getFileHandle(name, { create: true });
      const file = await handle.getFile();
      if (file.size !== 0 || file.lastModified < beforeCreation) {
        // Evidence of an existing target returned by non-atomic creation. Never claim ownership.
        return await selectObjDestination({ ...request, operationId });
      }
      created = {
        operationId,
        handle,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
      };
    }
    check();
    if (typeof handle.createWritable !== 'function') {
      throw exportBlocked(
        ExportRefusal.FileAccessUnavailable,
        'Large OBJ saving requires desktop Chromium file access.',
      );
    }
    // lib.dom still omits the documented native locking option. A typed variable
    // preserves it without changing the platform declarations.
    const options = { keepExistingData: false, mode: 'exclusive' as const };
    stream = await handle.createWritable(options);
    check();
    // Unsupported engines may silently ignore dictionary members. Verify the
    // requested lock before starting a worker; no data is written by the probe.
    let second: FileSystemWritableFileStream | undefined;
    try {
      second = await handle.createWritable(options);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'NoModificationAllowedError'))
        throw cause;
    }
    if (second !== undefined) {
      await second.abort();
      throw exportBlocked(
        ExportRefusal.FileAccessUnavailable,
        'Large OBJ saving requires desktop Chromium exclusive file access.',
      );
    }
    check();
    // Recheck after acquiring the lock as well: acquisition does not authorize a metadata race.
    const locked = await lookupObjTarget(directory, name);
    if (!(await sameTarget(target ?? created, locked))) {
      await abort();
      return await selectObjDestination({ ...request, operationId });
    }
    const writable = stream;
    return {
      name,
      operationId,
      write: async (chunk): Promise<void> => {
        check();
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
      },
      close: async (): Promise<void> => {
        check();
        await writable.close();
        committed = true;
      },
      abort,
    };
  } catch (cause) {
    await abort(cause);
    throw cause;
  }
}
