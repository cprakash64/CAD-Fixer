import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { applyPartTransform } from '@cadfixer/mesh-core';
import { buildPartGeometry, partMatrix, SharedPartGeometry } from './part-geometry';

/**
 * DF08 and DF10, at the level where they are actually decidable.
 *
 * Neither the placement arithmetic nor the reference counting needs a WebGL
 * context to be right or wrong, so neither is tested through one. What a
 * browser adds — that the pixels appear — is asserted end to end; what it would
 * hide is asserted here.
 */

function buffer(values: readonly number[]): Float32Array {
  return new Float32Array(values);
}

describe('part placement', () => {
  it('DF08: reads a row-major 3x4 transform without transposing it', () => {
    /*
     * THE CONVENTION BUG THIS EXISTS TO PREVENT. Three.js stores column-major
     * but `Matrix4.set` takes row-major arguments, so a transform written the
     * "obvious" way lands transposed — and a part that should be translated
     * along X ends up rotated. Applying the matrix to a point is the only
     * assertion that catches it.
     */
    const translate: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, -3, 2];

    const moved = new Vector3(1, 1, 1).applyMatrix4(partMatrix(translate));

    expect(moved.x).toBeCloseTo(6, 10);
    expect(moved.y).toBeCloseTo(-2, 10);
    expect(moved.z).toBeCloseTo(3, 10);
  });

  it('reads the linear part as 3MF does — points are ROW vectors', () => {
    /*
     * THE TRANSPOSE THAT HIDES. Under `[0 2 0, -2 0 0, 0 0 2, 0 0 0]` the 3MF
     * convention sends (1,0,0) to (0,2,0): the first index of each term varies
     * with the INPUT axis. Reading the same twelve numbers as column vectors
     * sends it to (0,-2,0) instead — same magnitude, wrong sign, and no fixture
     * made of identity and translation can tell the two apart.
     *
     * This is the placement `experiments/format-io/threemf-matrix.mjs` RT05
     * asserts, so production and the qualified reference agree by construction.
     */
    const rotScale: readonly number[] = [0, 2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0];

    const placed = new Vector3(1, 0, 0).applyMatrix4(partMatrix(rotScale));

    expect(placed.x).toBeCloseTo(0, 10);
    expect(placed.y).toBeCloseTo(2, 10);
    expect(placed.z).toBeCloseTo(0, 10);
  });

  it('agrees with the canonical placement helper on the same transform', () => {
    // The renderer and the bounds arithmetic must not disagree about where a
    // part is: one drives pixels and the other drives the camera.
    const rotScale: readonly number[] = [0, 2, 0, -2, 0, 0, 0, 0, 2, 1, 2, 3];

    const viaThree = new Vector3(1, -1, 2).applyMatrix4(partMatrix(rotScale));
    const viaCanonical = applyPartTransform(rotScale as never, 1, -1, 2);

    expect(viaThree.x).toBeCloseTo(viaCanonical[0], 10);
    expect(viaThree.y).toBeCloseTo(viaCanonical[1], 10);
    expect(viaThree.z).toBeCloseTo(viaCanonical[2], 10);
  });

  it('leaves a point where it was under the identity placement', () => {
    const identity: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

    const same = new Vector3(3, -4, 5).applyMatrix4(partMatrix(identity));

    expect([same.x, same.y, same.z]).toEqual([3, -4, 5]);
  });
});

describe('shared GPU geometry', () => {
  it('DF07: two parts with different buffers get two geometries', () => {
    const shared = new SharedPartGeometry();
    const a = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b = buffer([0, 0, 0, 2, 0, 0, 0, 2, 0]);

    const first = shared.acquire(a, a, [0, 0, 0], 1);
    const second = shared.acquire(b, b, [0, 0, 0], 1);

    expect(first).not.toBe(second);
    expect(shared.size).toBe(2);
  });

  it('DF03: two parts sharing ONE buffer get ONE geometry', () => {
    // A thousand placements of a 3MF component cost one upload, not a thousand.
    const shared = new SharedPartGeometry();
    const positions = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);

    const first = shared.acquire(positions, positions, [0, 0, 0], 1);
    const second = shared.acquire(positions, positions, [0, 0, 0], 1);

    expect(second).toBe(first);
    expect(shared.size).toBe(1);
    expect(shared.referencesTo(positions)).toBe(2);
  });

  it('DF10: releasing one of two references does NOT dispose the geometry', () => {
    /*
     * THE CASE THAT WOULD CORRUPT A RENDER. Without the count, removing the
     * first placement would free the buffer the second is still drawing from —
     * a use-after-free that a browser surfaces as a blank or garbled model
     * rather than as an error.
     */
    const shared = new SharedPartGeometry();
    const positions = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const geometry = shared.acquire(positions, positions, [0, 0, 0], 1);
    shared.acquire(positions, positions, [0, 0, 0], 1);

    shared.release(positions);

    expect(shared.size).toBe(1);
    expect(shared.referencesTo(positions)).toBe(1);
    // Still usable: the attribute is intact.
    expect(geometry.getAttribute('position')).toBeDefined();
  });

  it('DF10: releasing the LAST reference disposes and forgets it', () => {
    const shared = new SharedPartGeometry();
    const positions = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    shared.acquire(positions, positions, [0, 0, 0], 1);
    shared.acquire(positions, positions, [0, 0, 0], 1);

    shared.release(positions);
    shared.release(positions);

    expect(shared.size).toBe(0);
    expect(shared.referencesTo(positions)).toBe(0);
  });

  it('releasing a buffer it never held is a no-op, not a fault', () => {
    const shared = new SharedPartGeometry();

    expect(() => {
      shared.release(buffer([1, 2, 3]));
    }).not.toThrow();
    expect(shared.size).toBe(0);
  });

  it('a thousand placements of one buffer hold exactly one geometry', () => {
    const shared = new SharedPartGeometry();
    const positions = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);

    for (let index = 0; index < 1000; index += 1) {
      shared.acquire(positions, positions, [0, 0, 0], 1);
    }

    expect(shared.size).toBe(1);
    expect(shared.referencesTo(positions)).toBe(1000);

    // And releasing every one of them leaves nothing behind.
    for (let index = 0; index < 1000; index += 1) shared.release(positions);
    expect(shared.size).toBe(0);
  });

  it('counts uploads and disposals cumulatively, so a leak is visible', () => {
    /*
     * THE LIVE COUNT CANNOT SEE A LEAK. A document loaded and unloaded ten
     * times leaves `size` at zero whether every buffer was released or none of
     * them were, so the accounting identity has to be cumulative: creations
     * minus disposals is exactly what is still held.
     */
    const shared = new SharedPartGeometry();
    const a = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b = buffer([0, 0, 0, 2, 0, 0, 0, 2, 0]);

    expect(shared.lifecycle).toEqual({ created: 0, disposed: 0 });

    shared.acquire(a, a, [0, 0, 0], 1);
    shared.acquire(a, a, [0, 0, 0], 1);
    shared.acquire(b, b, [0, 0, 0], 1);
    // Two buffers, three references: two uploads.
    expect(shared.lifecycle).toEqual({ created: 2, disposed: 0 });

    shared.release(a);
    // A still has a reference, so nothing was disposed.
    expect(shared.lifecycle).toEqual({ created: 2, disposed: 0 });

    shared.release(a);
    expect(shared.lifecycle).toEqual({ created: 2, disposed: 1 });

    shared.release(b);
    expect(shared.lifecycle).toEqual({ created: 2, disposed: 2 });
    expect(shared.lifecycle.created - shared.lifecycle.disposed).toBe(shared.size);
  });

  it('never disposes more than it created, however often release is called', () => {
    // A double dispose would make `disposed` overtake `created`, which is the
    // signature of a use-after-free waiting to happen.
    const shared = new SharedPartGeometry();
    const positions = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);

    shared.acquire(positions, positions, [0, 0, 0], 1);
    shared.release(positions);
    shared.release(positions);
    shared.release(positions);

    expect(shared.lifecycle).toEqual({ created: 1, disposed: 1 });
    expect(shared.size).toBe(0);
  });

  it('releaseAll counts one disposal per distinct geometry, not per reference', () => {
    const shared = new SharedPartGeometry();
    const positions = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    for (let index = 0; index < 100; index += 1) {
      shared.acquire(positions, positions, [0, 0, 0], 1);
    }

    shared.releaseAll();

    // A hundred placements of one mesh is ONE upload and ONE disposal.
    expect(shared.lifecycle).toEqual({ created: 1, disposed: 1 });
  });

  it('releaseAll drops everything, whatever the counts were', () => {
    const shared = new SharedPartGeometry();
    const a = buffer([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b = buffer([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    shared.acquire(a, a, [0, 0, 0], 1);
    shared.acquire(a, a, [0, 0, 0], 1);
    shared.acquire(b, b, [0, 0, 0], 1);

    shared.releaseAll();

    expect(shared.size).toBe(0);
  });
});

describe('bounding spheres are assigned, not computed', () => {
  it('takes the worker’s measurement rather than walking the buffer', () => {
    // Computing one here would be two full passes over the position buffer on
    // the UI thread, which is the whole-mesh main-thread work this forbids.
    const positions = buffer([0, 0, 0, 10, 0, 0, 0, 10, 0]);

    const geometry = buildPartGeometry(positions, positions, [1, 2, 3], 7);

    expect(geometry.boundingSphere?.center.toArray()).toEqual([1, 2, 3]);
    expect(geometry.boundingSphere?.radius).toBe(7);
  });

  it('substitutes a usable radius when the worker reported none', () => {
    // A degenerate radius would make frustum culling drop the part entirely.
    const positions = buffer([0, 0, 0, 0, 0, 0, 0, 0, 0]);

    const geometry = buildPartGeometry(positions, positions, [0, 0, 0], 0);

    expect(geometry.boundingSphere?.radius).toBe(1);
  });
});
