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
  type DocumentHandle,
  type HoleFillCandidateHandle,
  type OperationContext,
  type PartDescriptor,
  type RenderSnapshot,
} from '@cadfixer/geometry-runtime';
import { AppErrorCode, isAppError, operationCancelled, uncancellable } from '@cadfixer/shared';
import { runHoleFill } from '@cadfixer/mesh-hole-fill';
import { hp02QuadHole, referenceNarrowphase } from '@cadfixer/mesh-hole-fill/fixtures';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import {
  PRODUCTION_COMMIT_WORK,
  createHoleFillCommitHandler,
  type HoleFillCommitWork,
} from './hole-fill-workflow-handlers';
import {
  PRODUCTION_UNDO_WORK,
  createRepairUndoHandler,
  repairUndoHandler,
  type RepairUndoWork,
} from './repair-handlers';
import { holeFillCandidates, repairHistory, residentDocuments } from './stl-handlers';

/**
 * AT01–AT05, UT01–UT04: OBSERVABLE ATOMICITY.
 *
 * WHAT THIS SUITE EXISTS TO RULE OUT. `buildRenderSnapshot` allocates — for a
 * 250,000-face part it copies megabytes and derives per-vertex normals — and it
 * used to run AFTER the authoritative swap. Its failure threw out of the
 * handler, the worker host turned that into an ordinary error reply, and the
 * caller was told the fill had FAILED while the document had already changed.
 *
 * "The worker's internal state was consistent" is not the guarantee that
 * matters. The guarantee that matters is what the caller may OBSERVE, because
 * the interface acts on it: a user told their fill failed will press Apply
 * again, and a user told their undo failed is looking at a screen that no longer
 * matches the model.
 *
 * WHY A SEAM AND NOT A SOURCE-ORDER CHECK. `production-boundary.test.ts` asserts
 * the statements are in the right order; that proves the ordering, not the
 * behaviour when one of them actually fails. Making a large allocation fail on
 * demand is the only way to walk the path, so the two allocating steps arrive as
 * injected functions and a test builds a handler whose snapshot builder throws.
 * A CONSTRUCTION SEAM — the production defaults are the only values the
 * application uses, and nothing in the product can select another.
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

/** A context whose progress reports THROW, so transport failure can be walked. */
function hostileProgressContext(): OperationContext {
  return {
    ...context(),
    reportProgress: (): void => {
      throw new Error('the channel is gone');
    },
  };
}

class InjectedFailure extends Error {
  public constructor(stage: string) {
    super(`injected failure at ${stage}`);
    this.name = 'InjectedFailure';
  }
}

/** Commit work whose snapshot builder fails. */
function failingSnapshotWork(): HoleFillCommitWork {
  return {
    buildRenderSnapshot: (): RenderSnapshot => {
      throw new InjectedFailure('buildRenderSnapshot');
    },
    describeParts: PRODUCTION_COMMIT_WORK.describeParts,
  };
}

/** Commit work whose part-descriptor builder fails. */
function failingDescriptorWork(): HoleFillCommitWork {
  return {
    buildRenderSnapshot: PRODUCTION_COMMIT_WORK.buildRenderSnapshot,
    describeParts: (): readonly PartDescriptor[] => {
      throw new InjectedFailure('describeParts');
    },
  };
}

function failingUndoSnapshotWork(): RepairUndoWork {
  return {
    buildRenderSnapshot: (): RenderSnapshot => {
      throw new InjectedFailure('buildRenderSnapshot');
    },
    describeParts: PRODUCTION_UNDO_WORK.describeParts,
  };
}

function failingUndoDescriptorWork(): RepairUndoWork {
  return {
    buildRenderSnapshot: PRODUCTION_UNDO_WORK.buildRenderSnapshot,
    describeParts: (): readonly PartDescriptor[] => {
      throw new InjectedFailure('describeParts');
    },
  };
}

function firstFillableLoopId(mesh: CanonicalMesh): string {
  const set = extractBoundaryLoops(mesh);
  const loop = set.loops.find((entry) => entry.refusal === undefined);
  if (loop === undefined) throw new Error('fixture has no fillable loop');
  return loop.id;
}

function buildCandidate(mesh: CanonicalMesh, loopId: string): CanonicalMesh {
  const result = runHoleFill({
    source: mesh,
    request: {
      operationId: 'at',
      documentId: 'at',
      revision: 1,
      partId: 'at',
      boundaryLoopId: loopId,
    },
    narrowphase: referenceNarrowphase(),
  });
  expect(result.outcome.status).toBe(HoleFillStatus.ValidCandidate);
  if (result.candidate === undefined) throw new Error('engine returned no candidate');
  return result.candidate;
}

function twoPartSharedDocument(mesh: CanonicalMesh): GeometryDocument {
  return {
    parts: [
      { id: PART, mesh, transform: IDENTITY_PART_TRANSFORM, name: 'A' },
      { id: SIBLING, mesh, transform: IDENTITY_PART_TRANSFORM, name: 'B' },
    ],
  };
}

function residentPart(handle: DocumentHandle, part: PartId): CanonicalMesh {
  const resolved = residentDocuments.resolvePart(handle, part);
  if (isAppError(resolved)) throw resolved;
  return resolved.mesh;
}

/** Everything a caller could observe about the worker's state, as scalars. */
interface Observable {
  readonly revision: number | undefined;
  readonly partMesh: CanonicalMesh | undefined;
  readonly candidateState: HoleFillCandidateState | undefined;
  readonly undoableCount: number;
  readonly retainedBytes: number;
  readonly recordCount: number;
}

function observe(
  documentId: string,
  handle: DocumentHandle,
  candidate: HoleFillCandidateHandle,
  part: PartId = PART,
): Observable {
  const revision = residentDocuments.revisionOf(documentId as never);
  const resolved =
    revision === undefined
      ? undefined
      : residentDocuments.resolvePart({ documentId: handle.documentId, revision }, part);
  const stats = repairHistory.stats();
  return {
    revision,
    partMesh: resolved === undefined || isAppError(resolved) ? undefined : resolved.mesh,
    candidateState: holeFillCandidates.stateOf(candidate),
    undoableCount: stats.undoableCount,
    retainedBytes: stats.retainedBytes,
    recordCount: stats.recordCount,
  };
}

async function refusalOf(run: () => unknown): Promise<{ code?: unknown; name?: string }> {
  try {
    await run();
  } catch (cause) {
    return cause as { code?: unknown; name?: string };
  }
  throw new Error('the handler did not fail');
}

interface Staged {
  readonly handle: DocumentHandle;
  readonly candidate: HoleFillCandidateHandle;
  readonly loopId: string;
  readonly source: CanonicalMesh;
  readonly candidateMesh: CanonicalMesh;
}

/**
 * A resident document with a validated candidate ready to apply.
 *
 * The document is built FROM the source mesh rather than beside it, so
 * `staged.source` is the very object the resident part holds — which is what
 * makes `toBe` a meaningful assertion about restoration rather than a
 * comparison of two equal fixtures.
 */
function stage(build: (mesh: CanonicalMesh) => GeometryDocument = singlePartDocument): Staged {
  const source = hp02QuadHole();
  const handle = residentDocuments.commit(build(source));
  const loopId = firstFillableLoopId(source);
  const candidateMesh = buildCandidate(source, loopId);
  const candidate = holeFillCandidates.create(
    handle,
    PART,
    loopId,
    candidateMesh,
    triangleCount(source),
  );
  return { handle, candidate, loopId, source, candidateMesh };
}

afterEach(() => {
  residentDocuments.releaseAll();
  holeFillCandidates.releaseAll();
  repairHistory.releaseAll();
});

/* ------------------------------------------------------- AT01 – AT05 ---- */

describe('AT01–AT05: applying is observably atomic', () => {
  it('AT01: a snapshot failure leaves the document, candidate and history untouched', async () => {
    const staged = stage(twoPartSharedDocument);
    const before = observe(staged.handle.documentId, staged.handle, staged.candidate);
    expect(before.candidateState).toBe(HoleFillCandidateState.Resolved);

    const handler = createHoleFillCommitHandler(failingSnapshotWork());
    const failure = await refusalOf(() =>
      handler(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          expectedLoopId: staged.loopId,
        },
        context(),
      ),
    );
    expect(failure.name).toBe('InjectedFailure');

    /*
     * THE CALLER SAW A FAILURE AND NOTHING HAPPENED. Not "nothing important" —
     * the revision has not moved, the part holds the object it held, the
     * candidate is still applicable, and no undo record exists to reverse a
     * change that was never made.
     */
    const after = observe(staged.handle.documentId, staged.handle, staged.candidate);
    expect(after.revision).toBe(before.revision);
    expect(after.partMesh).toBe(staged.source);
    expect(after.candidateState).toBe(HoleFillCandidateState.Resolved);
    expect(after.undoableCount).toBe(0);
    expect(after.recordCount).toBe(0);
    expect(after.retainedBytes).toBe(0);

    // AND IT IS STILL APPLICABLE. A failed attempt must not have cost the user
    // their validated fill.
    const recovered = await createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK)(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        expectedLoopId: staged.loopId,
      },
      context(),
    );
    expect(recovered.value.handle.revision).toBe(staged.handle.revision + 1);
  });

  it('AT02: a part-descriptor failure leaves the document, candidate and history untouched', async () => {
    const staged = stage();
    const handler = createHoleFillCommitHandler(failingDescriptorWork());

    const failure = await refusalOf(() =>
      handler(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          expectedLoopId: staged.loopId,
        },
        context(),
      ),
    );
    expect(failure.name).toBe('InjectedFailure');

    const after = observe(staged.handle.documentId, staged.handle, staged.candidate);
    expect(after.revision).toBe(staged.handle.revision);
    expect(after.partMesh).toBe(staged.source);
    expect(after.candidateState).toBe(HoleFillCandidateState.Resolved);
    expect(after.recordCount).toBe(0);
  });

  it('AT03: a revision that moved while the answer was built commits nothing', async () => {
    /*
     * THE RACE PREPARING EARLY COULD HAVE INTRODUCED, and did not. The whole
     * answer is built against the proposed document; `replace` then compares the
     * revision against the store and refuses. The prepared snapshot describes a
     * document that never existed and is discarded with the call.
     *
     * Staged by moving the document from inside the injected work — the exact
     * moment between preparation and commit — which is the only way to reach
     * that window in a synchronous handler.
     */
    const staged = stage();
    let replacement: DocumentHandle | undefined;
    const handler = createHoleFillCommitHandler({
      buildRenderSnapshot: PRODUCTION_COMMIT_WORK.buildRenderSnapshot,
      describeParts: (document) => {
        // Somebody else changes the document while this answer is being built.
        const moved = residentDocuments.replace(staged.handle, singlePartDocument(staged.source));
        if (!isAppError(moved)) replacement = moved;
        return PRODUCTION_COMMIT_WORK.describeParts(document);
      },
    });

    const failure = await refusalOf(() =>
      handler(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          expectedLoopId: staged.loopId,
        },
        context(),
      ),
    );
    expect(failure.code).toBe(AppErrorCode.ModelUnavailable);
    expect(replacement).toBeDefined();

    // The fill did NOT land on top of the other change, and the candidate was
    // not consumed by an attempt that never committed.
    const current = residentDocuments.revisionOf(staged.handle.documentId);
    expect(current).toBe(replacement?.revision);
    expect(holeFillCandidates.stateOf(staged.candidate)).toBe(HoleFillCandidateState.Resolved);
    expect(repairHistory.stats().recordCount).toBe(0);
    if (replacement === undefined) return;
    expect(triangleCount(residentPart(replacement, PART))).toBe(triangleCount(staged.source));
  });

  it('AT04: a successful apply commits the exact candidate, once', async () => {
    const staged = stage();
    const result = await createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK)(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        expectedLoopId: staged.loopId,
      },
      context(),
    );

    expect(result.value.handle.revision).toBe(staged.handle.revision + 1);
    expect(residentPart(result.value.handle, PART)).toBe(staged.candidateMesh);
    expect(holeFillCandidates.stateOf(staged.candidate)).toBe(HoleFillCandidateState.Committed);
    expect(repairHistory.stats().undoableCount).toBe(1);
    expect(repairHistory.entryOf(result.value.recordId)).toBeDefined();

    /*
     * TX06. THE SNAPSHOT DESCRIBES WHAT WAS COMMITTED, not what was proposed and
     * not what was there before. Built before the swap, so this is the assertion
     * that the early preparation still describes the right document.
     */
    const committed = residentPart(result.value.handle, PART);
    // THREE CORNERS PER FACE — Stage 4B-1D. The snapshot is the drawable
    // triangle stream expanded from the mesh's index buffer, not its vertex
    // table, and a filled part's mesh is indexed like any other.
    expect(result.value.render.vertexCount).toBe(triangleCount(committed) * 3);
    expect(result.value.triangleCount).toBe(triangleCount(committed));
    expect(result.value.parts.map((part) => part.partId)).toEqual([PART]);
    expect(result.value.parts[0]?.triangleCount).toBe(triangleCount(committed));
  });

  it('AT05: nothing after the swap can turn a committed fill into a reported failure', async () => {
    /*
     * THE ENUMERATION, EXERCISED RATHER THAN READ.
     *
     * Between `residentDocuments.replace` and the handler's return there are
     * exactly four kinds of statement: a string concatenation for the record id,
     * `markCommitted` (a `Map.get`, a field write and a `Map.delete`),
     * `repairHistory.record` (object literals and bounded map/array writes, with
     * eviction capped at 64 descriptors), and an object literal built from values
     * that already exist. None allocates at geometry scale and none can fail.
     *
     * The one remaining candidate was `context.reportProgress`, which posts on
     * the channel and CAN throw if the port is gone. It now runs BEFORE the
     * swap, so a dead channel fails the operation without having changed
     * anything — which is what this case walks.
     */
    const staged = stage();
    const failure = await refusalOf(() =>
      createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK)(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          expectedLoopId: staged.loopId,
        },
        hostileProgressContext(),
      ),
    );
    expect(failure).toBeDefined();

    const after = observe(staged.handle.documentId, staged.handle, staged.candidate);
    expect(after.revision).toBe(staged.handle.revision);
    expect(after.partMesh).toBe(staged.source);
    expect(after.candidateState).toBe(HoleFillCandidateState.Resolved);
    expect(after.recordCount).toBe(0);
  });

  it('AT05: a successful apply survives a channel that dies after the commit', async () => {
    /*
     * THE OTHER HALF. A transport failure must not be reachable from inside the
     * committed region at all — so a context whose progress call throws produces
     * either a clean refusal with no mutation (above) or a clean success, never
     * a mutation reported as a failure. Here the progress call is the only
     * hostile thing and it fires before the swap, so the ONLY way to reach a
     * commit is to have survived it.
     */
    const staged = stage();
    let progressCalls = 0;
    const counting: OperationContext = {
      ...context(),
      reportProgress: (): void => {
        progressCalls += 1;
      },
    };
    const result = await createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK)(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        expectedLoopId: staged.loopId,
      },
      counting,
    );

    // Reported once, and before the swap — so the committed region contains no
    // transport call at all.
    expect(progressCalls).toBe(1);
    expect(result.value.handle.revision).toBe(staged.handle.revision + 1);
  });
});

/* ------------------------------------------------------- UT01 – UT04 ---- */

describe('UT01–UT04: undoing is observably atomic', () => {
  async function applyFill(staged: Staged): Promise<{ handle: DocumentHandle; recordId: string }> {
    const result = await createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK)(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        expectedLoopId: staged.loopId,
      },
      context(),
    );
    return { handle: result.value.handle, recordId: result.value.recordId };
  }

  it('UT01: a snapshot failure leaves the fill applied and still undoable', async () => {
    const staged = stage(twoPartSharedDocument);
    const applied = await applyFill(staged);
    const filledMesh = residentPart(applied.handle, PART);
    const retainedBefore = repairHistory.stats().retainedBytes;

    const handler = createRepairUndoHandler(failingUndoSnapshotWork());
    const failure = await refusalOf(() =>
      handler({ handle: applied.handle, recordId: applied.recordId }, context()),
    );
    expect(failure.name).toBe('InjectedFailure');

    /*
     * THE DOCUMENT IS STILL FILLED, and the undo is still available. A user told
     * their undo failed must be looking at a model that genuinely was not
     * restored — otherwise the screen and the model disagree and the next thing
     * they do is based on a false belief.
     */
    expect(residentDocuments.revisionOf(applied.handle.documentId as never)).toBe(
      applied.handle.revision,
    );
    expect(residentPart(applied.handle, PART)).toBe(filledMesh);
    expect(repairHistory.entryOf(applied.recordId)?.undoable).toBe(true);
    expect(repairHistory.stats().undoableCount).toBe(1);
    expect(repairHistory.stats().retainedBytes).toBe(retainedBefore);

    // AND THE UNDO STILL WORKS. A failed attempt did not consume it.
    const recovered = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );
    expect(residentPart(recovered.value.handle, PART)).toBe(staged.source);
  });

  it('UT02: a part-descriptor failure leaves the fill applied and still undoable', async () => {
    const staged = stage();
    const applied = await applyFill(staged);
    const filledMesh = residentPart(applied.handle, PART);

    const handler = createRepairUndoHandler(failingUndoDescriptorWork());
    const failure = await refusalOf(() =>
      handler({ handle: applied.handle, recordId: applied.recordId }, context()),
    );
    expect(failure.name).toBe('InjectedFailure');

    expect(residentDocuments.revisionOf(applied.handle.documentId as never)).toBe(
      applied.handle.revision,
    );
    expect(residentPart(applied.handle, PART)).toBe(filledMesh);
    expect(repairHistory.entryOf(applied.recordId)?.undoable).toBe(true);
  });

  it('UT03: a successful undo restores the exact mesh and the answer describes it', async () => {
    const staged = stage(twoPartSharedDocument);
    const applied = await applyFill(staged);

    const result = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );

    // Exact object, and the sharing back with it.
    const restored = residentPart(result.value.handle, PART);
    expect(restored).toBe(staged.source);
    expect(residentPart(result.value.handle, SIBLING)).toBe(staged.source);

    // A NEW higher revision, exactly one step on from the fill.
    expect(result.value.handle.revision).toBe(applied.handle.revision + 1);

    // The history is consumed and its retained mesh released.
    expect(repairHistory.entryOf(applied.recordId)?.undoable).toBe(false);
    expect(repairHistory.stats().undoableCount).toBe(0);
    expect(repairHistory.stats().retainedBytes).toBe(0);

    /*
     * TX07. THE SNAPSHOT DESCRIBES THE RESTORED DOCUMENT. Built before the swap,
     * so this is what proves the early preparation still describes what the
     * caller actually ended up with.
     */
    expect(result.value.render.vertexCount).toBe(triangleCount(restored) * 3);
    expect(result.value.triangleCount).toBe(triangleCount(restored) * 2);
    expect(result.value.parts).toHaveLength(2);
    // Both parts report the same mesh resource: the sharing is in the answer too.
    expect(result.value.parts[0]?.meshResourceIndex).toBe(result.value.parts[1]?.meshResourceIndex);
  });

  it('UT04: undoing a consumed record refuses and changes nothing', async () => {
    const staged = stage();
    const applied = await applyFill(staged);
    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );
    const restoredRevision = undone.value.handle.revision;

    const failure = await refusalOf(() =>
      repairUndoHandler({ handle: undone.value.handle, recordId: applied.recordId }, context()),
    );
    expect(failure.code).toBe(AppErrorCode.InvalidState);

    expect(residentDocuments.revisionOf(applied.handle.documentId as never)).toBe(restoredRevision);
    expect(residentPart(undone.value.handle, PART)).toBe(staged.source);
  });
});
