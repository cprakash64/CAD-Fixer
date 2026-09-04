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
    };
  }
}
