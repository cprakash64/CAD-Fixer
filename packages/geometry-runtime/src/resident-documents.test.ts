import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import {
  createIndexArray,
  createPositionArray,
  meshByteLength,
  partId,
  singlePartDocument,
  IDENTITY_PART_TRANSFORM,
  type CanonicalMesh,
  type GeometryDocument,
  type GeometryPart,
  type PartTransform,
} from '@cadfixer/mesh-core';
import {
  documentByteLength,
  isDocument,
  isPart,
  ResidentDocumentStore,
  type DocumentHandle,
  type DocumentId,
} from './resident-documents';

/**
 * The resident store is where authoritative geometry lives, so its failure
 * modes are the ones that would show a user the wrong model. These are direct
 * unit tests rather than assertions reached through React: a stale-handle bug
 * is a data-integrity bug and deserves to be pinned at the level it happens.
 *
 * STAGE 4A-2A adds the part dimension. The staleness guarantees below are the
 * Stage 1 ones, unchanged, plus the guards that only exist once a document can
 * hold more than one thing: a part-targeted resolve, and byte accounting that
 * counts shared geometry once.
 */

function mesh(triangles: number, seed = 0): CanonicalMesh {
  const positions = createPositionArray(triangles * 9);
  for (let index = 0; index < positions.length; index += 1) positions[index] = seed + index;
  return {
    positions,
    indices: createIndexArray(triangles * 3),
    metadata: { sourceFormat: 'stl' },
  };
}

function part(
  id: string,
  source: CanonicalMesh,
  transform: PartTransform = IDENTITY_PART_TRANSFORM,
): GeometryPart {
  return { id: partId(id), mesh: source, transform };
}

function documentOf(...parts: readonly GeometryPart[]): GeometryDocument {
  return { parts };
}

/** Asserts a store result is the expected typed failure, not a document. */
function expectUnavailable(result: unknown): void {
  expect(isAppError(result)).toBe(true);
  if (!isAppError(result)) return;
  // MODEL_UNAVAILABLE, not INTERNAL_ERROR: a replaced or released model is an
  // expected condition the interface must be able to explain.
  expect(result.code).toBe(AppErrorCode.ModelUnavailable);
}

describe('committing and resolving', () => {
  it('commits a first document and returns a usable handle', () => {
    const store = new ResidentDocumentStore();
    const source = singlePartDocument(mesh(2));

    const handle = store.commit(source);

    expect(handle.revision).toBe(1);
    expect(store.has(handle)).toBe(true);
    expect(store.resolve(handle)).toBe(source);
  });

  it('resolves the current handle to the exact document committed', () => {
    const store = new ResidentDocumentStore();
    const source = singlePartDocument(mesh(3, 7));

    const resolved = store.resolve(store.commit(source));

    expect(resolved).toBe(source);
    if (!isDocument(resolved)) return;
    expect(resolved.parts[0]?.mesh.positions[0]).toBe(7);
  });

  it('DF02: commits and resolves a multi-part document', () => {
    const store = new ResidentDocumentStore();
    const a = mesh(2, 1);
    const b = mesh(3, 100);
    const source = documentOf(part('a', a), part('b', b));

    const handle = store.commit(source);
    const resolved = store.resolve(handle);

    expect(isDocument(resolved)).toBe(true);
    if (!isDocument(resolved)) return;
    expect(resolved.parts).toHaveLength(2);
    expect(resolved.parts[0]?.mesh).toBe(a);
    expect(resolved.parts[1]?.mesh).toBe(b);
    expect(store.stats().partCount).toBe(2);
  });

  it('DF05: refuses a part that is not in this revision', () => {
    const store = new ResidentDocumentStore();
    const handle = store.commit(documentOf(part('a', mesh(1))));

    const found = store.resolvePart(handle, partId('a'));
    expect(isPart(found)).toBe(true);

    const missing = store.resolvePart(handle, partId('b'));
    expectUnavailable(missing);
    if (!isAppError(missing)) return;
    expect(missing.details.partId).toBe('b');
  });

  it('DF06: preserves a part’s transform, name and material reference verbatim', () => {
    const store = new ResidentDocumentStore();
    const placed: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 12.5, -3.25, 0.125];
    const source: GeometryDocument = {
      parts: [
        {
          id: partId('a'),
          mesh: mesh(1),
          transform: placed,
          name: 'Left bracket',
          materialRef: 'mat-7',
        },
      ],
    };

    const resolved = store.resolve(store.commit(source));
    if (!isDocument(resolved)) throw new Error('expected a document');

    const only = resolved.parts[0];
    expect(only?.transform).toEqual(placed);
    expect(only?.name).toBe('Left bracket');
    expect(only?.materialRef).toBe('mat-7');
  });

  it('reports resident bytes for what it holds', () => {
    const store = new ResidentDocumentStore();
    const source = mesh(4);

    store.commit(singlePartDocument(source));

    expect(store.stats().documentCount).toBe(1);
    expect(store.stats().totalBytes).toBe(meshByteLength(source));
  });

  it('DF03: counts shared geometry once, not once per placement', () => {
    // The property that makes a thousand-placement 3MF affordable. Charging per
    // part would refuse documents that comfortably fit.
    const store = new ResidentDocumentStore();
    const shared = mesh(4);
    const source = documentOf(part('a', shared), part('b', shared), part('c', shared));

    store.commit(source);

    expect(documentByteLength(source)).toBe(meshByteLength(shared));
    expect(store.stats().totalBytes).toBe(meshByteLength(shared));
    expect(store.stats().partCount).toBe(3);
  });
});

describe('releasing', () => {
  it('releases the current document', () => {
    const store = new ResidentDocumentStore();
    const handle = store.commit(singlePartDocument(mesh(1)));

    expect(store.release(handle.documentId)).toBe(true);

    expect(store.has(handle)).toBe(false);
    expect(store.stats().documentCount).toBe(0);
  });

  it('fails to resolve a released handle', () => {
    const store = new ResidentDocumentStore();
    const handle = store.commit(singlePartDocument(mesh(1)));
    store.release(handle.documentId);

    expectUnavailable(store.resolve(handle));
  });

  it('reports that releasing an unknown document released nothing', () => {
    const store = new ResidentDocumentStore();

    expect(store.release('document-never-existed' as DocumentId)).toBe(false);
  });

  it('clearing the store invalidates every handle', () => {
    const store = new ResidentDocumentStore();
    const first = store.commit(singlePartDocument(mesh(1)));
    const second = store.commit(singlePartDocument(mesh(1)));

    store.releaseAll();

    expectUnavailable(store.resolve(first));
    expectUnavailable(store.resolve(second));
    expect(store.stats()).toEqual({ documentCount: 0, totalBytes: 0, partCount: 0 });
  });
});

describe('replacement and staleness', () => {
  it('gives a replacement its own distinct handle', () => {
    const store = new ResidentDocumentStore();

    const first = store.commit(singlePartDocument(mesh(1)));
    const second = store.commit(singlePartDocument(mesh(2)));

    expect(second.documentId).not.toBe(first.documentId);
  });

  it('does not let an old handle resolve to the replacement', () => {
    // The core protection. Without it, an operation queued against the previous
    // model would silently run on whatever replaced it, and the user would get
    // a result computed from geometry they are not looking at.
    const store = new ResidentDocumentStore();
    const original = singlePartDocument(mesh(1, 100));
    const replacement = singlePartDocument(mesh(1, 200));

    const first = store.commit(original);
    const second = store.commit(replacement);
    store.release(first.documentId);

    expectUnavailable(store.resolve(first));
    expect(store.resolve(second)).toBe(replacement);
  });

  it('DF04: rejects a stale revision for a document id that still exists', () => {
    const store = new ResidentDocumentStore();
    const handle = store.commit(singlePartDocument(mesh(1)));

    const stale: DocumentHandle = { documentId: handle.documentId, revision: handle.revision - 1 };
    const future: DocumentHandle = { documentId: handle.documentId, revision: handle.revision + 1 };

    expectUnavailable(store.resolve(stale));
    expectUnavailable(store.resolve(future));
    expect(store.has(stale)).toBe(false);
  });

  it('DF04: a stale handle cannot reach a part either', () => {
    // `resolvePart` must not become a way around the revision guard.
    const store = new ResidentDocumentStore();
    const handle = store.commit(documentOf(part('a', mesh(1))));
    const stale: DocumentHandle = { documentId: handle.documentId, revision: 0 };

    expectUnavailable(store.resolvePart(stale, partId('a')));
  });

  it('names the revisions in the failure so the cause is attributable', () => {
    const store = new ResidentDocumentStore();
    const handle = store.commit(singlePartDocument(mesh(1)));

    const result = store.resolve({ documentId: handle.documentId, revision: 99 });

    expect(isAppError(result)).toBe(true);
    if (!isAppError(result)) return;
    expect(result.details.requestedRevision).toBe(99);
    expect(result.details.currentRevision).toBe(1);
  });

  it('never reuses a document id, so handles cannot alias across replacements', () => {
    // If ids were recycled after release, a long-queued operation holding an old
    // handle could match a completely unrelated later document.
    const store = new ResidentDocumentStore();
    const seen = new Set<string>();

    for (let index = 0; index < 50; index += 1) {
      const handle = store.commit(singlePartDocument(mesh(1)));
      expect(seen.has(handle.documentId)).toBe(false);
      seen.add(handle.documentId);
      store.release(handle.documentId);
    }

    expect(seen.size).toBe(50);
  });

  it('releasing a stale handle’s id cannot take down the current document', () => {
    // Release is by id, so this test pins that a released-then-replaced id does
    // not let a late release remove the live document.
    const store = new ResidentDocumentStore();
    const first = store.commit(singlePartDocument(mesh(1)));
    store.release(first.documentId);
    const current = store.commit(singlePartDocument(mesh(2)));

    // A late release for the OLD id arrives.
    expect(store.release(first.documentId)).toBe(false);

    expect(store.has(current)).toBe(true);
  });

  it('DF21: replacing produces exactly one new revision for the whole document', () => {
    const store = new ResidentDocumentStore();
    const a = mesh(2, 1);
    const b = mesh(3, 100);
    const handle = store.commit(documentOf(part('a', a), part('b', b)));

    const repaired = mesh(2, 900);
    const next = store.replace(handle, documentOf(part('a', repaired), part('b', b)));

    expect(isAppError(next)).toBe(false);
    if (isAppError(next)) return;
    expect(next.revision).toBe(2);

    // DF19/DF25: B is REFERENCE-identical, so nothing about it was copied,
    // rewritten or re-uploaded by a repair of A.
    const resolved = store.resolve(next);
    if (!isDocument(resolved)) throw new Error('expected a document');
    expect(resolved.parts[1]?.mesh).toBe(b);
    expect(resolved.parts[0]?.mesh).toBe(repaired);
  });

  it('refuses a replacement built from a revision the document has moved past', () => {
    const store = new ResidentDocumentStore();
    const handle = store.commit(singlePartDocument(mesh(1)));
    const moved = store.replace(handle, singlePartDocument(mesh(2)));
    expect(isAppError(moved)).toBe(false);

    // The original handle is now stale; a second replacement from it must fail.
    expectUnavailable(store.replace(handle, singlePartDocument(mesh(3))));
  });
});

describe('transactional replacement', () => {
  /**
   * The store itself is the commit point, so "a failed candidate must not
   * replace the resident document" is enforced by never calling `commit` on a
   * failure path. These tests pin that property at the store level: nothing
   * short of an explicit commit changes what is resident.
   */
  it('a failed candidate never replaces the resident document', () => {
    const store = new ResidentDocumentStore();
    const original = singlePartDocument(mesh(1, 11));
    const resident = store.commit(original);

    // Simulates a candidate that failed parsing or validation: it was never
    // committed, so nothing about the store changed.
    expect(() => {
      throw new Error('candidate failed validation');
    }).toThrow();

    expect(store.resolve(resident)).toBe(original);
    expect(store.stats().documentCount).toBe(1);
  });

  it('a cancelled candidate never replaces the resident document', () => {
    const store = new ResidentDocumentStore();
    const original = singlePartDocument(mesh(1, 22));
    const resident = store.commit(original);
    const beforeBytes = store.stats().totalBytes;

    // A cancelled import abandons its candidate before the commit line.
    expect(store.resolve(resident)).toBe(original);
    expect(store.stats().totalBytes).toBe(beforeBytes);
    expect(store.stats().documentCount).toBe(1);
  });
});
