import { describe, expect, it, vi } from 'vitest';
import { lookupObjTarget, objFileName, selectObjDestination } from './export-file-sink';

function fixture(initial?: string): {
  directory: FileSystemDirectoryHandle;
  bytes: () => string | undefined;
  options: object[];
  change: (value: string) => void;
  fail: (step: string) => void;
  acquire: (
    confirm?: () => Promise<boolean>,
    signal?: AbortSignal,
  ) => ReturnType<typeof selectObjDestination>;
} {
  let contents = initial;
  let modified = initial === undefined ? 0 : 1;
  let locked = false;
  let failure = '';
  const options: object[] = [];
  const handle = {
    name: 'mesh.obj',
    isSameEntry: (other: unknown): Promise<boolean> => Promise.resolve(other === handle),
    getFile: (): Promise<File> => {
      if (contents === undefined)
        return Promise.reject(new DOMException('absent', 'NotFoundError'));
      return Promise.resolve(new File([contents], 'mesh.obj', { lastModified: modified }));
    },
    createWritable: (configuration: object): Promise<unknown> => {
      options.push(configuration);
      if (locked) return Promise.reject(new DOMException('locked', 'NoModificationAllowedError'));
      if (failure === 'permission')
        return Promise.reject(new DOMException('denied', 'NotAllowedError'));
      locked = true;
      let staged = '';
      return Promise.resolve({
        write: (chunk: Uint8Array): Promise<void> => {
          if (failure === 'write') return Promise.reject(new Error('write failed'));
          staged += new TextDecoder().decode(chunk);
          return Promise.resolve();
        },
        close: (): Promise<void> => {
          if (failure === 'close') return Promise.reject(new Error('close failed'));
          contents = staged;
          modified += 1;
          locked = false;
          return Promise.resolve();
        },
        abort: (): Promise<void> => {
          locked = false;
          return Promise.resolve();
        },
      });
    },
  };
  const directory = {
    name: 'folder',
    getFileHandle: (_name: string, configuration: { create: boolean }): Promise<unknown> => {
      if (contents === undefined && !configuration.create)
        return Promise.reject(new DOMException('absent', 'NotFoundError'));
      if (contents === undefined) {
        contents = '';
        modified = Date.now();
      }
      return Promise.resolve(handle);
    },
    removeEntry: (): Promise<void> => {
      contents = undefined;
      return Promise.resolve();
    },
  } as unknown as FileSystemDirectoryHandle;
  return {
    directory,
    bytes: () => contents,
    options,
    change: (value): void => {
      contents = value;
      modified += 1;
    },
    fail: (step): void => {
      failure = step;
    },
    acquire: (
      confirm = (): Promise<boolean> => Promise.resolve(true),
      signal = new AbortController().signal,
    ) =>
      selectObjDestination({
        directory: Promise.resolve(directory),
        name: 'mesh.obj',
        signal,
        confirm,
      }),
  };
}
const encoded = new TextEncoder().encode('validated output');
describe('directory destination transactions', () => {
  it('rejects invalid names and preserves Unicode and the OBJ extension', () => {
    for (const name of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a\0b'])
      expect(() => objFileName(name)).toThrow();
    expect(objFileName('模型')).toBe('模型.obj');
    expect(objFileName('模型.OBJ')).toBe('模型.OBJ');
  });
  it('lookup does not create a new target or open an existing writable', async () => {
    const absent = fixture();
    expect(await lookupObjTarget(absent.directory, 'mesh')).toBeUndefined();
    expect(absent.bytes()).toBeUndefined();
    const existing = fixture('sentinel');
    expect(await lookupObjTarget(existing.directory, 'mesh')).toMatchObject({
      size: 8,
      lastModified: 1,
    });
    expect(existing.options).toEqual([]);
    expect(existing.bytes()).toBe('sentinel');
  });
  it('directory cancellation creates no output', async () => {
    await expect(
      selectObjDestination({
        directory: Promise.reject(new DOMException('cancel', 'AbortError')),
        name: 'mesh',
        signal: new AbortController().signal,
        confirm: () => Promise.resolve(true),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('declining overwrite preserves the existing target without a writable', async () => {
    const f = fixture('sentinel');
    await expect(f.acquire(() => Promise.resolve(false))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.bytes()).toBe('sentinel');
    expect(f.options).toEqual([]);
  });
  it.each(['cancel', 'write', 'close'])('preserves existing bytes on %s', async (fault) => {
    const f = fixture('sentinel');
    const destination = await f.acquire();
    f.fail(fault);
    if (fault === 'write') await expect(destination.write(encoded)).rejects.toThrow('write failed');
    else await destination.write(encoded);
    if (fault === 'close') await expect(destination.close()).rejects.toThrow('close failed');
    await destination.abort();
    expect(f.bytes()).toBe('sentinel');
  });
  it.each(['cancel', 'write', 'close', 'permission'])(
    'removes its owned new placeholder on %s',
    async (fault) => {
      const f = fixture();
      f.fail(fault);
      if (fault === 'permission')
        await expect(f.acquire()).rejects.toMatchObject({ name: 'NotAllowedError' });
      else {
        const destination = await f.acquire();
        if (fault === 'write') await expect(destination.write(encoded)).rejects.toThrow();
        else await destination.write(encoded);
        if (fault === 'close') await expect(destination.close()).rejects.toThrow();
        await destination.abort();
      }
      expect(f.bytes()).toBeUndefined();
    },
  );
  it('successful close is the only commit point and abort after success retains output', async () => {
    const original = 'sentinel'.repeat(1000);
    const f = fixture(original);
    const destination = await f.acquire();
    await destination.write(encoded);
    expect(f.bytes()).toBe(original);
    expect(f.options).toEqual([
      { keepExistingData: false, mode: 'exclusive' },
      { keepExistingData: false, mode: 'exclusive' },
    ]);
    await destination.close();
    await destination.abort();
    expect(f.bytes()).toBe('validated output');
  });
  it('reconfirms metadata changed during confirmation', async () => {
    const f = fixture('sentinel');
    const confirm = vi.fn((): Promise<boolean> => {
      if (confirm.mock.calls.length === 1) f.change('replacement');
      return Promise.resolve(true);
    });
    const destination = await f.acquire(confirm);
    expect(confirm).toHaveBeenCalledTimes(2);
    await destination.abort();
    expect(f.bytes()).toBe('replacement');
  });
  it.each([2, 4])('reclassifies an absent target appearing at lookup %s', async (appearance) => {
    const f = fixture();
    const get = f.directory.getFileHandle.bind(f.directory);
    let calls = 0;
    f.directory.getFileHandle = async (name, options): Promise<FileSystemFileHandle> => {
      calls += 1;
      if (calls === appearance) f.change('racing existing file');
      return await get(name, options);
    };
    const confirm = vi.fn(() => Promise.resolve(true));
    const destination = await f.acquire(confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    await destination.abort();
    expect(f.bytes()).toBe('racing existing file');
  });
  it('rejects a browser that ignores the exclusive option before writing', async () => {
    const f = fixture('sentinel');
    const handle = await f.directory.getFileHandle('mesh.obj');
    handle.createWritable = (): Promise<FileSystemWritableFileStream> =>
      Promise.resolve({
        abort: (): Promise<void> => Promise.resolve(),
      } as FileSystemWritableFileStream);
    await expect(f.acquire()).rejects.toThrow('exclusive file access');
    expect(f.bytes()).toBe('sentinel');
  });

  it('rejects a second exclusive writer without touching the first transaction', async () => {
    const f = fixture('sentinel');
    const first = await f.acquire();
    await expect(f.acquire()).rejects.toMatchObject({ name: 'NoModificationAllowedError' });
    await first.write(encoded);
    await first.close();
    expect(f.bytes()).toBe('validated output');
  });
  it('does not remove a new target externally modified before abort', async () => {
    const f = fixture();
    const destination = await f.acquire();
    f.change('external replacement');
    await destination.abort();
    expect(f.bytes()).toBe('external replacement');
  });
  it('retains a committed new target even if abort is called afterward', async () => {
    const f = fixture();
    const destination = await f.acquire();
    await destination.write(encoded);
    await destination.close();
    await destination.abort();
    expect(f.bytes()).toBe('validated output');
  });
  it('preserves a replacement entry with equal metadata but different identity', async () => {
    const f = fixture();
    const destination = await f.acquire();
    const owned = await f.directory.getFileHandle('mesh.obj');
    const replacement: FileSystemFileHandle = {
      kind: 'file',
      name: owned.name,
      getFile: owned.getFile.bind(owned),
      createWritable: owned.createWritable.bind(owned),
      createSyncAccessHandle: () => owned.createSyncAccessHandle(),
      isSameEntry: (other): Promise<boolean> => Promise.resolve(other === replacement),
    };
    f.directory.getFileHandle = (): Promise<FileSystemFileHandle> => Promise.resolve(replacement);
    await destination.abort();
    expect(f.bytes()).toBe('');
  });
  it('stale acquisition aborts before creation', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.acquire(undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.bytes()).toBeUndefined();
  });
});
