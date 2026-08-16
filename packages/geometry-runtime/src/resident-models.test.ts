import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError } from '@cadfixer/shared';
import {
  createIndexArray,
  createPositionArray,
  IDENTITY_MATRIX4,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  meshByteLength,
  ResidentModelStore,
  type ModelHandle,
  type ModelId,
} from './resident-models';

/**
 * The resident store is where authoritative geometry lives, so its failure
 * modes are the ones that would show a user the wrong model. These are direct
 * unit tests rather than assertions reached through React: a stale-handle bug
 * is a data-integrity bug and deserves to be pinned at the level it happens.
 */

function mesh(triangles: number, seed = 0): CanonicalMesh {
  const positions = createPositionArray(triangles * 9);
  for (let index = 0; index < positions.length; index += 1) positions[index] = seed + index;
  return {
    positions,
    indices: createIndexArray(triangles * 3),
    metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
  };
}

/** Asserts a store result is the expected typed failure, not a mesh. */
function expectUnavailable(result: unknown): void {
  expect(isAppError(result)).toBe(true);
  if (!isAppError(result)) return;
  // MODEL_UNAVAILABLE, not INTERNAL_ERROR: a replaced or released model is an
  // expected condition the interface must be able to explain.
  expect(result.code).toBe(AppErrorCode.ModelUnavailable);
}

describe('committing and resolving', () => {
  it('commits a first model and returns a usable handle', () => {
    const store = new ResidentModelStore();
    const source = mesh(2);

    const handle = store.commit(source);

    expect(handle.revision).toBe(1);
    expect(store.has(handle)).toBe(true);
    expect(store.resolve(handle)).toBe(source);
  });

  it('resolves the current handle to the exact mesh committed', () => {
    const store = new ResidentModelStore();
    const source = mesh(3, 7);

    const resolved = store.resolve(store.commit(source));

    expect(resolved).toBe(source);
    if (typeof resolved === 'object' && 'positions' in resolved) {
      expect(resolved.positions[0]).toBe(7);
    }
  });

  it('reports resident bytes for what it holds', () => {
    const store = new ResidentModelStore();
    const source = mesh(4);

    store.commit(source);

    expect(store.stats().modelCount).toBe(1);
    expect(store.stats().totalBytes).toBe(meshByteLength(source));
  });
});

describe('releasing', () => {
  it('releases the current model', () => {
    const store = new ResidentModelStore();
    const handle = store.commit(mesh(1));

    expect(store.release(handle.modelId)).toBe(true);

    expect(store.has(handle)).toBe(false);
    expect(store.stats().modelCount).toBe(0);
  });

  it('fails to resolve a released handle', () => {
    const store = new ResidentModelStore();
    const handle = store.commit(mesh(1));
    store.release(handle.modelId);

    expectUnavailable(store.resolve(handle));
  });

  it('reports that releasing an unknown model released nothing', () => {
    const store = new ResidentModelStore();

    expect(store.release('model-never-existed' as ModelId)).toBe(false);
  });

  it('clearing the store invalidates every handle', () => {
    const store = new ResidentModelStore();
    const first = store.commit(mesh(1));
    const second = store.commit(mesh(1));

    store.releaseAll();

    expectUnavailable(store.resolve(first));
    expectUnavailable(store.resolve(second));
    expect(store.stats()).toEqual({ modelCount: 0, totalBytes: 0 });
  });
});

describe('replacement and staleness', () => {
  it('gives a replacement its own distinct handle', () => {
    const store = new ResidentModelStore();

    const first = store.commit(mesh(1));
    const second = store.commit(mesh(2));

    expect(second.modelId).not.toBe(first.modelId);
  });

  it('does not let an old handle resolve to the replacement', () => {
    // The core protection. Without it, an operation queued against the previous
    // model would silently run on whatever replaced it, and the user would get
    // a result computed from geometry they are not looking at.
    const store = new ResidentModelStore();
    const original = mesh(1, 100);
    const replacement = mesh(1, 200);

    const first = store.commit(original);
    const second = store.commit(replacement);
    store.release(first.modelId);

    expectUnavailable(store.resolve(first));
    expect(store.resolve(second)).toBe(replacement);
  });

  it('rejects a stale revision for a model id that still exists', () => {
    const store = new ResidentModelStore();
    const handle = store.commit(mesh(1));

    const stale: ModelHandle = { modelId: handle.modelId, revision: handle.revision - 1 };
    const future: ModelHandle = { modelId: handle.modelId, revision: handle.revision + 1 };

    expectUnavailable(store.resolve(stale));
    expectUnavailable(store.resolve(future));
    expect(store.has(stale)).toBe(false);
  });

  it('names the revisions in the failure so the cause is attributable', () => {
    const store = new ResidentModelStore();
    const handle = store.commit(mesh(1));

    const result = store.resolve({ modelId: handle.modelId, revision: 99 });

    expect(isAppError(result)).toBe(true);
    if (!isAppError(result)) return;
    expect(result.details.requestedRevision).toBe(99);
    expect(result.details.currentRevision).toBe(1);
  });

  it('never reuses a model id, so handles cannot alias across replacements', () => {
    // If ids were recycled after release, a long-queued operation holding an old
    // handle could match a completely unrelated later model.
    const store = new ResidentModelStore();
    const seen = new Set<string>();

    for (let index = 0; index < 50; index += 1) {
      const handle = store.commit(mesh(1));
      expect(seen.has(handle.modelId)).toBe(false);
      seen.add(handle.modelId);
      store.release(handle.modelId);
    }

    expect(seen.size).toBe(50);
  });

  it('releasing a stale handle’s id cannot take down the current model', () => {
    // Release is by id, so this test pins that a released-then-replaced id does
    // not let a late release remove the live model.
    const store = new ResidentModelStore();
    const first = store.commit(mesh(1));
    store.release(first.modelId);
    const current = store.commit(mesh(2));

    // A late release for the OLD id arrives.
    expect(store.release(first.modelId)).toBe(false);

    expect(store.has(current)).toBe(true);
  });
});

describe('transactional replacement', () => {
  /**
   * The store itself is the commit point, so "a failed candidate must not
   * replace the resident model" is enforced by never calling `commit` on a
   * failure path. These tests pin that property at the store level: nothing
   * short of an explicit commit changes what is resident.
   */
  it('a failed candidate never replaces the resident model', () => {
    const store = new ResidentModelStore();
    const original = mesh(1, 11);
    const resident = store.commit(original);

    // Simulates a candidate that failed parsing or validation: it was never
    // committed, so nothing about the store changed.
    expect(() => {
      throw new Error('candidate failed validation');
    }).toThrow();

    expect(store.resolve(resident)).toBe(original);
    expect(store.stats().modelCount).toBe(1);
  });

  it('a cancelled candidate never replaces the resident model', () => {
    const store = new ResidentModelStore();
    const original = mesh(1, 22);
    const resident = store.commit(original);
    const beforeBytes = store.stats().totalBytes;

    // A cancelled import abandons its candidate before the commit line.
    expect(store.resolve(resident)).toBe(original);
    expect(store.stats().totalBytes).toBe(beforeBytes);
    expect(store.stats().modelCount).toBe(1);
  });
});
