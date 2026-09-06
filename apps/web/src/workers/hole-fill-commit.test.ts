import { afterEach, describe, expect, it } from 'vitest';
import {
  IDENTITY_PART_TRANSFORM,
  partId,
  singlePartDocument,
  triangleCount,
  type CanonicalMesh,
  type GeometryDocument,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  HoleFillCandidateState,
  HoleFillStatus,
  UndoableChangeKind,
  type DocumentHandle,
  type HoleFillCandidateHandle,
  type OperationContext,
} from '@cadfixer/geometry-runtime';
import { AppErrorCode, isAppError, operationCancelled, uncancellable } from '@cadfixer/shared';
import { runHoleFill } from '@cadfixer/mesh-hole-fill';
import {
  hp02QuadHole,
  hp12TwoIndependentHoles,
  referenceNarrowphase,
} from '@cadfixer/mesh-hole-fill/fixtures';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import {
  holeFillBoundaryPreviewHandler,
  holeFillCommitHandler,
  holeFillPatchPreviewHandler,
} from './hole-fill-workflow-handlers';
import { holeFillDiscardHandler } from './hole-fill-handlers';
import { repairUndoHandler } from './repair-handlers';
import { holeFillCandidates, repairHistory, residentDocuments } from './stl-handlers';

/**
 * HC01–HC14: THE APPLY TRANSACTION.
 *
 * WHAT THIS SUITE IS FOR. `holefill/commit` is the ONLY path by which proposed
 * geometry becomes the user's model, so every way of reaching it wrongly gets a
 * case: an unknown handle, another document's candidate, another part's, another
 * opening's, a stale revision, a discarded candidate and a consumed one. Each of
 * those, if it succeeded, would replace geometry with a patch that was never
 * validated against it — and none of them would look like a failure afterwards.
 *
 * AND THE TWO POSITIVE CLAIMS THAT MATTER MOST. That the mesh which becomes
 * authoritative is byte-for-byte the candidate that was previewed (HC11), and
 * that a part SHARING its mesh with a sibling is isolated by the swap while the
 * sibling keeps the original object (HC09, HC10). The second is the case a
 * naive implementation gets wrong silently: mutate in place and both parts
 * change.
 *
 * THE CANDIDATES HERE ARE REAL. They come from `runHoleFill` with the research
 * narrowphase — a genuinely validated append-only patch — rather than from a
 * hand-built mesh, so the provenance the commit path relies on is the engine's
 * own rather than the test's assumption about it.
 */

const PART = partId('part-1');
const SIBLING = partId('part-2');

function context(cancellation = uncancellable): OperationContext {
  return {
    cancellation,
    interruptible: false,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

function firstFillableLoopId(mesh: CanonicalMesh): string {
  const set = extractBoundaryLoops(mesh);
  const loop = set.loops.find((entry) => entry.refusal === undefined);
  if (loop === undefined) throw new Error('fixture has no fillable loop');
  return loop.id;
}

/** A genuinely validated candidate mesh for one opening of `mesh`. */
function buildCandidate(mesh: CanonicalMesh, loopId: string): CanonicalMesh {
  const result = runHoleFill({
    source: mesh,
    request: {
      operationId: 'hc',
      documentId: 'hc',
      revision: 1,
      partId: 'hc',
      boundaryLoopId: loopId,
    },
    narrowphase: referenceNarrowphase(),
  });
  expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
  if (result.candidate === undefined) throw new Error('engine returned no candidate');
  return result.candidate;
}

/**
 * Registers a candidate the way the authoritative worker does.
 *
 * Through `HoleFillCandidateStore.create` directly rather than through the fill
 * handler, because the handler's channel exchange is exercised by
 * `hole-fill-handlers.test.ts` and re-staging it here would test the port stub
 * rather than the transaction.
 */
function register(
  handle: DocumentHandle,
  part: PartId,
  loopId: string,
  candidate: CanonicalMesh,
  sourceFaceCount: number,
): HoleFillCandidateHandle {
  return holeFillCandidates.create(handle, part, loopId, candidate, sourceFaceCount);
}

function twoPartSharedDocument(mesh: CanonicalMesh): GeometryDocument {
  // ONE `CanonicalMesh` OBJECT, TWO PARTS. The case a fill must not get wrong.
  return {
    parts: [
      { id: PART, mesh, transform: IDENTITY_PART_TRANSFORM, name: 'A' },
      { id: SIBLING, mesh, transform: IDENTITY_PART_TRANSFORM, name: 'B' },
    ],
  };
}

function bytesEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return a.every((value, index) => value === b[index]);
}

/**
 * Runs a handler and captures whatever it refuses with, sync or async.
 *
 * `holefill/commit` and `repair/undo` reject by THROWING synchronously — they
 * are transactions, and a guard that fires has nothing to await. `rejects` alone
 * would not see that, so the whole call is wrapped rather than the promise.
 */
async function refusalOf(run: () => unknown): Promise<{ code?: unknown; message?: string }> {
  try {
    await run();
  } catch (cause) {
    return cause as { code?: unknown; message?: string };
  }
  throw new Error('the handler did not refuse');
}

function residentPart(handle: DocumentHandle, part: PartId): CanonicalMesh {
  const resolved = residentDocuments.resolvePart(handle, part);
  if (isAppError(resolved)) throw resolved;
  return resolved.mesh;
}

afterEach(() => {
  residentDocuments.releaseAll();
  holeFillCandidates.releaseAll();
  repairHistory.releaseAll();
});

describe('HC01: a valid candidate commits', () => {
  it('produces exactly one new revision holding the candidate', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidateMesh = buildCandidate(source, loopId);
    const candidate = register(handle, PART, loopId, candidateMesh, triangleCount(source));

    const result = await holeFillCommitHandler(
      {
        candidate,
        expectedSource: handle,
        expectedPart: PART,
        expectedLoopId: loopId,
      },
      context(),
    );

    expect(result.value.handle.documentId).toBe(handle.documentId);
    expect(result.value.parentRevision).toBe(handle.revision);
    expect(result.value.partId).toBe(PART);
    expect(result.value.boundaryLoopId).toBe(loopId);
    expect(result.value.patchFaceCount).toBe(triangleCount(candidateMesh) - triangleCount(source));
    expect(result.value.undoable).toBe(true);
  });
});

describe('HC12: the revision increments exactly once', () => {
  it('moves N to N+1 and no further', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    const before = residentDocuments.revisionOf(handle.documentId);
    const result = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );

    expect(result.value.handle.revision).toBe((before ?? 0) + 1);
    expect(residentDocuments.revisionOf(handle.documentId)).toBe((before ?? 0) + 1);
  });
});

describe('HC11: the committed mesh IS the previewed candidate', () => {
  /*
   * THE CENTRAL PRODUCT CLAIM, and the strongest form of it available: not
   * "the opening disappeared" — which a different patch would also achieve — but
   * that the exact bytes the patch preview was drawn from are the bytes that
   * became authoritative.
   */
  it('commits the candidate byte for byte, positions and indices', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidateMesh = buildCandidate(source, loopId);
    const candidate = register(handle, PART, loopId, candidateMesh, triangleCount(source));

    // What the PREVIEW showed, read from the store before the commit consumes it.
    const preview = await holeFillPatchPreviewHandler({ candidate }, context());
    const previewPositions = new Float32Array(preview.value.positions);

    const result = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );

    const committed = residentPart(result.value.handle, PART);
    expect(bytesEqual(committed.positions, candidateMesh.positions)).toBe(true);
    expect(bytesEqual(committed.indices, candidateMesh.indices)).toBe(true);

    // AND THE PREVIEW MATCHES THE COMMITTED SUFFIX. Re-derived from the
    // authoritative mesh, so preview and reality are compared rather than the
    // preview being compared with itself.
    const start = triangleCount(source);
    const patchFaces = triangleCount(committed) - start;
    const expected = new Float32Array(patchFaces * 9);
    for (let face = 0; face < patchFaces; face += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = committed.indices[(start + face) * 3 + corner] ?? 0;
        for (let axis = 0; axis < 3; axis += 1) {
          expected[face * 9 + corner * 3 + axis] = committed.positions[vertex * 3 + axis] ?? 0;
        }
      }
    }
    expect(bytesEqual(previewPositions, expected)).toBe(true);
  });

  it('preserves every source byte: positions whole, indices as a prefix', async () => {
    const source = hp02QuadHole();
    const sourcePositions = new Float32Array(source.positions);
    const sourceIndices = new Uint32Array(source.indices);
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    const result = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );

    const committed = residentPart(result.value.handle, PART);
    expect(bytesEqual(committed.positions, sourcePositions)).toBe(true);
    expect(bytesEqual(committed.indices.subarray(0, sourceIndices.length), sourceIndices)).toBe(
      true,
    );
  });
});

describe('HC02–HC08: every way of committing the wrong thing is refused', () => {
  async function expectRefusal(
    payload: {
      candidate: HoleFillCandidateHandle;
      expectedSource: DocumentHandle;
      expectedPart: string;
      expectedLoopId: string;
    },
    code: string,
  ): Promise<void> {
    const refusal = await refusalOf(() => holeFillCommitHandler(payload, context()));
    expect(refusal.code).toBe(code);
  }

  it('HC02: refuses an unknown candidate handle', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );
    const unknown: HoleFillCandidateHandle = {
      ...candidate,
      candidateId: 'hole-fill-candidate-does-not-exist' as HoleFillCandidateHandle['candidateId'],
    };

    await expectRefusal(
      { candidate: unknown, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      AppErrorCode.ModelUnavailable,
    );
    // AND NOTHING MOVED.
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(handle.revision);
  });

  it('HC03: refuses a candidate belonging to a different document', async () => {
    const source = hp02QuadHole();
    const first = residentDocuments.commit(singlePartDocument(source));
    const second = residentDocuments.commit(singlePartDocument(hp02QuadHole()));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      first,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    await expectRefusal(
      { candidate, expectedSource: second, expectedPart: PART, expectedLoopId: loopId },
      AppErrorCode.InvalidState,
    );
    expect(residentDocuments.revisionOf(second.documentId)).toBe(second.revision);
  });

  it('HC04: refuses a candidate built from an earlier revision', async () => {
    const source = hp12TwoIndependentHoles();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    // Something else moves the document on.
    const moved = residentDocuments.replace(handle, singlePartDocument(hp02QuadHole()));
    expect(isAppError(moved)).toBe(false);

    await expectRefusal(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      AppErrorCode.ModelUnavailable,
    );
  });

  it('HC05: refuses a candidate built for a different part', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(twoPartSharedDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    await expectRefusal(
      { candidate, expectedSource: handle, expectedPart: SIBLING, expectedLoopId: loopId },
      AppErrorCode.InvalidState,
    );
    // The sibling is untouched, which is the point of the guard.
    expect(bytesEqual(residentPart(handle, SIBLING).indices, source.indices)).toBe(true);
  });

  it('HC06: refuses a candidate that closes a different opening', async () => {
    const source = hp12TwoIndependentHoles();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loops = extractBoundaryLoops(source).loops.filter((loop) => loop.refusal === undefined);
    expect(loops.length).toBeGreaterThan(1);
    const chosen = loops[0]?.id ?? '';
    const other = loops[1]?.id ?? '';
    const candidate = register(
      handle,
      PART,
      chosen,
      buildCandidate(source, chosen),
      triangleCount(source),
    );

    await expectRefusal(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: other },
      AppErrorCode.InvalidState,
    );
  });

  it('HC07: refuses a discarded candidate', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    await holeFillDiscardHandler({ candidate }, context());
    expect(holeFillCandidates.stateOf(candidate)).toBe(HoleFillCandidateState.Discarded);

    await expectRefusal(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      AppErrorCode.InvalidState,
    );
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(handle.revision);
  });

  it('HC08: refuses a candidate that was already applied', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    const first = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );
    expect(holeFillCandidates.stateOf(candidate)).toBe(HoleFillCandidateState.Committed);

    /*
     * HC16 AT THE CONTRACT LEVEL. Committing twice would append the same patch
     * to a mesh that already carries it. Refused even when the caller updates
     * the handle to the NEW revision, because the candidate is consumed rather
     * than merely stale — which is the distinction the `Committed` state exists
     * to draw.
     */
    await expectRefusal(
      {
        candidate,
        expectedSource: first.value.handle,
        expectedPart: PART,
        expectedLoopId: loopId,
      },
      AppErrorCode.InvalidState,
    );
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(first.value.handle.revision);
  });
});

describe('HC09, HC10: shared geometry is isolated by the swap', () => {
  /*
   * THE HARD GATE. Two parts hold the SAME `CanonicalMesh` object. Filling one
   * must give that part the candidate and leave the other holding the original
   * object — not a copy of it, the object — because that is what proves nothing
   * was mutated in place and what keeps the document's sharing intact.
   */
  it('gives the filled part the candidate and leaves the sibling reference-identical', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(twoPartSharedDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidateMesh = buildCandidate(source, loopId);
    const candidate = register(handle, PART, loopId, candidateMesh, triangleCount(source));

    const before = residentDocuments.resolve(handle);
    if (!('parts' in before)) throw before;
    const sharedBefore = before.parts[1]?.mesh;

    const result = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );

    const after = residentDocuments.resolve(result.value.handle);
    if (!('parts' in after)) throw after;

    // The filled part holds the candidate.
    expect(after.parts[0]?.mesh).toBe(candidateMesh);
    // The sibling holds the SAME OBJECT it held before. Reference identity, not
    // value equality: a copy would satisfy a byte comparison and would still
    // mean the document had silently stopped sharing.
    expect(after.parts[1]?.mesh).toBe(sharedBefore);
    expect(after.parts[1]?.mesh).toBe(source);
    // And it still has its opening: nothing was filled in it.
    expect(triangleCount(after.parts[1]?.mesh ?? source)).toBe(triangleCount(source));

    // HC10. Every other property of the sibling part is carried across.
    expect(after.parts[1]?.id).toBe(SIBLING);
    expect(after.parts[1]?.name).toBe('B');
    expect(after.parts[1]?.transform).toEqual(IDENTITY_PART_TRANSFORM);
    // Order, count and the filled part's own identity are untouched too.
    expect(after.parts.map((part) => part.id)).toEqual([PART, SIBLING]);
    expect(after.parts[0]?.id).toBe(PART);
    expect(after.parts[0]?.transform).toEqual(IDENTITY_PART_TRANSFORM);
    expect(after.unit).toBe(before.unit);
  });
});

describe('HC13: a refused transaction mutates nothing and consumes nothing', () => {
  it('leaves the candidate applicable after a stale attempt is corrected', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    // A caller states the WRONG part. The guard fires.
    const refusal = await refusalOf(() =>
      holeFillCommitHandler(
        { candidate, expectedSource: handle, expectedPart: SIBLING, expectedLoopId: loopId },
        context(),
      ),
    );
    expect(refusal.code).toBe(AppErrorCode.InvalidState);

    /*
     * AND THE CANDIDATE SURVIVES. A refused commit must not consume it: a
     * transient mistake would otherwise destroy a validated fill and force the
     * user to rebuild it.
     */
    expect(holeFillCandidates.stateOf(candidate)).toBe(HoleFillCandidateState.Resolved);
    const corrected = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );
    expect(corrected.value.handle.revision).toBe(handle.revision + 1);
  });
});

describe('HC14: the candidate store is cleared when it must be', () => {
  it('releases a document candidate when the document is released', () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );
    expect(holeFillCandidates.stats().candidateCount).toBe(1);

    holeFillCandidates.releaseDocument(handle.documentId);

    expect(holeFillCandidates.stateOf(candidate)).toBe(HoleFillCandidateState.Discarded);
    expect(holeFillCandidates.stats().candidateCount).toBe(0);
  });

  it('supersedes an earlier candidate rather than keeping two alive', () => {
    const source = hp12TwoIndependentHoles();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loops = extractBoundaryLoops(source).loops.filter((loop) => loop.refusal === undefined);
    const first = register(
      handle,
      PART,
      loops[0]?.id ?? '',
      buildCandidate(source, loops[0]?.id ?? ''),
      triangleCount(source),
    );
    const second = register(
      handle,
      PART,
      loops[1]?.id ?? '',
      buildCandidate(source, loops[1]?.id ?? ''),
      triangleCount(source),
    );

    // ONE ACTIVE CANDIDATE PER DOCUMENT. The first is released rather than left
    // holding a whole part's geometry that no guard would ever let through.
    expect(holeFillCandidates.stateOf(first)).toBe(HoleFillCandidateState.Discarded);
    expect(holeFillCandidates.stateOf(second)).toBe(HoleFillCandidateState.Resolved);
    expect(holeFillCandidates.stats().candidateCount).toBe(1);
  });

  it('releases the candidate when a commit consumes it', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );

    // The resident document owns the mesh now; the store must not keep a second
    // reference to a whole part's geometry.
    expect(holeFillCandidates.stats().candidateCount).toBe(0);
    expect(holeFillCandidates.meshOf(candidate)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ undo -- */

describe('undo restores the pre-fill part exactly', () => {
  it('reproduces the source bytes, and keeps the sibling untouched throughout', async () => {
    const source = hp02QuadHole();
    const sourcePositions = new Float32Array(source.positions);
    const sourceIndices = new Uint32Array(source.indices);
    const handle = residentDocuments.commit(twoPartSharedDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );

    const applied = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );

    const undone = await repairUndoHandler(
      { handle: applied.value.handle, recordId: applied.value.recordId },
      context(),
    );

    /*
     * BYTE IDENTITY, NOT APPROXIMATE RESTORATION. The fill was append-only and
     * the preservation gate proved it, so the exact inverse is a truncation —
     * which reproduces every position and every index, in the original order,
     * for an indexed mesh as well as for soup.
     */
    const restored = residentPart(undone.value.handle, PART);
    expect(bytesEqual(restored.positions, sourcePositions)).toBe(true);
    expect(bytesEqual(restored.indices, sourceIndices)).toBe(true);
    expect(triangleCount(restored)).toBe(triangleCount(source));

    // The undo reports what it reversed, so the interface need not guess from an
    // empty operation list.
    expect(undone.value.kind).toBe(UndoableChangeKind.HoleFill);
    expect(undone.value.appliedOperations).toEqual([]);

    // A NEW, HIGHER REVISION. Never a revival of the old one — ADR 0011.
    expect(undone.value.handle.revision).toBeGreaterThan(applied.value.handle.revision);

    // And the sibling never moved at any point.
    expect(bytesEqual(residentPart(undone.value.handle, SIBLING).indices, sourceIndices)).toBe(
      true,
    );

    // The opening is back: the part is exactly what it was.
    const loopsAfter = extractBoundaryLoops(restored).loops.length;
    expect(loopsAfter).toBe(extractBoundaryLoops(source).loops.length);
  });

  it('cannot be undone twice, and the record is consumed', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );
    const applied = await holeFillCommitHandler(
      { candidate, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );
    const undone = await repairUndoHandler(
      { handle: applied.value.handle, recordId: applied.value.recordId },
      context(),
    );

    const refusal = await refusalOf(() =>
      repairUndoHandler(
        { handle: undone.value.handle, recordId: applied.value.recordId },
        context(),
      ),
    );
    expect(refusal.code).toBe(AppErrorCode.InvalidState);
  });

  it('HFUX23: a fresh candidate can be built and applied after an undo', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const first = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );
    const applied = await holeFillCommitHandler(
      { candidate: first, expectedSource: handle, expectedPart: PART, expectedLoopId: loopId },
      context(),
    );
    const undone = await repairUndoHandler(
      { handle: applied.value.handle, recordId: applied.value.recordId },
      context(),
    );

    // The opening is rediscovered from the RESTORED geometry, and its identity
    // is the same because the identity is a function of the geometry.
    const restored = residentPart(undone.value.handle, PART);
    const freshLoopId = firstFillableLoopId(restored);
    expect(freshLoopId).toBe(loopId);

    const second = register(
      undone.value.handle,
      PART,
      freshLoopId,
      buildCandidate(restored, freshLoopId),
      triangleCount(restored),
    );
    const reapplied = await holeFillCommitHandler(
      {
        candidate: second,
        expectedSource: undone.value.handle,
        expectedPart: PART,
        expectedLoopId: freshLoopId,
      },
      context(),
    );
    expect(reapplied.value.handle.revision).toBe(undone.value.handle.revision + 1);

    // AND THE OLD, CONSUMED CANDIDATE IS STILL DEAD.
    expect(holeFillCandidates.stateOf(first)).toBe(HoleFillCandidateState.Committed);
  });
});

/* -------------------------------------------------------------- previews -- */

describe('the previews are read-only and disposable', () => {
  it('draws the selected rim without touching the document', async () => {
    const source = hp02QuadHole();
    const positionsBefore = new Float32Array(source.positions);
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);

    const preview = await holeFillBoundaryPreviewHandler(
      { handle, partId: PART, boundaryLoopId: loopId },
      context(),
    );

    // Two endpoints per rim edge, six floats per edge.
    expect(preview.value.positions.length).toBe(preview.value.edgeCount * 6);
    expect(preview.value.edgeCount).toBeGreaterThan(2);
    expect(preview.value.boundaryLoopId).toBe(loopId);
    // READ-ONLY: no revision movement, no byte change.
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(handle.revision);
    expect(bytesEqual(residentPart(handle, PART).positions, positionsBefore)).toBe(true);
  });

  it('refuses a rim for an opening this revision does not have', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));

    await expect(
      holeFillBoundaryPreviewHandler(
        { handle, partId: PART, boundaryLoopId: 'bl-0-3-0000000000000000' },
        context(),
      ),
    ).rejects.toMatchObject({ code: AppErrorCode.ModelUnavailable });
  });

  it('sends ONLY the patch faces, never the candidate mesh', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidateMesh = buildCandidate(source, loopId);
    const candidate = register(handle, PART, loopId, candidateMesh, triangleCount(source));

    const preview = await holeFillPatchPreviewHandler({ candidate }, context());

    const patchFaces = triangleCount(candidateMesh) - triangleCount(source);
    expect(preview.value.triangleCount).toBe(patchFaces);
    expect(preview.value.positions.length).toBe(patchFaces * 9);
    expect(preview.value.normals.length).toBe(patchFaces * 9);
    // The whole candidate would be far larger. A preview that carried it would
    // put a second copy of the part on the page.
    expect(preview.value.positions.length).toBeLessThan(candidateMesh.positions.length);
  });

  it('refuses a patch preview for a discarded candidate', async () => {
    const source = hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const loopId = firstFillableLoopId(source);
    const candidate = register(
      handle,
      PART,
      loopId,
      buildCandidate(source, loopId),
      triangleCount(source),
    );
    await holeFillDiscardHandler({ candidate }, context());

    await expect(holeFillPatchPreviewHandler({ candidate }, context())).rejects.toMatchObject({
      code: AppErrorCode.ModelUnavailable,
    });
  });
});
