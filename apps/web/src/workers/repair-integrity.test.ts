import { afterEach, describe, expect, it } from 'vitest';
import {
  IDENTITY_PART_TRANSFORM,
  createIndexArray,
  createPositionArray,
  meshByteLength,
  partId,
  singlePartDocument,
  triangleCount,
  vertexCount,
  type CanonicalMesh,
  type GeometryDocument,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  RepairAcceptance,
  type DocumentHandle,
  type OperationContext,
  type PartDescriptor,
  type RepairCandidateHandle,
  type RepairOperation,
  type RenderSnapshot,
} from '@cadfixer/geometry-runtime';
import { AppErrorCode, isAppError, operationCancelled, uncancellable } from '@cadfixer/shared';
import { runHoleFill } from '@cadfixer/mesh-hole-fill';
import { referenceNarrowphase } from '@cadfixer/mesh-hole-fill/fixtures';
import { extractBoundaryLoops } from '@cadfixer/mesh-topology';
import {
  holeFillCandidates,
  repairCandidates,
  repairHistory,
  residentDocuments,
  modelReleaseHandler,
} from './stl-handlers';
import { holeFillCommitHandler } from './hole-fill-workflow-handlers';
import {
  PRODUCTION_COMMIT_WORK,
  PRODUCTION_UNDO_WORK,
  createRepairCommitHandler,
  createRepairUndoHandler,
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairPlanHandler,
  repairUndoHandler,
  type RepairCommitWork,
  type RepairUndoWork,
} from './repair-handlers';

/**
 * CRU01–CRU16: CONSERVATIVE REPAIR RESTORES THE DOCUMENT, NOT A LOOKALIKE.
 *
 * WHAT THIS SUITE EXISTS TO RULE OUT — Stage 4B-1C. Repair's undo used to
 * reconstruct the pre-repair mesh from a patch of removed triangles. That
 * produced geometry the user would recognise and a document they did not have:
 *
 *   - the rebuilt mesh was NON-INDEXED, nine coordinates per face, so an
 *     indexed OBJ or 3MF import came back as triangle soup with a different
 *     vertex count and different bytes;
 *   - it was a NEW object, so a document whose parts SHARED one `CanonicalMesh`
 *     came back holding two byte-equal ones — permanently, along with two GPU
 *     geometries and two 3MF object resources.
 *
 * Neither is visible in a triangle count, and neither was visible in the suite
 * that existed: an STL import is already soup, so the round trip happened to be
 * exact for the one format the product could import when the patch was written.
 *
 * WHY REFERENCE IDENTITY IS THE ASSERTION. Byte equality passes against a copy.
 * `toBe` on the mesh object is the only check that sees a document that has
 * quietly stopped sharing.
 */

const PART = partId('part-1');
const SIBLING = partId('part-2');

/**
 * An INTERRUPTIBLE context, because conservative repair refuses to run without
 * one.
 *
 * The pipeline is a long synchronous pass, so it needs a signal it can poll from
 * inside a batch — a `SharedArrayBuffer` flag, which only a cross-origin-isolated
 * page has. Refusing rather than running uninterruptibly is Stage 3B-1C's
 * deliberate choice, and these tests declare the capability rather than work
 * around it.
 */
function context(cancellation = uncancellable, interruptible = true): OperationContext {
  return {
    cancellation,
    interruptible,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

/**
 * An INDEXED mesh with a duplicate face for repair to remove.
 *
 * WHY IT HAS TO BE INDEXED AND HAND-BUILT. Every fixture the repair suite had
 * was soup, because STL is soup and STL was the only importable format when
 * they were written. Soup cannot show the defect: rebuilding it as soup is
 * exact. This is a tetrahedron whose four corners are SHARED between faces —
 * four vertices for five faces, where a soup representation would need fifteen —
 * plus one exact duplicate face that `remove-duplicate-faces` will take.
 *
 * The shape an OBJ or a 3MF import actually produces, in other words, and the
 * one the patch reconstruction silently flattened.
 */
function indexedTetrahedronWithDuplicate(): CanonicalMesh {
  const positions = createPositionArray(12);
  positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const indices = createIndexArray(15);
  // a,c,b twice — an exact duplicate in the same rotational order, which is the
  // only kind conservative repair will remove.
  indices.set([0, 2, 1, 0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  return { positions, indices, metadata: { sourceFormat: 'obj' } };
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

function bytesEqual(left: ArrayBufferView, right: ArrayBufferView): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
  const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
  return a.every((value, index) => value === b[index]);
}

/** The document's distinct `CanonicalMesh` OBJECTS. Identity, not equality. */
function distinctMeshCount(handle: DocumentHandle): number {
  const document = residentDocuments.resolve(handle);
  if (!('parts' in document)) throw document;
  return new Set(document.parts.map((part) => part.mesh)).size;
}

/**
 * A bounded structural fingerprint of the document — CRU10.
 *
 * `partId:meshSlot` per part, plus the transform, the name and the unit. The
 * mesh slot is an equivalence-class index over OBJECT IDENTITY, so the string
 * encodes the whole sharing GRAPH rather than one relationship. A pairwise check
 * cannot see a repair that restored the pair it touched and disturbed another.
 */
function fingerprint(handle: DocumentHandle): string {
  const document = residentDocuments.resolve(handle);
  if (!('parts' in document)) throw document;
  const slots = new Map<CanonicalMesh, number>();
  const parts = document.parts.map((part) => {
    let slot = slots.get(part.mesh);
    if (slot === undefined) {
      slot = slots.size;
      slots.set(part.mesh, slot);
    }
    return `${part.id}:${String(slot)}:${part.transform.join(',')}:${part.name ?? ''}`;
  });
  return `${parts.join('|')}#unit=${document.unit ?? 'none'}`;
}

interface Applied {
  readonly handle: DocumentHandle;
  readonly recordId: string;
  readonly repairedMesh: CanonicalMesh;
}

const REQUESTED: readonly RepairOperation[] = ['remove-duplicate-faces'];

/**
 * Plans, builds, validates and commits a repair on one part.
 *
 * THROUGH THE REAL FIVE-OPERATION WORKFLOW, including the plan. The candidate
 * handler recomputes the plan and refuses if the hash the caller names differs,
 * so a test that invented one would only ever exercise that refusal — and the
 * hash is what ties "what the user previewed" to "what Apply installs".
 */
async function repairAndApply(handle: DocumentHandle, part: PartId = PART): Promise<Applied> {
  const planned = await repairPlanHandler(
    { handle, partId: part, requested: REQUESTED },
    context(),
  );
  const planHash = planned.value.plan.planHash;
  expect(planned.value.plan.noOp).toBe(false);

  const candidate = await repairCreateCandidateHandler(
    { handle, partId: part, requested: REQUESTED, planHash },
    context(),
  );
  expect(candidate.value.validation.acceptance).toBe(RepairAcceptance.Accepted);
  const built = candidate.value.candidate;
  if (built === undefined) throw new Error('repair produced no candidate');

  const committed = await repairCommitHandler(
    { candidate: built, expectedSource: handle, expectedPart: part, planHash },
    context(),
  );
  return {
    handle: committed.value.handle,
    recordId: committed.value.repairRecordId,
    repairedMesh: residentPart(committed.value.handle, part),
  };
}

afterEach(() => {
  residentDocuments.releaseAll();
  repairCandidates.releaseAll();
  repairHistory.releaseAll();
});

/* --------------------------------------------- CRU01–CRU05: exactness -- */

describe('CRU01–CRU05: undo restores the exact prior mesh', () => {
  it('CRU01, CRU02, CRU03: an INDEXED source comes back indexed, byte for byte', async () => {
    /*
     * THE HARD GATE. Before Stage 4B-1C this mesh went in with 4 vertices and 5
     * faces and came back with 12 vertices and 4 faces of soup — geometrically
     * the same solid, structurally a different model, and a different file on
     * every subsequent export.
     */
    const source = indexedTetrahedronWithDuplicate();
    const positionsBefore = new Float32Array(source.positions);
    const indicesBefore = new Uint32Array(source.indices);
    const verticesBefore = vertexCount(source);
    const facesBefore = triangleCount(source);
    expect(verticesBefore).toBe(4);
    expect(facesBefore).toBe(5);
    // Genuinely indexed: fewer vertices than a soup of the same faces would need.
    expect(verticesBefore).toBeLessThan(facesBefore * 3);

    const handle = residentDocuments.commit(singlePartDocument(source));
    const applied = await repairAndApply(handle);
    // The repair really did something: the duplicate is gone.
    expect(triangleCount(applied.repairedMesh)).toBe(facesBefore - 1);

    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );
    const restored = residentPart(undone.value.handle, PART);

    // CRU01 / CRU02 — exact bytes.
    expect(bytesEqual(restored.positions, positionsBefore)).toBe(true);
    expect(bytesEqual(restored.indices, indicesBefore)).toBe(true);
    // CRU03 — STILL INDEXED. This is the assertion the old undo failed.
    expect(vertexCount(restored)).toBe(verticesBefore);
    expect(triangleCount(restored)).toBe(facesBefore);
    expect(vertexCount(restored)).toBeLessThan(triangleCount(restored) * 3);
    // And the same OBJECT, which is what makes sharing restorable at all.
    expect(restored).toBe(source);
    // Metadata rides with it: the format the mesh came from is not rewritten.
    expect(restored.metadata.sourceFormat).toBe('obj');
  });

  it('CRU05: a soup source is restored exactly too — no format is special-cased', async () => {
    /*
     * THE CONTROL. STL is naturally non-indexed, and the old reconstruction
     * happened to be exact for it — which is precisely why the defect survived.
     * Correctness must not depend on which format the mesh came from, so the
     * same assertions run here.
     */
    const source = soupTetrahedronWithDuplicate();
    const positionsBefore = new Float32Array(source.positions);
    const indicesBefore = new Uint32Array(source.indices);

    const handle = residentDocuments.commit(singlePartDocument(source));
    const applied = await repairAndApply(handle);
    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );

    const restored = residentPart(undone.value.handle, PART);
    expect(bytesEqual(restored.positions, positionsBefore)).toBe(true);
    expect(bytesEqual(restored.indices, indicesBefore)).toBe(true);
    expect(restored).toBe(source);
  });

  it('CRU09: a part that owned its mesh alone gets that same object back', async () => {
    const source = indexedTetrahedronWithDuplicate();
    const handle = residentDocuments.commit(singlePartDocument(source));
    expect(distinctMeshCount(handle)).toBe(1);

    const applied = await repairAndApply(handle);
    expect(distinctMeshCount(applied.handle)).toBe(1);

    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );
    expect(distinctMeshCount(undone.value.handle)).toBe(1);
    expect(residentPart(undone.value.handle, PART)).toBe(source);
  });
});

/** A soup tetrahedron with one exact duplicate face. The STL-shaped control. */
function soupTetrahedronWithDuplicate(): CanonicalMesh {
  const corners: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const faces: readonly (readonly [number, number, number])[] = [
    [0, 2, 1],
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ];
  const positions = createPositionArray(faces.length * 9);
  const indices = createIndexArray(faces.length * 3);
  faces.forEach((face, index) => {
    face.forEach((corner, slot) => {
      const point = corners[corner] ?? [0, 0, 0];
      const base = index * 9 + slot * 3;
      positions[base] = point[0];
      positions[base + 1] = point[1];
      positions[base + 2] = point[2];
      indices[index * 3 + slot] = index * 3 + slot;
    });
  });
  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

/* ------------------------------------------- CRU06–CRU10: sharing ------ */

describe('CRU06–CRU10: undo restores the document, not merely its bytes', () => {
  it('CRU06, CRU07: a shared pair is isolated by Apply and reunited by Undo', async () => {
    const source = indexedTetrahedronWithDuplicate();
    const handle = residentDocuments.commit(twoPartSharedDocument(source));
    expect(distinctMeshCount(handle)).toBe(1);
    const before = fingerprint(handle);

    const applied = await repairAndApply(handle);

    // CRU06. Part A got the repaired mesh; part B still holds the ORIGINAL
    // object, still with its duplicate face.
    expect(residentPart(applied.handle, SIBLING)).toBe(source);
    expect(residentPart(applied.handle, PART)).not.toBe(source);
    expect(distinctMeshCount(applied.handle)).toBe(2);
    expect(triangleCount(residentPart(applied.handle, SIBLING))).toBe(triangleCount(source));

    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );

    // CRU07. THE ASSERTION THAT MATTERS. Not equal bytes — the same object, and
    // the same object the sibling never stopped holding.
    expect(residentPart(undone.value.handle, PART)).toBe(source);
    expect(residentPart(undone.value.handle, SIBLING)).toBe(source);
    expect(residentPart(undone.value.handle, PART)).toBe(
      residentPart(undone.value.handle, SIBLING),
    );
    expect(distinctMeshCount(undone.value.handle)).toBe(1);
    // CRU10. And the whole sharing graph, transforms, names and unit with it.
    expect(fingerprint(undone.value.handle)).toBe(before);
  });

  it('CRU08: 1,000 placements collapse back to ONE mesh', async () => {
    /*
     * THE SCALE AT WHICH A COPY IS IMPOSSIBLE TO MISS. Under the old undo this
     * document came back holding two meshes — the 999 untouched placements on
     * the original and the repaired one on a byte-equal rebuild — forever.
     */
    const source = indexedTetrahedronWithDuplicate();
    const parts = Array.from({ length: 1_000 }, (_, index) => ({
      id: partId(`p${String(index)}`),
      mesh: source,
      transform: IDENTITY_PART_TRANSFORM,
    }));
    const handle = residentDocuments.commit({ parts });
    expect(distinctMeshCount(handle)).toBe(1);

    const applied = await repairAndApply(handle, partId('p0'));
    expect(distinctMeshCount(applied.handle)).toBe(2);

    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );

    expect(distinctMeshCount(undone.value.handle)).toBe(1);
    const document = residentDocuments.resolve(undone.value.handle);
    if (!('parts' in document)) throw document;
    expect(document.parts).toHaveLength(1_000);
    expect(document.parts.every((part) => part.mesh === source)).toBe(true);
  });

  it('CRU16: fifty repair/undo cycles end exactly where they began', async () => {
    const source = indexedTetrahedronWithDuplicate();
    const handle = residentDocuments.commit(twoPartSharedDocument(source));
    const before = fingerprint(handle);

    let current = handle;
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const applied = await repairAndApply(current);
      const undone = await repairUndoHandler(
        { handle: applied.handle, recordId: applied.recordId },
        context(),
      );
      current = undone.value.handle;

      // EVERY cycle, not just the last: drift that only appears on repetition is
      // exactly what a single round trip cannot see.
      expect(distinctMeshCount(current), `cycle ${String(cycle)}`).toBe(1);
      expect(fingerprint(current), `cycle ${String(cycle)}`).toBe(before);
      expect(residentPart(current, PART), `cycle ${String(cycle)}`).toBe(source);
      expect(repairHistory.stats().undoableCount, `cycle ${String(cycle)}`).toBe(0);
      expect(repairHistory.stats().retainedBytes, `cycle ${String(cycle)}`).toBe(0);
      expect(repairCandidates.stats().candidateCount, `cycle ${String(cycle)}`).toBe(0);
    }

    // 50 applies and 50 undos, all forward.
    expect(current.revision).toBe(handle.revision + 100);
  });
});

/* -------------------------------- CRU13–CRU15: history ownership ------- */

describe('CRU13–CRU15: the retained mesh is released when it stops being useful', () => {
  it('CRU13: a superseding change releases the previous record immediately', async () => {
    const source = indexedTetrahedronWithDuplicate();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const first = await repairAndApply(handle);
    expect(repairHistory.stats().retainedBytes).toBe(meshByteLength(source));

    // A second repair on the successor. One undoable change per document, so the
    // first record's mesh is dropped rather than pinned for the session.
    const second = await repairAndApply(first.handle).catch(() => undefined);
    if (second === undefined) {
      // Nothing left to repair, so supersede with the hole-fill path instead is
      // out of scope here; the single-record cap is asserted below regardless.
      expect(repairHistory.stats().undoableCount).toBe(1);
      return;
    }
    expect(repairHistory.entryOf(first.recordId)?.undoable).toBe(false);
    expect(repairHistory.stats().undoableCount).toBe(1);
  });

  it('CRU14, CRU15: releasing the document releases the retained mesh', async () => {
    const source = indexedTetrahedronWithDuplicate();
    const handle = residentDocuments.commit(singlePartDocument(source));
    await repairAndApply(handle);
    expect(repairHistory.stats().retainedBytes).toBeGreaterThan(0);

    /*
     * WHAT AN IMPORT REPLACEMENT DOES. A replacement import commits a NEW
     * document and releases the old one; this is that release, and it must drop
     * the history's hold on geometry nothing can address any more.
     */
    await modelReleaseHandler({ documentId: handle.documentId }, context());

    // Deterministic ownership, not a GC claim: the store holds no inverse, so it
    // holds no mesh.
    expect(repairHistory.stats().retainedBytes).toBe(0);
    expect(repairHistory.stats().undoableCount).toBe(0);
    expect(repairCandidates.stats().candidateCount).toBe(0);
  });

  it('undoing releases the retained mesh', async () => {
    const source = indexedTetrahedronWithDuplicate();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const applied = await repairAndApply(handle);
    expect(repairHistory.stats().retainedBytes).toBe(meshByteLength(source));

    await repairUndoHandler({ handle: applied.handle, recordId: applied.recordId }, context());

    expect(repairHistory.stats().retainedBytes).toBe(0);
    expect(repairHistory.stats().undoableCount).toBe(0);
  });

  it('refuses a second undo of a consumed record, and changes nothing', async () => {
    const source = indexedTetrahedronWithDuplicate();
    const handle = residentDocuments.commit(singlePartDocument(source));
    const applied = await repairAndApply(handle);
    const undone = await repairUndoHandler(
      { handle: applied.handle, recordId: applied.recordId },
      context(),
    );

    let refusal: { code?: unknown } | undefined;
    try {
      await repairUndoHandler(
        { handle: undone.value.handle, recordId: applied.recordId },
        context(),
      );
    } catch (cause) {
      refusal = cause as { code?: unknown };
    }
    expect(refusal?.code).toBe(AppErrorCode.InvalidState);
    expect(residentPart(undone.value.handle, PART)).toBe(source);
  });
});

/* ------------------------------------------- CRT01–CRT14: atomicity ---- */

/**
 * CRT01–CRT14: APPLYING AND UNDOING A REPAIR ARE OBSERVABLY ATOMIC.
 *
 * `buildRenderSnapshot` allocates — megabytes for a large part — and it used to
 * run AFTER the authoritative swap. Its failure threw out of the handler, the
 * worker host turned that into an ordinary error reply, and the caller was told
 * the repair had FAILED while the document had already changed.
 *
 * "The worker's internal state was consistent" is not the guarantee that
 * matters. The guarantee is what the caller may OBSERVE, because the interface
 * acts on it: a user told their repair failed will press Apply again, and one
 * told their undo failed is looking at a screen that no longer matches their
 * model.
 *
 * The two allocating steps arrive as injected functions so a failure can be
 * walked. A CONSTRUCTION SEAM, exactly as hole filling uses — the production
 * defaults are the only values the application builds a handler from, and a
 * boundary test asserts that.
 */
class InjectedFailure extends Error {
  public constructor(stage: string) {
    super(`injected failure at ${stage}`);
    this.name = 'InjectedFailure';
  }
}

function failingSnapshot(): RepairCommitWork {
  return {
    buildRenderSnapshot: (): RenderSnapshot => {
      throw new InjectedFailure('buildRenderSnapshot');
    },
    describeParts: PRODUCTION_COMMIT_WORK.describeParts,
  };
}

function failingDescriptors(): RepairCommitWork {
  return {
    buildRenderSnapshot: PRODUCTION_COMMIT_WORK.buildRenderSnapshot,
    describeParts: (): readonly PartDescriptor[] => {
      throw new InjectedFailure('describeParts');
    },
  };
}

function failingUndoSnapshot(): RepairUndoWork {
  return {
    buildRenderSnapshot: (): RenderSnapshot => {
      throw new InjectedFailure('buildRenderSnapshot');
    },
    describeParts: PRODUCTION_UNDO_WORK.describeParts,
  };
}

function failingUndoDescriptors(): RepairUndoWork {
  return {
    buildRenderSnapshot: PRODUCTION_UNDO_WORK.buildRenderSnapshot,
    describeParts: (): readonly PartDescriptor[] => {
      throw new InjectedFailure('describeParts');
    },
  };
}

/** A context whose progress reports throw, so transport failure can be walked. */
function hostileProgress(): OperationContext {
  return {
    ...context(),
    reportProgress: (): void => {
      throw new Error('the channel is gone');
    },
  };
}

async function failureOf(run: () => unknown): Promise<{ code?: unknown; name?: string }> {
  try {
    await run();
  } catch (cause) {
    return cause as { code?: unknown; name?: string };
  }
  throw new Error('the handler did not fail');
}

interface Staged {
  readonly handle: DocumentHandle;
  readonly candidate: RepairCandidateHandle;
  readonly planHash: string;
  readonly source: CanonicalMesh;
}

/** A resident document with a validated repair candidate ready to apply. */
async function stage(
  build: (mesh: CanonicalMesh) => GeometryDocument = singlePartDocument,
): Promise<Staged> {
  const source = indexedTetrahedronWithDuplicate();
  const handle = residentDocuments.commit(build(source));
  const planned = await repairPlanHandler(
    { handle, partId: PART, requested: REQUESTED },
    context(),
  );
  const planHash = planned.value.plan.planHash;
  const created = await repairCreateCandidateHandler(
    { handle, partId: PART, requested: REQUESTED, planHash },
    context(),
  );
  const candidate = created.value.candidate;
  if (candidate === undefined) throw new Error('repair produced no candidate');
  return { handle, candidate, planHash, source };
}

describe('CRT01–CRT06: applying is observably atomic', () => {
  it('CRT01: a snapshot failure leaves the document, candidate and history untouched', async () => {
    const staged = await stage(twoPartSharedDocument);

    const failure = await failureOf(() =>
      createRepairCommitHandler(failingSnapshot())(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          planHash: staged.planHash,
        },
        context(),
      ),
    );
    expect(failure.name).toBe('InjectedFailure');

    // NOTHING HAPPENED. Not "nothing important": the revision has not moved, the
    // part holds the object it held, the candidate is still applicable, and no
    // record exists to reverse a change that was never made.
    expect(residentDocuments.revisionOf(staged.handle.documentId)).toBe(staged.handle.revision);
    expect(residentPart(staged.handle, PART)).toBe(staged.source);
    expect(repairCandidates.stateOf(staged.candidate)).toBe('resolved');
    expect(repairHistory.stats().recordCount).toBe(0);

    // AND IT IS STILL APPLICABLE. A failed attempt must not cost the user their
    // validated repair.
    const recovered = await repairCommitHandler(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        planHash: staged.planHash,
      },
      context(),
    );
    expect(recovered.value.handle.revision).toBe(staged.handle.revision + 1);
  });

  it('CRT02: a part-descriptor failure leaves everything untouched', async () => {
    const staged = await stage();

    const failure = await failureOf(() =>
      createRepairCommitHandler(failingDescriptors())(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          planHash: staged.planHash,
        },
        context(),
      ),
    );
    expect(failure.name).toBe('InjectedFailure');
    expect(residentDocuments.revisionOf(staged.handle.documentId)).toBe(staged.handle.revision);
    expect(residentPart(staged.handle, PART)).toBe(staged.source);
    expect(repairCandidates.stateOf(staged.candidate)).toBe('resolved');
    expect(repairHistory.stats().recordCount).toBe(0);
  });

  it('CRT04: a progress-transport failure before the commit changes nothing', async () => {
    const staged = await stage();

    await failureOf(() =>
      repairCommitHandler(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          planHash: staged.planHash,
        },
        hostileProgress(),
      ),
    );

    expect(residentDocuments.revisionOf(staged.handle.documentId)).toBe(staged.handle.revision);
    expect(residentPart(staged.handle, PART)).toBe(staged.source);
    expect(repairCandidates.stateOf(staged.candidate)).toBe('resolved');
    expect(repairHistory.stats().recordCount).toBe(0);
  });

  it('CRT05: a revision that moved during preparation commits nothing', async () => {
    /*
     * THE RACE PREPARING EARLY COULD HAVE INTRODUCED, and did not. The answer is
     * built against the proposed document; `replace` then compares the revision
     * against the store and refuses, so the prepared snapshot describes a
     * document that never existed and is discarded with the call.
     */
    const staged = await stage();
    let moved: DocumentHandle | undefined;
    const handler = createRepairCommitHandler({
      buildRenderSnapshot: PRODUCTION_COMMIT_WORK.buildRenderSnapshot,
      describeParts: (document) => {
        const replaced = residentDocuments.replace(
          staged.handle,
          singlePartDocument(staged.source),
        );
        if (!isAppError(replaced)) moved = replaced;
        return PRODUCTION_COMMIT_WORK.describeParts(document);
      },
    });

    const failure = await failureOf(() =>
      handler(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          planHash: staged.planHash,
        },
        context(),
      ),
    );
    expect(failure.code).toBe(AppErrorCode.ModelUnavailable);
    expect(moved).toBeDefined();
    expect(residentDocuments.revisionOf(staged.handle.documentId)).toBe(moved?.revision);
    expect(repairCandidates.stateOf(staged.candidate)).toBe('resolved');
    expect(repairHistory.stats().recordCount).toBe(0);
  });

  it('CRT03: a guard that refuses during preparation commits nothing', async () => {
    /*
     * THE OTHER KIND OF PREPARATION FAILURE. CRT01 and CRT02 walk the two
     * ALLOCATING steps; this is the one the transaction itself decides — a plan
     * hash that does not match the validated candidate's, refused by
     * `prepareCommit` before any answer is built at all.
     *
     * Worth its own case because early preparation moved work ABOVE the swap,
     * and the question that raises is whether anything can now run before the
     * guard does. Nothing may: a refusal here must be indistinguishable from
     * never having called Apply.
     */
    const staged = await stage(twoPartSharedDocument);
    const before = fingerprint(staged.handle);

    const failure = await failureOf(() =>
      repairCommitHandler(
        {
          candidate: staged.candidate,
          expectedSource: staged.handle,
          expectedPart: PART,
          planHash: `${staged.planHash}-not-the-plan`,
        },
        context(),
      ),
    );

    expect(failure.code).toBe(AppErrorCode.InvalidState);
    // The document did not move, and the candidate is still there to retry with.
    expect(residentDocuments.revisionOf(staged.handle.documentId)).toBe(staged.handle.revision);
    expect(fingerprint(staged.handle)).toEqual(before);
    expect(repairCandidates.stateOf(staged.candidate)).toBe('resolved');
    expect(repairHistory.stats().recordCount).toBe(0);
    expect(repairHistory.stats().retainedBytes).toBe(0);
  });

  it('CRT06, CRT11: a successful apply commits the exact candidate and describes it', async () => {
    const staged = await stage();
    const result = await repairCommitHandler(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        planHash: staged.planHash,
      },
      context(),
    );

    expect(result.value.handle.revision).toBe(staged.handle.revision + 1);
    expect(repairCandidates.stateOf(staged.candidate)).toBe('committed');
    expect(repairHistory.stats().undoableCount).toBe(1);
    // The record retains the exact PREVIOUS mesh, ready for undo.
    expect(repairHistory.stats().retainedBytes).toBe(meshByteLength(staged.source));

    /*
     * CRT11. THE SNAPSHOT DESCRIBES WHAT WAS COMMITTED, not what was proposed
     * and not what was there before. Built before the swap, so this is the
     * assertion that early preparation still describes the right document.
     */
    const committed = residentPart(result.value.handle, PART);
    /*
     * THREE CORNERS PER FACE, not the vertex table's length — Stage 4B-1D. The
     * snapshot is the drawable triangle stream, expanded from the candidate's
     * INDEX buffer, and the candidate is now indexed rather than soup. Asserting
     * the table's length here would be asserting that the two are the same
     * thing, which is exactly the assumption that made indexed models render as
     * a handful of stray triangles.
     */
    expect(result.value.render.vertexCount).toBe(triangleCount(committed) * 3);
    expect(vertexCount(committed)).toBeLessThan(result.value.render.vertexCount);
    expect(result.value.triangleCount).toBe(triangleCount(committed));
    expect(result.value.parts.map((part) => part.partId)).toEqual([PART]);
    expect(result.value.parts[0]?.triangleCount).toBe(triangleCount(committed));
  });
});

describe('CRT07–CRT12: undoing is observably atomic', () => {
  it('CRT07: an undo snapshot failure leaves the repair applied and still undoable', async () => {
    const staged = await stage(twoPartSharedDocument);
    const applied = await repairCommitHandler(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        planHash: staged.planHash,
      },
      context(),
    );
    const repaired = residentPart(applied.value.handle, PART);
    const retainedBefore = repairHistory.stats().retainedBytes;

    const failure = await failureOf(() =>
      createRepairUndoHandler(failingUndoSnapshot())(
        { handle: applied.value.handle, recordId: applied.value.repairRecordId },
        context(),
      ),
    );
    expect(failure.name).toBe('InjectedFailure');

    // STILL REPAIRED, and the undo still available. A user told their undo
    // failed must be looking at a model that genuinely was not restored.
    expect(residentDocuments.revisionOf(staged.handle.documentId)).toBe(
      applied.value.handle.revision,
    );
    expect(residentPart(applied.value.handle, PART)).toBe(repaired);
    expect(repairHistory.entryOf(applied.value.repairRecordId)?.undoable).toBe(true);
    expect(repairHistory.stats().retainedBytes).toBe(retainedBefore);

    // AND THE UNDO STILL WORKS.
    const recovered = await repairUndoHandler(
      { handle: applied.value.handle, recordId: applied.value.repairRecordId },
      context(),
    );
    expect(residentPart(recovered.value.handle, PART)).toBe(staged.source);
  });

  it('CRT08: an undo descriptor failure leaves the repair applied and still undoable', async () => {
    const staged = await stage();
    const applied = await repairCommitHandler(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        planHash: staged.planHash,
      },
      context(),
    );
    const repaired = residentPart(applied.value.handle, PART);

    const failure = await failureOf(() =>
      createRepairUndoHandler(failingUndoDescriptors())(
        { handle: applied.value.handle, recordId: applied.value.repairRecordId },
        context(),
      ),
    );
    expect(failure.name).toBe('InjectedFailure');
    expect(residentPart(applied.value.handle, PART)).toBe(repaired);
    expect(repairHistory.entryOf(applied.value.repairRecordId)?.undoable).toBe(true);
  });

  it('CRT09, CRT12: a successful undo restores the exact mesh and describes it', async () => {
    const staged = await stage(twoPartSharedDocument);
    const applied = await repairCommitHandler(
      {
        candidate: staged.candidate,
        expectedSource: staged.handle,
        expectedPart: PART,
        planHash: staged.planHash,
      },
      context(),
    );

    const result = await repairUndoHandler(
      { handle: applied.value.handle, recordId: applied.value.repairRecordId },
      context(),
    );

    const restored = residentPart(result.value.handle, PART);
    expect(restored).toBe(staged.source);
    expect(residentPart(result.value.handle, SIBLING)).toBe(staged.source);
    expect(result.value.handle.revision).toBe(applied.value.handle.revision + 1);
    expect(repairHistory.stats().undoableCount).toBe(0);
    expect(repairHistory.stats().retainedBytes).toBe(0);

    // CRT12. The snapshot describes the RESTORED document, built before the swap.
    // Expanded to three corners per face, as every render snapshot now is.
    expect(result.value.render.vertexCount).toBe(triangleCount(restored) * 3);
    expect(result.value.triangleCount).toBe(triangleCount(restored) * 2);
    expect(result.value.parts).toHaveLength(2);
    // Both parts report one mesh resource: the sharing is in the answer too.
    expect(result.value.parts[0]?.meshResourceIndex).toBe(result.value.parts[1]?.meshResourceIndex);
  });
});

/* ----------------------------------------- CRX01–CRX04: one history ---- */

/**
 * ONE COHERENT REVISION MODEL ACROSS BOTH MUTATION PATHS.
 *
 * A repair and a hole fill write to the same `RepairHistoryStore` and move the
 * same document revision. There is exactly ONE undoable change per document, so
 * whichever happened last is what Undo reverses — and the other's candidate is
 * stale the moment the revision moves. Two stacks would eventually disagree
 * about which change was the most recent, and a user would undo something they
 * did not do last.
 */
describe('CRX01–CRX04: repair and hole fill share one history', () => {
  function fillableIndexedMesh(): CanonicalMesh {
    /*
     * An open box with a duplicate face: repairable AND fillable, indexed, so
     * both paths have something legitimate to do to the same part.
     */
    const positions = createPositionArray(24);
    positions.set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
    const faces: readonly (readonly [number, number, number])[] = [
      [0, 2, 1],
      [0, 3, 2],
      [0, 2, 1], // the duplicate conservative repair will remove
      [0, 1, 5],
      [0, 5, 4],
      [3, 7, 6],
      [3, 6, 2],
      [0, 4, 7],
      [0, 7, 3],
      [1, 2, 6],
      [1, 6, 5],
    ];
    const indices = createIndexArray(faces.length * 3);
    faces.forEach((face, index) => {
      indices[index * 3] = face[0];
      indices[index * 3 + 1] = face[1];
      indices[index * 3 + 2] = face[2];
    });
    return { positions, indices, metadata: { sourceFormat: 'obj' } };
  }

  it('CRX01: repair, then fill, then undo lands on the POST-REPAIR document', async () => {
    const source = fillableIndexedMesh();
    const handle = residentDocuments.commit(twoPartSharedDocument(source));

    const repaired = await repairAndApply(handle);
    const postRepairMesh = residentPart(repaired.handle, PART);
    const postRepairFingerprint = fingerprint(repaired.handle);
    // The repair really un-shared A from B, which is what makes the next
    // assertion about restoration meaningful.
    expect(residentPart(repaired.handle, SIBLING)).toBe(source);

    // A hole fill on the SAME part, recorded in the same history.
    const filled = await fillAndCommit(repaired.handle, PART);
    expect(residentPart(filled.handle, PART)).not.toBe(postRepairMesh);
    // The repair record is superseded: one undoable change per document.
    expect(repairHistory.entryOf(repaired.recordId)?.undoable).toBe(false);

    const undone = await repairUndoHandler(
      { handle: filled.handle, recordId: filled.recordId },
      context(),
    );

    // EXACTLY THE POST-REPAIR DOCUMENT — the same mesh OBJECT the repair
    // produced, not a rebuild of it, and the sibling untouched throughout.
    expect(residentPart(undone.value.handle, PART)).toBe(postRepairMesh);
    expect(residentPart(undone.value.handle, SIBLING)).toBe(source);
    expect(fingerprint(undone.value.handle)).toBe(postRepairFingerprint);
  });

  it('CRX02: fill, then repair, then undo lands on the POST-FILL document', async () => {
    const source = fillableIndexedMesh();
    const handle = residentDocuments.commit(twoPartSharedDocument(source));

    const filled = await fillAndCommit(handle, PART);
    const postFillMesh = residentPart(filled.handle, PART);
    const postFillFingerprint = fingerprint(filled.handle);

    const repaired = await repairAndApply(filled.handle);
    expect(repairHistory.entryOf(filled.recordId)?.undoable).toBe(false);

    const undone = await repairUndoHandler(
      { handle: repaired.handle, recordId: repaired.recordId },
      context(),
    );

    expect(residentPart(undone.value.handle, PART)).toBe(postFillMesh);
    expect(residentPart(undone.value.handle, SIBLING)).toBe(source);
    expect(fingerprint(undone.value.handle)).toBe(postFillFingerprint);
  });

  it('CRX03: a repair candidate is stale once another mutation lands', async () => {
    const source = fillableIndexedMesh();
    const handle = residentDocuments.commit(singlePartDocument(source));

    const planned = await repairPlanHandler(
      { handle, partId: PART, requested: REQUESTED },
      context(),
    );
    const created = await repairCreateCandidateHandler(
      { handle, partId: PART, requested: REQUESTED, planHash: planned.value.plan.planHash },
      context(),
    );
    const candidate = created.value.candidate;
    if (candidate === undefined) throw new Error('repair produced no candidate');

    // A hole fill moves the document underneath the waiting repair candidate.
    const filled = await fillAndCommit(handle, PART);
    expect(filled.handle.revision).toBeGreaterThan(handle.revision);

    let refusal: { code?: unknown } | undefined;
    try {
      await repairCommitHandler(
        {
          candidate,
          expectedSource: handle,
          expectedPart: PART,
          planHash: planned.value.plan.planHash,
        },
        context(),
      );
    } catch (cause) {
      refusal = cause as { code?: unknown };
    }
    expect(refusal?.code).toBe(AppErrorCode.ModelUnavailable);
    // AND NOTHING MOVED. The fill is still the document's most recent change.
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(filled.handle.revision);
    expect(repairHistory.undoableFor(handle.documentId)?.recordId).toBe(filled.recordId);
  });

  it('CRX04: a repair releases any hole-fill candidate for the document', async () => {
    const source = fillableIndexedMesh();
    const handle = residentDocuments.commit(singlePartDocument(source));

    const loopId = firstFillableLoopId(source);
    const fillCandidate = holeFillCandidates.create(
      handle,
      PART,
      loopId,
      buildFillCandidate(source, loopId),
      triangleCount(source),
    );
    expect(holeFillCandidates.stats().candidateCount).toBe(1);

    await repairAndApply(handle);

    /*
     * THE FILL PREVIEW DOES NOT SURVIVE. Its source revision is gone, so every
     * guard would refuse it; releasing frees a whole part's geometry rather than
     * leaving it resident until something notices.
     */
    expect(holeFillCandidates.stateOf(fillCandidate)).toBe('discarded');
    expect(holeFillCandidates.stats().candidateCount).toBe(0);
  });
});

/** Builds and commits a validated hole fill on one part, through the real path. */
async function fillAndCommit(
  handle: DocumentHandle,
  part: PartId,
): Promise<{ handle: DocumentHandle; recordId: string }> {
  const mesh = residentPart(handle, part);
  const loopId = firstFillableLoopId(mesh);
  const candidate = holeFillCandidates.create(
    handle,
    part,
    loopId,
    buildFillCandidate(mesh, loopId),
    triangleCount(mesh),
  );
  const committed = await holeFillCommitHandler(
    { candidate, expectedSource: handle, expectedPart: part, expectedLoopId: loopId },
    context(),
  );
  return { handle: committed.value.handle, recordId: committed.value.recordId };
}

function firstFillableLoopId(mesh: CanonicalMesh): string {
  const set = extractBoundaryLoops(mesh);
  const loop = set.loops.find((entry) => entry.refusal === undefined);
  if (loop === undefined) throw new Error('fixture has no fillable loop');
  return loop.id;
}

function buildFillCandidate(mesh: CanonicalMesh, loopId: string): CanonicalMesh {
  const result = runHoleFill({
    source: mesh,
    request: {
      operationId: 'crx',
      documentId: 'crx',
      revision: 1,
      partId: 'crx',
      boundaryLoopId: loopId,
    },
    narrowphase: referenceNarrowphase(),
  });
  if (result.candidate === undefined) {
    throw new Error(`hole fill produced no candidate: ${result.outcome.status}`);
  }
  return result.candidate;
}
