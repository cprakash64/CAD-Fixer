import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
// The estimator lives with the engine; the ceiling lives here. The preflight is
// the place they meet, so the test exercises both together rather than
// hard-coding a byte count that would drift from the algorithms.
import { estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  checkExportPeak,
  checkImportPeak,
  checkResident,
  DEFAULT_SESSION_MEMORY_BUDGET,
  estimateExportPeak,
  estimateImportPeak,
  renderBytesFor,
  requestAnalysisWorkspace,
  residentBytesFor,
} from './memory-budget';

/**
 * The session budget exists because geometry now persists between operations.
 * Its job is to refuse work BEFORE committing the allocation, so these tests
 * care most about the refusal paths and about arithmetic that cannot be trusted
 * to fail loudly on its own.
 */

function expectLimitError(result: unknown): void {
  expect(isAppError(result)).toBe(true);
  if (!isAppError(result)) return;
  expect(result.code).toBe(AppErrorCode.ResourceLimitExceeded);
}

describe('byte models', () => {
  it('models resident geometry as positions plus indices', () => {
    // One triangle: 3 vertices x 3 floats x 4 bytes + 3 indices x 4 bytes.
    expect(residentBytesFor(1)).toBe(36 + 12);
  });

  it('models a render snapshot as positions plus normals, non-indexed', () => {
    // No index buffer is sent, so it is exactly two position-sized arrays.
    expect(renderBytesFor(1)).toBe(36 * 2);
  });

  it('matches the measured shape of a 2.1M-triangle model', () => {
    const triangles = 2_097_150;
    const mib = (bytes: number): number => Math.round(bytes / (1024 * 1024));

    expect(mib(residentBytesFor(triangles))).toBe(96);
    expect(mib(renderBytesFor(triangles))).toBe(144);
  });
});

describe('import peak', () => {
  it('counts the outgoing model, the input, and the candidate together', () => {
    // All three are live at once — that is what makes replacement
    // transactional, and it is the moment memory is tightest.
    const estimate = estimateImportPeak({
      currentResidentBytes: 1000,
      currentRenderBytes: 2000,
      inputBytes: 500,
      candidateTriangles: 1,
    });

    expect(estimate.modelledPeakBytes).toBe(1000 + 2000 + 500 + 48 + 72);
    expect(estimate.breakdown.candidateResident).toBe(48);
  });

  it('accepts a realistic large replacement', () => {
    const estimate = estimateImportPeak({
      currentResidentBytes: residentBytesFor(2_097_150),
      currentRenderBytes: renderBytesFor(2_097_150),
      inputBytes: 100 * 1024 * 1024,
      candidateTriangles: 2_097_150,
    });

    expect(checkImportPeak(estimate)).toBeUndefined();
  });

  it('refuses a replacement that would exceed the session peak', () => {
    const estimate = estimateImportPeak({
      currentResidentBytes: residentBytesFor(10_000_000),
      currentRenderBytes: renderBytesFor(10_000_000),
      inputBytes: 500 * 1024 * 1024,
      candidateTriangles: 10_000_000,
    });

    expectLimitError(checkImportPeak(estimate));
  });

  it('reports the breakdown so a refusal is explainable', () => {
    const estimate = estimateImportPeak({
      currentResidentBytes: residentBytesFor(10_000_000),
      currentRenderBytes: renderBytesFor(10_000_000),
      inputBytes: 500 * 1024 * 1024,
      candidateTriangles: 10_000_000,
    });
    const result = checkImportPeak(estimate);

    if (!isAppError(result)) {
      expect.unreachable('expected a rejection');
    }
    expect(result.details.candidateResident).toBe(residentBytesFor(10_000_000));
    expect(result.details.limit).toBe(DEFAULT_SESSION_MEMORY_BUDGET.maxImportPeakBytes);
    // Counts and bytes only — never geometry.
    for (const value of Object.values(result.details)) {
      expect(['number', 'string']).toContain(typeof value);
    }
  });
});

describe('overflow and non-finite protection', () => {
  it('treats a non-finite term as unbounded rather than letting it pass', () => {
    // NaN compares false against every limit, so without an explicit guard a
    // corrupted term would silently authorise any allocation.
    const estimate = estimateImportPeak({
      currentResidentBytes: Number.NaN,
      currentRenderBytes: 0,
      inputBytes: 0,
      candidateTriangles: 1,
    });

    expect(estimate.modelledPeakBytes).toBe(Number.POSITIVE_INFINITY);
    expectLimitError(checkImportPeak(estimate));
  });

  it('treats a negative term as unbounded', () => {
    const estimate = estimateImportPeak({
      currentResidentBytes: -1,
      currentRenderBytes: 0,
      inputBytes: 0,
      candidateTriangles: 1,
    });

    expectLimitError(checkImportPeak(estimate));
  });

  it('stays exact for the largest triangle counts the import budget permits', () => {
    // 20M triangles is the import ceiling. The byte model must remain an exact
    // integer well inside 2^53, or the comparisons above mean nothing.
    const bytes = residentBytesFor(20_000_000) + renderBytesFor(20_000_000);

    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(bytes).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('resident and render ceilings', () => {
  it('accepts a model inside both ceilings', () => {
    expect(checkResident(residentBytesFor(2_097_150), renderBytesFor(2_097_150))).toBeUndefined();
  });

  it('refuses resident geometry beyond the ceiling', () => {
    expectLimitError(checkResident(DEFAULT_SESSION_MEMORY_BUDGET.maxResidentBytes + 1, 0));
  });

  it('refuses render buffers beyond the ceiling', () => {
    expectLimitError(checkResident(0, DEFAULT_SESSION_MEMORY_BUDGET.maxRenderBytes + 1));
  });
});

describe('export peak', () => {
  it('counts the resident mesh alongside the writer output and its chunks', () => {
    const estimate = estimateExportPeak(1000, 400);

    expect(estimate.modelledPeakBytes).toBe(1000 + 400 + 400);
  });

  it('refuses an export whose modelled peak exceeds the limit', () => {
    const estimate = estimateExportPeak(
      DEFAULT_SESSION_MEMORY_BUDGET.maxExportPeakBytes,
      DEFAULT_SESSION_MEMORY_BUDGET.maxExportPeakBytes,
    );

    expectLimitError(checkExportPeak(estimate));
  });
});

describe('analysis workspace reservation', () => {
  /**
   * The reservation point topology diagnostics will use. Analysis scratch can be
   * several times the mesh, so it must be requested before it is allocated.
   */
  it('grants a workspace inside the limit', () => {
    expect(requestAnalysisWorkspace('topology/analyze', 64 * 1024 * 1024)).toBeUndefined();
  });

  /**
   * THE POINT OF A PREFLIGHT: the decision is made from COUNTS, before a single
   * bulk array exists. This test allocates nothing larger than two numbers,
   * which is the proof — a check that needed the workspace in order to decide
   * whether the workspace fits would be no check at all.
   *
   * The counts below are a real model's shape, not a made-up number: roughly
   * 4.8M triangles and 14.4M corners is a ~230 MiB binary STL, and the topology
   * scratch such a mesh needs exceeds the configured ceiling.
   */
  it('decides from counts alone, without allocating the workspace', () => {
    const faceCount = 4_800_000;
    const cornerCount = 14_400_000;

    const projected = estimateTopologyWorkspaceBytes(faceCount, cornerCount);
    expect(projected).toBeGreaterThan(DEFAULT_SESSION_MEMORY_BUDGET.maxAnalysisWorkspaceBytes);

    const result = requestAnalysisWorkspace('model/analyze', projected, {
      faceCount,
      cornerCount,
    });

    expectLimitError(result);
    if (!isAppError(result)) return;
    // The refusal carries counts and byte estimates only. Never geometry, and
    // never a filename.
    expect(result.details.faceCount).toBe(faceCount);
    expect(result.details.cornerCount).toBe(cornerCount);
    expect(Object.keys(result.details)).not.toContain('positions');
  });

  it('admits a mesh whose projected workspace fits', () => {
    // ~2M triangles, the largest size the benchmark actually runs.
    const projected = estimateTopologyWorkspaceBytes(2_093_058, 6_279_174);

    expect(projected).toBeLessThan(DEFAULT_SESSION_MEMORY_BUDGET.maxAnalysisWorkspaceBytes);
    expect(requestAnalysisWorkspace('model/analyze', projected)).toBeUndefined();
  });

  it('refuses a workspace beyond the limit before anything is allocated', () => {
    const result = requestAnalysisWorkspace(
      'topology/analyze',
      DEFAULT_SESSION_MEMORY_BUDGET.maxAnalysisWorkspaceBytes + 1,
      { triangleCount: 40_000_000 },
    );

    expectLimitError(result);
    if (!isAppError(result)) return;
    expect(result.details.operation).toBe('topology/analyze');
    expect(result.details.triangleCount).toBe(40_000_000);
  });

  it('refuses a non-finite estimate rather than trusting it', () => {
    expectLimitError(requestAnalysisWorkspace('topology/analyze', Number.NaN));
    expectLimitError(requestAnalysisWorkspace('topology/analyze', -1));
  });

  it('honours a caller-supplied budget', () => {
    const tight = { ...DEFAULT_SESSION_MEMORY_BUDGET, maxAnalysisWorkspaceBytes: 100 };

    expect(requestAnalysisWorkspace('topology/analyze', 50, {}, tight)).toBeUndefined();
    expectLimitError(requestAnalysisWorkspace('topology/analyze', 101, {}, tight));
  });
});
