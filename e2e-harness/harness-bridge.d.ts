/**
 * The harness page's bridge, as Playwright sees it.
 *
 * ONE FUNCTION, and it returns a DIGEST — never geometry. The worker compares
 * its own authoritative bytes and sends back a hash and a length, so proving
 * "these coordinates were not rewritten" does not require making the page an
 * owner of the coordinates. See `apps/web/e2e-harness/main.tsx`.
 */
export {};

interface HarnessPartDigest {
  readonly partId: string;
  readonly meshResourceIndex: number;
  readonly transform: readonly number[];
  readonly positionBytes: number;
  readonly indexBytes: number;
  readonly positionDigest: string;
  readonly indexDigest: string;
}

/**
 * What an export attempt reports back.
 *
 * A LENGTH AND A HEAD, never the file. The bytes are the user's artifact and
 * belong in a download; a test needs to know how big it was, what format it
 * looks like, and what the writer observed about the conversion.
 */
interface HarnessExportResult {
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly byteLength?: number;
  readonly fileName?: string;
  readonly observations?: readonly string[];
  readonly triangleCount?: number;
  readonly partCount?: number;
  readonly meshResourceCount?: number;
  readonly durationMs: number;
  readonly head?: string;
  readonly progressUpdates: number;
}

declare global {
  interface Window {
    readonly cadfixerHarness?: {
      digest(
        documentId: string,
        revision: number,
      ): Promise<{
        ok: boolean;
        distinctMeshes?: number;
        parts: readonly HarnessPartDigest[];
      }>;
      exportDocument(
        documentId: string,
        revision: number,
        target: 'obj' | '3mf',
        sourceName: string,
        options?: { readonly download?: boolean; readonly cancelAfterMs?: number },
      ): Promise<HarnessExportResult>;
      cancelExport(): void;
      exportLiveWorkers(): number;
      exportLiveChannels(): number;
    };
  }
}
