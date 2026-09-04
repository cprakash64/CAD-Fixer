import { beforeEach, describe, expect, it } from 'vitest';
import {
  meshByteLength,
  partId,
  singlePartDocument,
  triangleCount,
  type CanonicalMesh,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import {
  mp01TwoIndependentParts,
  mp02SharedGeometry,
  mp03DistinctTransforms,
  mp05SmallAndOversized,
  mp06RepairableDefect,
  mp08SharedPlacements,
  translation,
} from '@cadfixer/mesh-core/fixtures';
import {
  isDocument,
  isPart,
  RepairOperation,
  type DocumentHandle,
  type RepairCandidateHandle,
  type OperationContext,
  type ProtocolPort,
} from '@cadfixer/geometry-runtime';
import {
  AppErrorCode,
  isAppError,
  operationCancelled,
  SharedCancellationSource,
  uncancellable,
  type CancellationToken,
} from '@cadfixer/shared';
import { SELF_INTERSECTION_MAX_FACES } from '@cadfixer/mesh-self-intersection';
import {
  buildDocumentRenderSnapshot,
  describeParts,
  documentBounds,
  documentRenderTransferables,
  modelAnalyzeHandler,
  modelExportHandler,
  repairCandidates,
  repairHistory,
  residentDocuments,
  topologyReports,
} from './stl-handlers';
import {
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairPlanHandler,
  repairUndoHandler,
} from './repair-handlers';
import { modelSendForDiagnosticHandler } from './self-intersection-handlers';

/**
 * DF01–DF29 AT THE WORKER BOUNDARY.
 *
 * This is where the multi-part guarantees are either true or not: the worker
 * owns the authoritative document, and every guard the application relies on is
 * re-checked here. Testing them through React would prove only that a component
 * called something.
 *
 * The recurring question in almost every case below is the same one: two parts
 * of one document share a REVISION, so a handle alone cannot say which part a
 * result belongs to. Every case that would previously have been answered by
 * comparing handles now needs the part as well.
 */

const A = partId('a');
const B = partId('b');

function context(
  cancellation: CancellationToken = uncancellable,
  interruptible = true,
): OperationContext {
  return {
    cancellation,
    interruptible,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

function commit(document: GeometryDocument): DocumentHandle {
  return residentDocuments.commit(document);
}

function documentAt(handle: DocumentHandle): GeometryDocument {
  const resolved = residentDocuments.resolve(handle);
  if (!isDocument(resolved)) throw new Error('expected a resident document');
  return resolved;
}

function meshOf(handle: DocumentHandle, id = A): CanonicalMesh {
  const part = residentDocuments.resolvePart(handle, id);
  if (!isPart(part)) throw new Error('expected a part');
  return part.mesh;
}

/**
 * The error a handler produced, however it produced it.
 *
 * Some handlers are `async` and reject; `repair/commit` runs its guards
 * synchronously and throws before returning a promise. The worker host copes
 * with both, so a test calling a handler directly has to as well — using only
 * `.catch()` would miss exactly the synchronous refusals the guards exist for.
 */
async function refusalFrom(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (cause) {
    return cause;
  }
}

/** Literal bytes, captured so a later comparison is byte-for-byte and not a hash. */
function snapshotBytes(mesh: CanonicalMesh): {
  positions: Uint8Array;
  indices: Uint8Array;
} {
  return {
    positions: new Uint8Array(mesh.positions.buffer.slice(0) as ArrayBuffer),
    indices: new Uint8Array(mesh.indices.buffer.slice(0) as ArrayBuffer),
  };
}

function expectBytesUnchanged(
  before: { positions: Uint8Array; indices: Uint8Array },
  mesh: CanonicalMesh,
): void {
  const after = snapshotBytes(mesh);
  expect(after.positions.length).toBe(before.positions.length);
  expect(after.indices.length).toBe(before.indices.length);
  let differing = 0;
  for (let index = 0; index < before.positions.length; index += 1) {
    if (before.positions[index] !== after.positions[index]) differing += 1;
  }
  for (let index = 0; index < before.indices.length; index += 1) {
    if (before.indices[index] !== after.indices[index]) differing += 1;
  }
  expect(differing).toBe(0);
}

/** Builds a repair candidate for one part, returning everything needed to apply it. */
async function buildCandidate(
  handle: DocumentHandle,
  part: string,
): Promise<{ candidate: RepairCandidateHandle; planHash: string }> {
  const planned = await repairPlanHandler(
    { handle, partId: part, requested: [RepairOperation.RemoveDuplicateFaces] },
    context(),
  );
  const built = await repairCreateCandidateHandler(
    {
      handle,
      partId: part,
      requested: [RepairOperation.RemoveDuplicateFaces],
      planHash: planned.value.plan.planHash,
    },
    context(),
  );
  const candidate = built.value.candidate;
  if (candidate === undefined) throw new Error('expected an accepted candidate');
  return { candidate, planHash: planned.value.plan.planHash };
}

beforeEach(() => {
  residentDocuments.releaseAll();
  repairCandidates.releaseAll();
  repairHistory.releaseAll();
  topologyReports.releaseAll();
});

/* ------------------------------------------------------------- topology -- */

describe('topology is per part', () => {
  it('DF11: analysing A and B produces reports describing different meshes', async () => {
    const handle = commit(mp01TwoIndependentParts());

    const a = await modelAnalyzeHandler({ handle, partId: A }, context());
    const b = await modelAnalyzeHandler({ handle, partId: B }, context());

    expect(a.value.report.partId).toBe('a');
    expect(b.value.report.partId).toBe('b');
    // Same revision, different subjects — which is exactly why the part has to
    // be part of the identity.
    expect(a.value.handle.revision).toBe(b.value.handle.revision);
    expect(a.value.report.sourceFaceCount).toBe(triangleCount(meshOf(handle, A)));
    expect(b.value.report.sourceFaceCount).toBe(triangleCount(meshOf(handle, B)));
  });

  it('DF12: a report is echoed with the part it was computed for', async () => {
    const handle = commit(mp01TwoIndependentParts());

    const result = await modelAnalyzeHandler({ handle, partId: B }, context());

    // The consumer verifies this rather than trusting arrival order, so a report
    // for B can never be published against A.
    expect(result.value.partId).toBe('b');
    expect(result.value.report.partId).toBe('b');
  });

  it('DF13: a new document revision invalidates every part’s cached report', async () => {
    const handle = commit(mp06RepairableDefect());
    await modelAnalyzeHandler({ handle, partId: A }, context());
    await modelAnalyzeHandler({ handle, partId: B }, context());
    expect(topologyReports.get(handle, A)).toBeDefined();
    expect(topologyReports.get(handle, B)).toBeDefined();

    const { candidate, planHash } = await buildCandidate(handle, A);
    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );

    // Both, not just the repaired one: the document carries a single revision.
    expect(topologyReports.get(committed.value.handle, A)).toBeUndefined();
    expect(topologyReports.get(committed.value.handle, B)).toBeUndefined();
  });

  it('refuses to analyse a part that is not in this revision', async () => {
    const handle = commit(mp01TwoIndependentParts());

    const cause = await modelAnalyzeHandler({ handle, partId: partId('nope') }, context()).catch(
      (error: unknown) => error,
    );

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.ModelUnavailable);
  });

  it('does not combine disconnected parts into one topology', async () => {
    // Two closed tetrahedra analysed together would report 8 faces and one
    // combined vertex set. Analysed as parts, each reports its own.
    const handle = commit(mp01TwoIndependentParts());

    const a = await modelAnalyzeHandler({ handle, partId: A }, context());

    expect(a.value.report.sourceFaceCount).toBe(4);
  });
});

/* ---------------------------------------------------- self-intersection -- */

describe('self-intersection is per part', () => {
  function recordingPort(): { port: ProtocolPort; sent: { message: unknown }[] } {
    const sent: { message: unknown }[] = [];
    return {
      port: {
        postMessage(message: unknown): void {
          sent.push({ message });
        },
        close(): void {
          /* nothing to release in a stand-in */
        },
      },
      sent,
    };
  }

  it('DF14: the copy sent for a diagnostic names the part it came from', async () => {
    const handle = commit(mp01TwoIndependentParts());
    const { port, sent } = recordingPort();

    await modelSendForDiagnosticHandler(
      {
        handle,
        partId: B,
        operationId: 'op-1',
        port,
        limits: { maxCandidatePairs: 10, maxTestedPairs: 10, maxSamples: 5 },
      },
      context(),
    );

    const message = sent[0]?.message as { partId?: string; documentRevision?: number };
    expect(message.partId).toBe('b');
    expect(message.documentRevision).toBe(handle.revision);
  });

  it('DF15: two clean parts that overlap in world space send only ONE part’s faces', async () => {
    /*
     * The claim this protects. Two independently valid parts occupying the same
     * world space are NOT self-intersecting, and flattening the document before
     * the check would report that they are. What is copied is one part's mesh,
     * so the question asked is the only one that has an honest answer.
     */
    const handle = commit(mp02SharedGeometry());
    const { port, sent } = recordingPort();

    const result = await modelSendForDiagnosticHandler(
      {
        handle,
        partId: A,
        operationId: 'op-2',
        port,
        limits: { maxCandidatePairs: 10, maxTestedPairs: 10, maxSamples: 5 },
      },
      context(),
    );

    // One part's faces, not the document's total.
    expect(result.value.faceCount).toBe(triangleCount(meshOf(handle, A)));
    const message = sent[0]?.message as { triangles?: Uint32Array };
    expect(message.triangles?.length).toBe(triangleCount(meshOf(handle, A)) * 3);
  });

  it('DF18: an above-ceiling part is refused before any geometry is copied', async () => {
    const handle = commit(mp05SmallAndOversized(SELF_INTERSECTION_MAX_FACES + 1));
    const { port, sent } = recordingPort();

    const cause = await modelSendForDiagnosticHandler(
      {
        handle,
        partId: partId('huge'),
        operationId: 'op-3',
        port,
        limits: { maxCandidatePairs: 10, maxTestedPairs: 10, maxSamples: 5 },
      },
      context(),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.InvalidState);
    // Nothing was sent: no copy, no transfer, no allocation downstream.
    expect(sent).toHaveLength(0);
  });

  it('DF16/DF17: the small part of the same document is still checkable', async () => {
    // The oversized part does not poison the document. Policy is decided per
    // part, so a small part beside a huge one is unaffected.
    const handle = commit(mp05SmallAndOversized(SELF_INTERSECTION_MAX_FACES + 1));
    const { port, sent } = recordingPort();

    const result = await modelSendForDiagnosticHandler(
      {
        handle,
        partId: partId('small'),
        operationId: 'op-4',
        port,
        limits: { maxCandidatePairs: 10, maxTestedPairs: 10, maxSamples: 5 },
      },
      context(),
    );

    expect(result.value.faceCount).toBe(4);
    expect(sent).toHaveLength(1);
  });
});

/* --------------------------------------------------------------- repair -- */

describe('repair targets one part', () => {
  it('DF19: repairing A leaves B byte-identical AND reference-identical', async () => {
    const handle = commit(mp06RepairableDefect());
    const bBefore = meshOf(handle, B);
    const bBytes = snapshotBytes(bBefore);

    const { candidate, planHash } = await buildCandidate(handle, A);
    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );

    const bAfter = meshOf(committed.value.handle, B);
    // REFERENCE-identical: nothing copied B to change one triangle of A.
    expect(bAfter).toBe(bBefore);
    expectBytesUnchanged(bBytes, bAfter);
  });

  it('DF20: a candidate built from A cannot be applied to B', async () => {
    const handle = commit(mp06RepairableDefect());
    const { candidate, planHash } = await buildCandidate(handle, A);

    const cause = await refusalFrom(() =>
      repairCommitHandler(
        { candidate, expectedSource: handle, expectedPart: B, planHash },
        context(),
      ),
    );

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.InvalidState);
    expect(cause.details.candidatePartId).toBe('a');
    expect(cause.details.requestedPartId).toBe('b');
    // And the document is untouched: the refusal changed nothing.
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(handle.revision);
  });

  it('DF21: applying increments ONE document revision, not one per part', async () => {
    const handle = commit(mp06RepairableDefect());
    const { candidate, planHash } = await buildCandidate(handle, A);

    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );

    expect(committed.value.handle.revision).toBe(handle.revision + 1);
    expect(committed.value.parentRevision).toBe(handle.revision);
    expect(committed.value.partId).toBe('a');
    // Both parts still there, in order, with their ids intact.
    expect(documentAt(committed.value.handle).parts.map((part) => part.id)).toEqual(['a', 'b']);
  });

  it('the successor document keeps unit, order, ids and every placement', async () => {
    const handle = commit(mp06RepairableDefect());
    const before = documentAt(handle);
    const { candidate, planHash } = await buildCandidate(handle, A);

    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );
    const after = documentAt(committed.value.handle);

    expect(after.unit).toBe(before.unit);
    expect(after.parts.map((part) => part.id)).toEqual(before.parts.map((part) => part.id));
    expect(after.parts.map((part) => part.transform)).toEqual(
      before.parts.map((part) => part.transform),
    );
    expect(after.parts.map((part) => part.name)).toEqual(before.parts.map((part) => part.name));
  });

  it('DF22: cancelling leaves the WHOLE document unchanged and nothing resident', async () => {
    const handle = commit(mp06RepairableDefect());
    const aBytes = snapshotBytes(meshOf(handle, A));
    const bBytes = snapshotBytes(meshOf(handle, B));

    const planned = await repairPlanHandler(
      { handle, partId: A, requested: [RepairOperation.RemoveDuplicateFaces] },
      context(),
    );

    const source = new SharedCancellationSource();
    source.cancel();
    const cause = await repairCreateCandidateHandler(
      {
        handle,
        partId: A,
        requested: [RepairOperation.RemoveDuplicateFaces],
        planHash: planned.value.plan.planHash,
      },
      context(source.token),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.OperationCancelled);

    // The revision did not move, both parts are byte-identical, and no candidate
    // is resident for anything to commit later.
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(handle.revision);
    expectBytesUnchanged(aBytes, meshOf(handle, A));
    expectBytesUnchanged(bBytes, meshOf(handle, B));
    expect(repairCandidates.stats().candidateCount).toBe(0);
  });

  it('DF23: a repair retried after a cancellation succeeds', async () => {
    const handle = commit(mp06RepairableDefect());

    const planned = await repairPlanHandler(
      { handle, partId: A, requested: [RepairOperation.RemoveDuplicateFaces] },
      context(),
    );
    const cancelled = new SharedCancellationSource();
    cancelled.cancel();
    await repairCreateCandidateHandler(
      {
        handle,
        partId: A,
        requested: [RepairOperation.RemoveDuplicateFaces],
        planHash: planned.value.plan.planHash,
      },
      context(cancelled.token),
    ).catch(() => undefined);

    // The retry is an ordinary run against the same, unchanged revision.
    const { candidate, planHash } = await buildCandidate(handle, A);
    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );

    expect(committed.value.handle.revision).toBe(handle.revision + 1);
  });

  it('DF33: A’s source bytes are unchanged until the commit lands', async () => {
    const handle = commit(mp06RepairableDefect());
    const aBefore = meshOf(handle, A);
    const aBytes = snapshotBytes(aBefore);

    // Building a candidate is not applying one.
    await buildCandidate(handle, A);

    expect(meshOf(handle, A)).toBe(aBefore);
    expectBytesUnchanged(aBytes, meshOf(handle, A));
  });

  it('refuses to plan a repair for a part that does not exist', async () => {
    const handle = commit(mp06RepairableDefect());

    const cause = await repairPlanHandler(
      { handle, partId: partId('ghost'), requested: [RepairOperation.RemoveDuplicateFaces] },
      context(),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.ModelUnavailable);
  });

  it('binds the plan hash to the part, so A’s plan is not B’s plan', async () => {
    const handle = commit(mp06RepairableDefect());

    const a = await repairPlanHandler(
      { handle, partId: A, requested: [RepairOperation.RemoveDuplicateFaces] },
      context(),
    );
    const b = await repairPlanHandler(
      { handle, partId: B, requested: [RepairOperation.RemoveDuplicateFaces] },
      context(),
    );

    expect(a.value.plan.partId).toBe('a');
    expect(b.value.plan.partId).toBe('b');
    expect(a.value.plan.planHash).not.toBe(b.value.plan.planHash);
  });
});

/* ----------------------------------------------------------------- undo -- */

describe('undo is a document transaction that restores one part', () => {
  it('DF24/DF26: undo restores A as a NEW, higher revision', async () => {
    const handle = commit(mp06RepairableDefect());
    const aBefore = meshOf(handle, A);
    const aBytes = snapshotBytes(aBefore);

    const { candidate, planHash } = await buildCandidate(handle, A);
    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );
    expect(committed.value.undoable).toBe(true);

    const undone = await repairUndoHandler(
      { handle: committed.value.handle, recordId: committed.value.repairRecordId },
      context(),
    );

    // A NEW revision, never a rewind. Revisions only move forwards.
    expect(undone.value.handle.revision).toBe(committed.value.handle.revision + 1);
    expect(undone.value.revertedRevision).toBe(committed.value.handle.revision);
    expect(undone.value.partId).toBe('a');
    // And A's coordinates are back, byte for byte.
    expectBytesUnchanged(aBytes, meshOf(undone.value.handle, A));
  });

  it('DF25: the unaffected part is still the SAME object after an undo', async () => {
    const handle = commit(mp06RepairableDefect());
    const bBefore = meshOf(handle, B);

    const { candidate, planHash } = await buildCandidate(handle, A);
    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );
    const undone = await repairUndoHandler(
      { handle: committed.value.handle, recordId: committed.value.repairRecordId },
      context(),
    );

    // Structural sharing survives commit AND undo — B was never copied to
    // record, apply or reverse a repair of A.
    expect(meshOf(undone.value.handle, B)).toBe(bBefore);
  });

  it('restores the part the RECORD names, not whatever the caller last selected', async () => {
    const handle = commit(mp06RepairableDefect());
    const { candidate, planHash } = await buildCandidate(handle, A);
    const committed = await repairCommitHandler(
      { candidate, expectedSource: handle, expectedPart: A, planHash },
      context(),
    );

    const undone = await repairUndoHandler(
      { handle: committed.value.handle, recordId: committed.value.repairRecordId },
      context(),
    );

    // The undo payload carries no part at all: the patch was computed against
    // one specific mesh, and applying it to another would reconstruct nonsense.
    expect(undone.value.partId).toBe('a');
  });
});

/* ------------------------------------------------------- import/export -- */

describe('STL export of a document', () => {
  it('DF29: exporting one part of a multi-part document says what it left out', async () => {
    const handle = commit(mp01TwoIndependentParts());

    const written = await modelExportHandler({ handle, partId: A, encoding: 'binary' }, context());

    const codes = written.value.warnings.map((warning) => warning.code);
    expect(codes).toContain('STL_EXPORT_SINGLE_PART');
    const note = written.value.warnings.find(
      (warning) => warning.code === 'STL_EXPORT_SINGLE_PART',
    );
    expect(note?.message).toContain('only the selected part');
  });

  it('a single-part document exports with no loss warning at all', async () => {
    const source = mp01TwoIndependentParts().parts[0]?.mesh;
    if (source === undefined) throw new Error('expected a mesh');
    const handle = commit(singlePartDocument(source));

    const written = await modelExportHandler(
      { handle, partId: partId('part-1'), encoding: 'binary' },
      context(),
    );

    expect(
      written.value.warnings.some((warning) => warning.code === 'STL_EXPORT_SINGLE_PART'),
    ).toBe(false);
    // 84-byte prefix plus four 50-byte facets: the STL-era contract, unchanged.
    expect(written.value.byteLength).toBe(84 + 4 * 50);
  });

  it('refuses to export a part that is not in this revision', async () => {
    const handle = commit(mp01TwoIndependentParts());

    const cause = await modelExportHandler(
      { handle, partId: partId('nope'), encoding: 'binary' },
      context(),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.ModelUnavailable);
  });
});

/* -------------------------------------------------------- render snapshot -- */

describe('the document render snapshot', () => {
  it('DF07: builds one entry per part, carrying each part’s placement', () => {
    const snapshot = buildDocumentRenderSnapshot(mp03DistinctTransforms());

    expect(snapshot.parts.map((part) => part.partId)).toEqual(['a', 'b', 'c']);
    expect(snapshot.parts[1]?.transform).toEqual(translation(3, 0, 0));
    expect(snapshot.parts[2]?.transform).toEqual(translation(0, 7, -2));
  });

  it('DF08: the placement travels BESIDE the positions, never baked into them', () => {
    /*
     * If a transform were applied to the buffers, two placements of one
     * component would become two unrelated meshes — destroying exactly the
     * structure a re-export needs, and doing it irreversibly in Float32.
     */
    const document = mp03DistinctTransforms();
    const snapshot = buildDocumentRenderSnapshot(document);
    const sourcePositions = document.parts[0]?.mesh.positions;

    for (const part of snapshot.parts) {
      expect([...part.positions]).toEqual([...(sourcePositions ?? [])]);
    }
  });

  it('DF03: parts sharing a mesh share ONE Float32Array in the snapshot', () => {
    // Structured clone preserves object identity, so the main thread receives
    // them still shared — which is what lets the viewport upload once.
    const snapshot = buildDocumentRenderSnapshot(mp08SharedPlacements(50));

    const first = snapshot.parts[0];
    if (first === undefined) throw new Error('expected a part');
    for (const part of snapshot.parts) {
      expect(part.positions).toBe(first.positions);
      expect(part.normals).toBe(first.normals);
    }
  });

  it('deduplicates the transfer list, which shared buffers guarantee needs doing', () => {
    // Passing one buffer twice throws `DataCloneError`, so this is not a
    // tidiness concern — an un-deduplicated list would make every shared-geometry
    // document fail to send at all.
    const snapshot = buildDocumentRenderSnapshot(mp08SharedPlacements(50));

    const transfer = documentRenderTransferables(snapshot);

    expect(transfer).toHaveLength(2);
    expect(new Set(transfer).size).toBe(2);
  });

  it('gives parts with different meshes their own buffers', () => {
    const snapshot = buildDocumentRenderSnapshot(mp01TwoIndependentParts());

    expect(snapshot.parts[0]?.positions).not.toBe(snapshot.parts[1]?.positions);
    expect(documentRenderTransferables(snapshot)).toHaveLength(4);
  });

  it('reports one descriptor per part, sharing a mesh RESOURCE INDEX where geometry is shared', () => {
    const descriptors = describeParts(mp02SharedGeometry());

    expect(descriptors).toHaveLength(2);
    expect(descriptors[0]?.meshResourceIndex).toBe(descriptors[1]?.meshResourceIndex);
  });

  it('gives independent parts distinct mesh resource indices', () => {
    const descriptors = describeParts(mp01TwoIndependentParts());

    expect(descriptors[0]?.meshResourceIndex).toBe(0);
    expect(descriptors[1]?.meshResourceIndex).toBe(1);
  });

  it('DF08: document bounds union every part AFTER its placement', () => {
    // A document whose parts sit apart must frame all of them. Using only the
    // first part's box would leave the rest off screen.
    const bounds = documentBounds(mp03DistinctTransforms());

    expect(bounds).toBeDefined();
    if (bounds === undefined) return;
    expect(bounds.max[0]).toBeGreaterThanOrEqual(3);
    expect(bounds.max[1]).toBeGreaterThanOrEqual(7);
    expect(bounds.min[2]).toBeLessThanOrEqual(-2);
  });
});

/* ------------------------------------------------------- resident bytes -- */

describe('resident accounting', () => {
  it('DF03: a thousand shared placements cost one mesh, not a thousand', () => {
    const document = mp08SharedPlacements(1000);
    const handle = commit(document);
    const only = document.parts[0]?.mesh;
    if (only === undefined) throw new Error('expected a mesh');

    expect(residentDocuments.stats().partCount).toBe(1000);
    expect(residentDocuments.stats().totalBytes).toBe(meshByteLength(only));
    expect(documentAt(handle).parts[999]?.mesh).toBe(only);
  });
});
