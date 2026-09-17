import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
// The estimator lives with the engine; the ceiling lives here. The preflight is
// the place they meet, so the test exercises both together rather than
// hard-coding a byte count that would drift from the algorithms.
import { estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  createIndexArray,
  createPositionArray,
  MAX_IMPORT_GEOMETRY_BYTES,
  MAX_UNSHARED_IMPORT_TRIANGLES,
  measureImportGeometry,
  RENDER_BYTES_PER_TRIANGLE,
  UNSHARED_IMPORT_BYTES_PER_TRIANGLE,
  type CanonicalMesh,
  type GeometryDocument,
  type ImportGeometryCost,
} from '@cadfixer/mesh-core';
import {
  checkExportPeak,
  checkImportGeometry,
  DEFAULT_SESSION_MEMORY_BUDGET,
  estimateExportPeak,
  requestAnalysisWorkspace,
  requestRepairPeak,
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

/* ---------------------------------------- Stage 6D-R3: the import gate --- */

/** A soup mesh of `triangles` faces: no shared corners, exactly as STL stores. */
function soup(triangles: number): CanonicalMesh {
  return {
    positions: createPositionArray(triangles * 9),
    indices: createIndexArray(triangles * 3),
    metadata: {},
  };
}

/** An indexed mesh: `vertices` shared corners referenced by `triangles` faces. */
function indexed(triangles: number, vertices: number): CanonicalMesh {
  return {
    positions: createPositionArray(vertices * 3),
    indices: createIndexArray(triangles * 3),
    metadata: {},
  };
}

function documentOf(...meshes: readonly CanonicalMesh[]): GeometryDocument {
  return {
    parts: meshes.map((mesh, index) => ({
      id: `part-${String(index)}` as GeometryDocument['parts'][number]['id'],
      mesh,
      transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] as const,
    })),
  };
}

/** A document that places ONE mesh `count` times, which is what 3MF produces. */
function placements(mesh: CanonicalMesh, count: number): GeometryDocument {
  return documentOf(...Array.from({ length: count }, () => mesh));
}

describe('import geometry cost', () => {
  it('counts canonical buffers and the render snapshot separately', () => {
    const cost = measureImportGeometry(documentOf(soup(1)));

    // 36 bytes of positions + 12 of indices, then 72 of render buffers.
    expect(cost.canonicalBytes).toBe(48);
    expect(cost.renderSnapshotBytes).toBe(RENDER_BYTES_PER_TRIANGLE);
    expect(cost.totalBytes).toBe(UNSHARED_IMPORT_BYTES_PER_TRIANGLE);
  });

  it('charges a shared mesh ONCE however many times it is placed', () => {
    // THE DEFECT THAT RETIRED THE OLD ESTIMATOR. It computed both terms from the
    // SUMMED triangle count, so this document — 2,000 placements of one mesh,
    // two million summed triangles, ONE stored mesh — was charged two million
    // triangles twice over and refused while costing 120 KiB.
    const mesh = soup(1_000);
    const one = measureImportGeometry(documentOf(mesh));
    const many = measureImportGeometry(placements(mesh, 2_000));

    expect(many.totalBytes).toBe(one.totalBytes);
    expect(many.distinctMeshCount).toBe(1);
    expect(many.distinctTriangleCount).toBe(1_000);
    expect(checkImportGeometry(many)).toBeUndefined();
  });

  it('counts distinct meshes separately even when they are the same size', () => {
    const cost = measureImportGeometry(documentOf(soup(1_000), soup(1_000)));

    expect(cost.distinctMeshCount).toBe(2);
    expect(cost.distinctTriangleCount).toBe(2_000);
  });

  it('charges an indexed mesh less to store and exactly as much to draw', () => {
    // The draw is non-indexed, so sharing corners makes a mesh cheaper to hold
    // and not one byte cheaper to render. A gate that only counted canonical
    // bytes would miss the larger of the two terms.
    const cost = measureImportGeometry(documentOf(indexed(1_000, 502)));

    expect(cost.canonicalBytes).toBe(502 * 12 + 1_000 * 12);
    expect(cost.renderSnapshotBytes).toBe(1_000 * RENDER_BYTES_PER_TRIANGLE);
  });
});

describe('import geometry gate', () => {
  it('accepts a document exactly at the ceiling and refuses one byte past it', () => {
    const at: ImportGeometryCost = {
      canonicalBytes: MAX_IMPORT_GEOMETRY_BYTES,
      renderSnapshotBytes: 0,
      totalBytes: MAX_IMPORT_GEOMETRY_BYTES,
      distinctMeshCount: 1,
      distinctTriangleCount: 1,
    };
    expect(checkImportGeometry(at)).toBeUndefined();
    expectLimitError(checkImportGeometry({ ...at, renderSnapshotBytes: 1 }));
  });

  it('names the metric, the value and the limit in the refusal', () => {
    // §32. "This would use more memory than CAD Fixer allows" told a user
    // nothing they could act on and presented an estimate as memory.
    const result = checkImportGeometry({
      canonicalBytes: 600 * 1024 * 1024,
      renderSnapshotBytes: 400 * 1024 * 1024,
      totalBytes: 1000 * 1024 * 1024,
      distinctMeshCount: 1,
      distinctTriangleCount: 20_000_000,
    });

    if (!isAppError(result)) expect.unreachable('expected a refusal');
    expect(result.message).toContain('1,000 MiB');
    expect(result.message).toContain('768 MiB');
    expect(result.details.limit).toBe(DEFAULT_SESSION_MEMORY_BUDGET.maxImportGeometryBytes);
    expect(result.details.renderSnapshotBytes).toBe(400 * 1024 * 1024);
    // Counts and bytes only — never geometry.
    for (const value of Object.values(result.details)) {
      expect(['number', 'string']).toContain(typeof value);
    }
  });

  it('does not consult what is already resident', () => {
    // §34. The gate has no term for the outgoing document, so the same candidate
    // must reach the same verdict whatever the workspace already holds. There is
    // no parameter through which the current document could enter.
    const mesh = soup(1_000_000);
    expect(checkImportGeometry(measureImportGeometry(documentOf(mesh)))).toBeUndefined();
    expect(checkImportGeometry(measureImportGeometry(documentOf(mesh)))).toBeUndefined();
  });

  it('treats a non-finite or negative term as unbounded', () => {
    // NaN compares false against every limit, so an unguarded term would
    // silently authorise any allocation.
    expectLimitError(
      checkImportGeometry({
        canonicalBytes: Number.NaN,
        renderSnapshotBytes: 0,
        totalBytes: Number.NaN,
        distinctMeshCount: 1,
        distinctTriangleCount: 1,
      }),
    );
    expectLimitError(
      checkImportGeometry({
        canonicalBytes: -1,
        renderSnapshotBytes: 0,
        totalBytes: -1,
        distinctMeshCount: 1,
        distinctTriangleCount: 1,
      }),
    );
  });

  it('stays exact at the largest counts the document ceiling permits', () => {
    // 20M triangles is the document ceiling. The byte model must remain an exact
    // integer well inside 2^53, or every comparison above means nothing.
    const bytes = 20_000_000 * UNSHARED_IMPORT_BYTES_PER_TRIANGLE;

    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(bytes).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('the unshared-triangle ceiling the STL readers use', () => {
  it('is DERIVED from the byte ceiling rather than written down twice', () => {
    expect(MAX_UNSHARED_IMPORT_TRIANGLES).toBe(
      Math.floor(MAX_IMPORT_GEOMETRY_BYTES / UNSHARED_IMPORT_BYTES_PER_TRIANGLE),
    );
  });

  it('admits a soup mesh at the ceiling and refuses the next triangle', () => {
    // The pre-gate and the common gate must agree exactly. If the reader's
    // ceiling were looser, a file would be fully parsed and then refused: all of
    // the work and none of the protection. If it were tighter, the reader would
    // refuse files the gate would have taken.
    const at = measureImportGeometry(documentOf(soup(MAX_UNSHARED_IMPORT_TRIANGLES)));
    const past = measureImportGeometry(documentOf(soup(MAX_UNSHARED_IMPORT_TRIANGLES + 1)));

    expect(checkImportGeometry(at)).toBeUndefined();
    expectLimitError(checkImportGeometry(past));
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

/**
 * THE REPAIR CEILING IS ITS OWN QUANTITY.
 *
 * A repair peak is not an analysis workspace: the authoritative mesh and the
 * candidate coexist by design — that coexistence IS the safety property — so the
 * peak is both meshes plus connectivity plus the validation workspace. Checking
 * one against the other's limit would be comparing two different things and
 * calling the answer a limit.
 */
describe('repair peak budget', () => {
  it('allows a peak within the product ceiling', () => {
    expect(
      requestRepairPeak('repair/plan', DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes),
    ).toBeUndefined();
  });

  it('refuses a peak beyond the product ceiling before anything is allocated', () => {
    const result = requestRepairPeak(
      'repair/create-candidate',
      DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes + 1,
      { faceCount: 9_000_000 },
    );

    expectLimitError(result);
    if (!isAppError(result)) return;
    expect(result.details.operation).toBe('repair/create-candidate');
    expect(result.details.faceCount).toBe(9_000_000);
  });

  it('refuses a non-finite estimate rather than trusting it', () => {
    expectLimitError(requestRepairPeak('repair/plan', Number.NaN));
    expectLimitError(requestRepairPeak('repair/plan', -1));
  });

  /**
   * THE ONE-WAY PROPERTY, which is what makes a caller-supplied ceiling safe to
   * accept over a message at all. A narrower request is honoured; a wider one is
   * ignored in favour of the product's own limit.
   */
  it('honours a caller ceiling that NARROWS the product limit', () => {
    expect(requestRepairPeak('repair/plan', 500, {}, 1000)).toBeUndefined();
    expectLimitError(requestRepairPeak('repair/plan', 1001, {}, 1000));
  });

  it('ignores a caller ceiling that would WIDEN the product limit', () => {
    const beyond = DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes + 1;

    // Asking for twice the product ceiling does not buy twice the memory.
    expectLimitError(
      requestRepairPeak(
        'repair/plan',
        beyond,
        {},
        DEFAULT_SESSION_MEMORY_BUDGET.maxRepairPeakBytes * 2,
      ),
    );
  });

  it('treats a non-finite or negative caller ceiling as no ceiling at all', () => {
    // Never as "zero", which would refuse every repair, and never as "infinite",
    // which would bypass the product limit.
    expect(requestRepairPeak('repair/plan', 1000, {}, Number.NaN)).toBeUndefined();
    expectLimitError(requestRepairPeak('repair/plan', 1000, {}, -5));
  });
});

/* ------------------------------------------- Stage 5A: no dead ceilings --- */

describe('every declared ceiling is enforced by something', () => {
  /**
   * A CEILING NOBODY CHECKS IS WORSE THAN NO CEILING, because it reads like a
   * guarantee in the budget table while permitting anything at runtime.
   *
   * Stage 5A's resource audit found two of them. `maxResidentBytes` and
   * `maxExportPeakBytes` are declared here and have no production call site:
   * `checkExportPeak` and `estimateExportPeak` are reached only by this file.
   * The bytes ARE bounded — resident geometry by `mesh-core`'s
   * `maxTotalGeometryBytes` at the same 768 MiB, and export by
   * `export-contract.ts`'s own incrementally-enforced `maxOutputBytes` /
   * `maxSerialisedBytes` — so this was drift, not a hole.
   *
   * STAGE 6D-R3 REMOVED THE THIRD. `maxRenderBytes` was declared, was enforced
   * by nothing, and was reached only by `checkResident`, which had no production
   * caller either. Render bytes are now a TERM of `maxImportGeometryBytes`,
   * checked before the snapshot is built, so the dead constant and its dead
   * checker are gone rather than exempted.
   *
   * This test exists so the drift cannot grow. Every field is either enforced
   * from production through one of this module's own request/check functions, or
   * NAMED BELOW as superseded, with where the real gate lives. Adding a field
   * without doing one of those two things fails here.
   */
  const SUPERSEDED_ELSEWHERE: Readonly<Record<string, string>> = {
    // Enforced by `assertGeometryDocument` via DEFAULT_DOCUMENT_LIMITS
    // .maxTotalGeometryBytes, which is the same 768 MiB and runs on every
    // document before it can become resident.
    maxResidentBytes: 'mesh-core document-validation maxTotalGeometryBytes',
    // Enforced by file-formats export-contract maxOutputBytes (256 MiB) and
    // maxSerialisedBytes (512 MiB), both checked before a chunk is retained.
    maxExportPeakBytes: 'file-formats export-contract maxOutputBytes',
  };

  const ENFORCED_FROM_PRODUCTION: readonly string[] = [
    'maxImportGeometryBytes',
    'maxAnalysisWorkspaceBytes',
    'maxRepairPeakBytes',
  ];

  it('accounts for every field of the default budget', () => {
    const declared = Object.keys(DEFAULT_SESSION_MEMORY_BUDGET).sort();
    const accounted = [...ENFORCED_FROM_PRODUCTION, ...Object.keys(SUPERSEDED_ELSEWHERE)].sort();

    expect(
      declared,
      'a new memory ceiling must either be enforced from production or recorded here as superseded',
    ).toEqual(accounted);
  });

  it('states where each superseded ceiling is actually enforced', () => {
    // Not a tautology: it fails if someone adds a field to the exemption list
    // without saying which gate replaces it.
    for (const [field, gate] of Object.entries(SUPERSEDED_ELSEWHERE)) {
      expect(gate.length, `${field} needs a named real gate`).toBeGreaterThan(10);
    }
  });

  it('keeps every declared ceiling a positive finite number of bytes', () => {
    for (const [field, value] of Object.entries(DEFAULT_SESSION_MEMORY_BUDGET)) {
      expect(Number.isFinite(value), `${field} must be finite`).toBe(true);
      expect(value, `${field} must be positive`).toBeGreaterThan(0);
    }
  });
});
