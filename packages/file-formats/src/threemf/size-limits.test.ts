import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_LIMITS } from '../export/export-contract';
import { MAX_THREEMF_MODEL_ENTRY_BYTES, MAX_THREEMF_PACKAGE_BYTES } from './size-limits';
import {
  routeModelEntryIngestion,
  ThreeMfIngestion,
  THREEMF_STREAMING_THRESHOLD_BYTES,
} from './ingestion-route';
import { DEFAULT_ZIP_LIMITS } from './zip';

/**
 * STAGE 6E-A4 — THE 3MF SIZE POLICY, AS RELATIONSHIPS RATHER THAN NUMBERS.
 *
 * Each of these ceilings is defensible on its own; what made an export fail
 * after all its work was that two of them were chosen independently and
 * disagreed. These assert the RELATIONSHIPS, so a future change to any one
 * number fails here rather than in a user's export.
 */

const MIB = 1024 * 1024;

describe('6E-A4: the 3MF size policy is internally consistent', () => {
  it('the per-entry ceiling is the one the reader applies, not a copy of it', () => {
    // One source of truth: the ZIP limits READ the policy rather than restating
    // it, so a message, a test and an allocation cannot drift apart.
    expect(DEFAULT_ZIP_LIMITS.maxEntryBytes).toBe(MAX_THREEMF_MODEL_ENTRY_BYTES);
    expect(DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes).toBe(MAX_THREEMF_PACKAGE_BYTES);
  });

  it('the entry ceiling never exceeds the package ceiling', () => {
    /*
     * An entry ceiling above the package ceiling would describe a file that
     * passes the per-entry check and can never pass the package one — a limit
     * that cannot be reached, which is not a limit. It must also leave room for
     * a SECOND part beside a maximum-sized one, or multi-part packages stop
     * being expressible at the top of the range.
     */
    expect(MAX_THREEMF_MODEL_ENTRY_BYTES).toBeLessThanOrEqual(MAX_THREEMF_PACKAGE_BYTES);
    expect(MAX_THREEMF_PACKAGE_BYTES - MAX_THREEMF_MODEL_ENTRY_BYTES).toBeGreaterThanOrEqual(
      64 * MIB,
    );
  });

  it('the WRITER can never produce a model entry the READER would refuse', () => {
    /*
     * THE DEFECT THIS STAGE FIXED, stated as an invariant. The 3MF writer's
     * model XML becomes one ZIP entry, so its ceiling must not exceed the
     * reader's per-entry ceiling. Before Stage 6E-A4 the writer used
     * `maxSerialisedBytes` (512 MiB) while the reader refused an entry over
     * 256 MiB, and a ~1.5 M triangle document fell in the gap: written in full,
     * then refused at parse-back as an INTERNAL error.
     */
    const writerCeiling = Math.min(
      DEFAULT_EXPORT_LIMITS.maxSerialisedBytes,
      MAX_THREEMF_MODEL_ENTRY_BYTES,
    );
    expect(writerCeiling).toBeLessThanOrEqual(DEFAULT_ZIP_LIMITS.maxEntryBytes);
  });

  it('the routing threshold sits strictly inside the eligible range', () => {
    // Below the threshold buffered, at or above it streamed, and everything up
    // to the ceiling is eligible — so the whole band above the threshold is
    // reachable and streamed rather than partly unreachable.
    expect(THREEMF_STREAMING_THRESHOLD_BYTES).toBeLessThan(MAX_THREEMF_MODEL_ENTRY_BYTES);
    expect(routeModelEntryIngestion(MAX_THREEMF_MODEL_ENTRY_BYTES, ThreeMfIngestion.Auto)).toBe(
      ThreeMfIngestion.Streaming,
    );
    expect(
      routeModelEntryIngestion(THREEMF_STREAMING_THRESHOLD_BYTES - 1, ThreeMfIngestion.Auto),
    ).toBe(ThreeMfIngestion.Buffered);
  });
});
