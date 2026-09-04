import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, uncancellable } from '@cadfixer/shared';
import { partId, singlePartDocument, triangleCount } from '@cadfixer/mesh-core';
import type { CanonicalMesh, GeometryDocument } from '@cadfixer/mesh-core';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { concat, duplicateSameOrientation, tetrahedron } from '@cadfixer/mesh-topology/fixtures';
import {
  executeConservativeRepair,
  planConservativeRepair,
  RepairOperation,
  restoreFromInverse,
} from '@cadfixer/mesh-repair';
import { CandidateState, RepairCandidateStore } from './repair-candidates';
import { ResidentDocumentStore } from './resident-documents';

/**
 * The one part every fixture document holds.
 *
 * A single-part document is the STL shape, and it is what these transaction
 * guards were written against — the part identity here is what makes them
 * expressible at all now that a candidate names a part.
 */
const PART = partId('part-1');

/** The mesh of a resolved document's only part. */
function onlyMesh(document: GeometryDocument | { code: string }): CanonicalMesh {
  if (!('parts' in document)) throw new Error('expected a document');
  const part = document.parts[0];
  if (part === undefined) throw new Error('expected a part');
  return part.mesh;
}

/**
 * CR20–CR22, CR24 and the transaction guards.
 *
 * THE PROPERTY UNDER TEST: M0 survives until a validated candidate replaces it,
 * and every path that could put unvalidated, stale or already-applied geometry
 * into the authoritative slot fails with a TYPED error rather than succeeding
 * quietly.
 */

/**
 * Narrows a value the test has already established is present.
 *
 * Used instead of `!` so a wrong assumption fails with a clear message at the
 * point of use rather than as a downstream `undefined` dereference.
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be defined`);
  return value;
}

function repairOf(mesh: CanonicalMesh): {
  plan: ReturnType<typeof planConservativeRepair>['plan'];
  result: ReturnType<typeof executeConservativeRepair>;
} {
  const before = analyseTopology(mesh, {
    documentId: 'm',
    partId: 'part-1',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
  const { plan, view, prepared } = planConservativeRepair({
    mesh,
    report: before,
    documentId: 'm',
    partId: 'part-1',
    sourceRevision: 1,
    requested: [RepairOperation.RemoveDuplicateFaces],
  });
  const result = executeConservativeRepair({
    source: mesh,
    plan,
    sourceReport: before,
    cancellation: uncancellable,
    documentId: 'm',
    partId: 'part-1',
    revision: 1,
    view,
    prepared,
  });
  return { plan, result };
}

function setUp(): {
  models: ResidentDocumentStore;
  candidates: RepairCandidateStore;
  source: ReturnType<ResidentDocumentStore['commit']>;
  mesh: CanonicalMesh;
  plan: ReturnType<typeof planConservativeRepair>['plan'];
  result: ReturnType<typeof executeConservativeRepair>;
} {
  const mesh = concat(duplicateSameOrientation(), tetrahedron());
  const models = new ResidentDocumentStore();
  const candidates = new RepairCandidateStore();
  const source = models.commit(singlePartDocument(mesh));
  const { plan, result } = repairOf(mesh);
  return { models, candidates, source, mesh, plan, result };
}

describe('repair candidate transactions', () => {
  it('commits a validated candidate as a NEW revision, leaving lineage intact', () => {
    const { models, candidates, source, plan, result } = setUp();
    expect(result.candidate).toBeDefined();

    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );
    expect(candidates.stateOf(handle)).toBe(CandidateState.Resolved);

    const mesh = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: plan.planHash },
      models.revisionOf(source.documentId),
    );
    expect(isAppError(mesh)).toBe(false);

    const next = models.replace(source, singlePartDocument(mesh as CanonicalMesh));
    expect(isAppError(next)).toBe(false);
    candidates.markCommitted(handle);

    if (isAppError(next)) return;
    // Same lineage, NEW revision, parent recorded by the revision itself.
    expect(next.documentId).toBe(source.documentId);
    expect(next.revision).toBe(source.revision + 1);
    expect(models.revisionOf(source.documentId)).toBe(2);

    // The old handle is now stale and must not resolve.
    expect(isAppError(models.resolve(source))).toBe(true);
    // And the new one resolves to the REPAIRED geometry.
    const committed = models.resolve(next);
    expect(isAppError(committed)).toBe(false);
    expect(triangleCount(onlyMesh(committed))).toBe(result.counts.candidateFaceCount);
  });

  it('CR20: a candidate whose source revision moved on cannot commit', () => {
    const { models, candidates, source, plan, result } = setUp();
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );

    // Something else replaces the model first.
    const moved = models.replace(source, singlePartDocument(tetrahedron()));
    expect(isAppError(moved)).toBe(false);

    const outcome = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: plan.planHash },
      models.revisionOf(source.documentId),
    );
    expect(isAppError(outcome)).toBe(true);
    if (isAppError(outcome)) expect(outcome.code).toBe(AppErrorCode.ModelUnavailable);

    // The newer geometry is untouched: the stale repair did not land on it.
    if (!isAppError(moved)) {
      const current = models.resolve(moved);
      expect(triangleCount(onlyMesh(current))).toBe(triangleCount(tetrahedron()));
    }
  });

  it('CR21: a discarded candidate cannot commit', () => {
    const { models, candidates, source, plan, result } = setUp();
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );

    expect(candidates.discard(handle)).toBe(true);
    expect(candidates.stateOf(handle)).toBe(CandidateState.Discarded);

    const outcome = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: plan.planHash },
      models.revisionOf(source.documentId),
    );
    expect(isAppError(outcome)).toBe(true);
    if (isAppError(outcome)) expect(outcome.code).toBe(AppErrorCode.InvalidState);

    // M0 is still authoritative and still resolvable.
    expect(isAppError(models.resolve(source))).toBe(false);
  });

  it('discard is idempotent, and reports whether anything was released', () => {
    const { candidates, source, result } = setUp();
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );
    expect(candidates.discard(handle)).toBe(true);
    // Second discard releases nothing, and is NOT an error — cancelling twice
    // is not a fault.
    expect(candidates.discard(handle)).toBe(false);
  });

  it('CR22: committing twice is refused', () => {
    const { models, candidates, source, plan, result } = setUp();
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );

    const first = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: plan.planHash },
      models.revisionOf(source.documentId),
    );
    const next = models.replace(source, singlePartDocument(first as CanonicalMesh));
    candidates.markCommitted(handle);
    expect(isAppError(next)).toBe(false);

    const second = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: plan.planHash },
      models.revisionOf(source.documentId),
    );
    expect(isAppError(second)).toBe(true);
    if (isAppError(second)) expect(second.code).toBe(AppErrorCode.InvalidState);
  });

  it('CR24: a candidate that failed validation can never commit', () => {
    const { models, candidates, source, plan, result } = setUp();
    const rejected = {
      ...result.validation,
      acceptance: 'REJECTED_REGRESSION' as const,
    };
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      rejected,
      result.inverse,
    );

    const outcome = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: plan.planHash },
      models.revisionOf(source.documentId),
    );
    expect(isAppError(outcome)).toBe(true);
    if (isAppError(outcome)) expect(outcome.code).toBe(AppErrorCode.InvalidState);
  });

  it('refuses a commit whose plan hash does not match the validated one', () => {
    const { models, candidates, source, result } = setUp();
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );

    const outcome = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: 'deadbeef' },
      models.revisionOf(source.documentId),
    );
    expect(isAppError(outcome)).toBe(true);
    if (isAppError(outcome)) expect(outcome.code).toBe(AppErrorCode.InvalidState);
  });

  it('a second candidate supersedes and releases the first', () => {
    const { candidates, source, result } = setUp();
    const first = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );
    const second = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );

    expect(candidates.stateOf(first)).toBe(CandidateState.Discarded);
    expect(candidates.stateOf(second)).toBe(CandidateState.Resolved);
    expect(second.generation).toBeGreaterThan(first.generation);
    // Only the live one still holds geometry.
    expect(candidates.stats().candidateCount).toBe(1);
  });

  it('export and analysis cannot reach candidate geometry through a model handle', () => {
    const { models, candidates, source, result } = setUp();
    candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );

    // Before commit, the ordinary handle still resolves to M0 — the candidate
    // has not become the export target.
    const resolved = models.resolve(source);
    expect(isAppError(resolved)).toBe(false);
    expect(triangleCount(onlyMesh(resolved))).toBe(result.counts.sourceFaceCount);
  });

  it('worker loss invalidates every candidate and records no commit', () => {
    const { models, candidates, source, result } = setUp();
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );

    // Policy A: the worker session ends, so authoritative geometry AND
    // candidates are gone. The model handle failing is how the application
    // tells session loss from an ordinary discard.
    candidates.releaseAll();
    models.releaseAll();

    expect(candidates.stateOf(handle)).toBeUndefined();
    expect(candidates.stats().candidateCount).toBe(0);
    const outcome = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: 'x' },
      models.revisionOf(source.documentId),
    );
    expect(isAppError(outcome)).toBe(true);
    if (isAppError(outcome)) expect(outcome.code).toBe(AppErrorCode.ModelUnavailable);
    expect(isAppError(models.resolve(source))).toBe(true);
  });

  it('CR23 through the transaction: the inverse patch restores the committed revision', () => {
    const { models, candidates, source, mesh, plan, result } = setUp();
    const handle = candidates.create(
      source,
      PART,
      must(result.candidate, 'candidate'),
      result.validation,
      result.inverse,
    );
    const committedMesh = candidates.prepareCommit(
      { candidate: handle, expectedSource: source, expectedPart: PART, planHash: plan.planHash },
      models.revisionOf(source.documentId),
    ) as CanonicalMesh;
    const next = models.replace(source, singlePartDocument(committedMesh));
    candidates.markCommitted(handle);
    expect(isAppError(next)).toBe(false);

    const patch = candidates.inverseOf(handle);
    expect(patch).toBeDefined();
    const restored = restoreFromInverse(committedMesh, must(patch, 'inverse patch'));

    // Byte-for-byte back to M0, which is what makes undo implementable without
    // retaining a whole second copy of the model.
    expect([...restored.positions]).toEqual([...mesh.positions]);
    expect(triangleCount(restored)).toBe(triangleCount(mesh));
    expect(must(patch, 'inverse patch').byteLength).toBeLessThan(
      mesh.positions.byteLength + mesh.indices.byteLength,
    );
  });
});
