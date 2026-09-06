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
/** One progress report, with the moment it arrived. */
interface HarnessExportPhase {
  readonly fraction: number;
  readonly note?: string;
  /** Milliseconds since the export was requested. */
  readonly at: number;
}

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
  /**
   * The progress timeline.
   *
   * What makes a responsiveness window checkable: a test can see that the
   * period it sampled reached `validating` and then `complete`, rather than
   * ending when the bytes happened to exist.
   */
  readonly phases: readonly HarnessExportPhase[];
  readonly cancelLatencyMs?: number;
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
      /** Starts an export and returns immediately, so a probe can run beside it. */
      beginExport(
        documentId: string,
        revision: number,
        target: 'obj' | '3mf',
        sourceName: string,
        options?: { readonly download?: boolean; readonly cancelAfterMs?: number },
      ): void;
      awaitExport(): Promise<HarnessExportResult>;
      cancelExport(): void;
      exportActiveOperation(): string | undefined;
      exportLiveWorkers(): number;
      exportLiveChannels(): number;

      /**
       * Boundary components of one part, as SCALARS.
       *
       * The only way a caller obtains a `boundaryLoopId` — and it carries no
       * coordinates, because a browser test needs to know an opening exists and
       * whether it is fillable, not where its vertices are.
       */
      listBoundaryLoops(
        documentId: string,
        revision: number,
        partId: string,
      ): Promise<HarnessBoundaryLoops>;
      /** Starts a fill and returns immediately, so a probe can run beside it. */
      beginHoleFill(
        documentId: string,
        revision: number,
        partId: string,
        boundaryLoopId: string,
        options?: { readonly cancelAfterMs?: number },
      ): void;
      awaitHoleFill(): Promise<HarnessHoleFillResult>;
      cancelHoleFill(): void;
      holeFillActiveOperation(): string | undefined;
      holeFillLiveWorkers(): number;
      holeFillLiveChannels(): number;
    };
  }
}

interface HarnessBoundaryLoopSummary {
  readonly boundaryLoopId: string;
  readonly vertexCount: number;
  readonly edgeCount: number;
  readonly fillable: boolean;
  readonly refusal?: string;
}

interface HarnessBoundaryLoops {
  readonly partId: string;
  readonly loopCount: number;
  readonly loops: readonly HarnessBoundaryLoopSummary[];
  readonly truncated: boolean;
}

/**
 * What a fill attempt reports back.
 *
 * A HANDLE AND SCALARS, never a mesh. The candidate stays resident in the
 * authoritative worker; the page learns its identity and what the validators
 * measured.
 */
interface HarnessHoleFillResult {
  readonly status: string;
  readonly message?: string;
  readonly candidateId?: string;
  readonly candidatePartId?: string;
  readonly candidateRevision?: number;
  readonly candidateLoopId?: string;
  readonly summary?: Record<string, number | boolean | Record<string, number>>;
  readonly durationMs: number;
  readonly cancelLatencyMs?: number;
  readonly startedFaceCount?: number;
}
