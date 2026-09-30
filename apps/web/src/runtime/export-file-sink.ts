import { exportBlocked, ExportRefusal, type ExportSink } from '@cadfixer/file-formats';

export interface ExportFileDestination extends ExportSink {
  readonly name: string;
}
interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}
/** Called synchronously from the Export click, before any geometry snapshot. */
export function selectObjDestination(name: string): Promise<ExportFileDestination> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker === undefined) {
    return Promise.reject(
      exportBlocked(
        ExportRefusal.FileAccessUnavailable,
        'Large OBJ saving requires desktop Chromium file access.',
      ),
    );
  }
  return picker
    .call(window, {
      suggestedName: name,
      types: [{ description: 'OBJ model', accept: { 'model/obj': ['.obj'] } }],
    })
    .then(async (handle) => {
      const writable = await handle.createWritable({ keepExistingData: false });
      return {
        name: handle.name,
        write: async (chunk): Promise<void> => {
          await writable.write(chunk as Uint8Array<ArrayBuffer>);
        },
        close: async (): Promise<void> => {
          await writable.close();
        },
        abort: async (reason): Promise<void> => {
          await writable.abort(reason);
        },
      };
    });
}
