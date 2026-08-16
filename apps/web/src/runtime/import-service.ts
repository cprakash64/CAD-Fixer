import { operationCancelled, unsupportedFile } from '@cadfixer/shared';
import { screenFile } from '@cadfixer/file-formats';
import type { ModelImportResult } from '@cadfixer/geometry-runtime';
import type { GeometryClient } from './geometry-client';

/**
 * The one and only path from a user's file to a parsed model.
 *
 * WHY THIS EXISTS AS A SERVICE: `file.arrayBuffer()` is called in exactly one
 * place in the entire application — here. Scattering it through components
 * would make it impossible to reason about how many copies of a 500 MB model
 * are alive at once, and would put the decision of what gets transferred where
 * next to a button handler.
 *
 * MEMORY BEHAVIOUR, precisely:
 *
 *   1. `file.arrayBuffer()` allocates ONE buffer holding the whole file. This is
 *      unavoidable on the main thread today: `File` is a main-thread handle, and
 *      the alternative — passing the `File` itself into the worker and reading
 *      it there — would drag DOM types into the geometry packages. It is
 *      revisitable if measurements justify it; see docs/PERFORMANCE_BASELINE.md.
 *   2. That buffer is TRANSFERRED to the worker, not copied. From the moment
 *      `dispatch` returns, the main thread's view is detached and reading it
 *      throws. Nothing here retains a reference to it afterwards.
 *   3. The worker KEEPS the parsed geometry and returns a handle plus a render
 *      snapshot, transferred rather than cloned. The main thread never holds the
 *      authoritative mesh at all.
 *
 * Peak main-thread memory is therefore one file buffer OR one render snapshot,
 * never the canonical mesh as well.
 */

export const ImportPhase = {
  Screening: 'screening',
  Reading: 'reading',
  Parsing: 'parsing',
  Validating: 'validating',
  Complete: 'complete',
} as const;

export type ImportPhase = (typeof ImportPhase)[keyof typeof ImportPhase];

export interface ImportProgress {
  readonly phase: ImportPhase;
  /** 0..1 across the whole import, not just the current phase. */
  readonly fraction: number;
  readonly note?: string;
}

export interface ImportCallbacks {
  onProgress?(progress: ImportProgress): void;
}

export interface ImportSession {
  readonly promise: Promise<ModelImportResult>;
  /** Cooperative. Safe to call at any point, including before the read starts. */
  cancel(): void;
}

export interface ImportRequest {
  readonly file: File;
  readonly client: GeometryClient;
  readonly callbacks?: ImportCallbacks;
  /** Limit overrides. May only lower the worker's defaults. */
  readonly budget?: Readonly<Record<string, number>>;
}

export function importStlFile(request: ImportRequest): ImportSession {
  const { file, client, callbacks } = request;

  let cancelled = false;
  let dispatchCancel: (() => void) | undefined;

  // Read through a function rather than directly. The flag is set from
  // `cancel()` but read inside `run()`, and TypeScript's control-flow analysis
  // cannot see across that boundary: after the first `if (cancelled)` it would
  // treat every later check as provably false and the compiler would be wrong.
  // A call is not narrowed, so each check re-reads the current value.
  const isCancelled = (): boolean => cancelled;

  const report = (phase: ImportPhase, fraction: number, note?: string): void => {
    callbacks?.onProgress?.(note === undefined ? { phase, fraction } : { phase, fraction, note });
  };

  const run = async (): Promise<ModelImportResult> => {
    report(ImportPhase.Screening, 0);

    // Filename and declared size only. This is the same usability filter the
    // drop zone applies; it reads no bytes and confers no trust. The parser in
    // the worker is the real boundary.
    const screening = screenFile({ name: file.name, size: file.size });
    if (!screening.accepted) {
      throw unsupportedFile(screening.message, { reason: screening.reason });
    }
    if (isCancelled()) throw operationCancelled();

    report(ImportPhase.Reading, 0.02);
    const buffer = await file.arrayBuffer();
    if (isCancelled()) throw operationCancelled();

    report(ImportPhase.Parsing, 0.05);

    const handle = client.importModel(
      buffer,
      (update) => {
        const phase = update.fraction >= 0.85 ? ImportPhase.Validating : ImportPhase.Parsing;
        // The worker's 0..1 maps onto the remaining 95% of the overall bar, so
        // progress never jumps backwards when the phase changes.
        report(phase, 0.05 + update.fraction * 0.95, update.note);
      },
      request.budget,
    );

    dispatchCancel = (): void => {
      handle.cancel();
    };
    if (isCancelled()) handle.cancel();

    const result = await handle.promise;
    report(ImportPhase.Complete, 1);
    return result;
  };

  return {
    promise: run(),
    cancel(): void {
      cancelled = true;
      dispatchCancel?.();
    },
  };
}
