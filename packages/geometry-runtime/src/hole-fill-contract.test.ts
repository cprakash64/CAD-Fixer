import { describe, expect, it } from 'vitest';
import * as engine from '@cadfixer/mesh-hole-fill';
import * as topology from '@cadfixer/mesh-topology';
import * as mirror from './hole-fill';

/**
 * THE MIRROR MUST NOT DRIFT.
 *
 * `hole-fill.ts` restates the engine's statuses and ceilings so the main-thread
 * bundle never gains a runtime edge to the fill engine. The restatement is
 * checked at compile time by `Exactly<>` — but that only proves the two TYPES
 * agree, and a type made of string literals is satisfied by a constant whose
 * keys were renamed or reordered.
 *
 * This asserts the RUNTIME VALUES are identical, which is what actually decides
 * whether the interface can compare a status against the one the worker sent. A
 * mismatch here would not fail the build; it would show a user "unknown" for
 * every refusal, forever.
 */

function valuesOf(entries: Readonly<Record<string, string>>): string[] {
  return Object.values(entries).sort();
}

describe('the restated hole-fill contract', () => {
  it('has the same statuses as the engine', () => {
    expect(valuesOf(mirror.HoleFillStatus)).toEqual(valuesOf(engine.HoleFillStatus));
    expect(Object.keys(mirror.HoleFillStatus).sort()).toEqual(
      Object.keys(engine.HoleFillStatus).sort(),
    );
  });

  it('maps every key to the same value, not merely the same set', () => {
    // A set comparison alone would accept two constants whose keys were
    // swapped, which reads correctly in a test and produces the wrong label at
    // runtime.
    const original: Record<string, string> = engine.HoleFillStatus;
    for (const [key, value] of Object.entries(mirror.HoleFillStatus)) {
      expect(original[key], `key ${key} drifted`).toBe(value);
    }
  });

  it('restates the production ceilings without changing them', () => {
    expect(mirror.HOLE_FILL_MAX_BOUNDARY_VERTICES).toBe(engine.HOLE_FILL_MAX_BOUNDARY_VERTICES);
    expect(mirror.HOLE_FILL_MAX_PART_FACES).toBe(engine.HOLE_FILL_MAX_PART_FACES);
  });

  it('keeps the patch ceiling DERIVED from the boundary ceiling', () => {
    // A separate patch limit would be a second number that could disagree with
    // the first. `n - 2` is a structural property of ear clipping, not a policy.
    expect(engine.HOLE_FILL_MAX_PATCH_FACES).toBe(
      engine.patchFaceCountFor(engine.HOLE_FILL_MAX_BOUNDARY_VERTICES),
    );
  });

  /*
   * STAGE 4B-1B2. The boundary refusals are restated for the same reason and
   * carry the same risk: the interface lists and EXPLAINS a refused opening
   * without any worker running, so a drifted code shows a user a blank
   * explanation for a refusal the engine can produce every day.
   */
  it('has the same boundary refusals as the topology engine', () => {
    expect(valuesOf(mirror.BoundaryLoopRefusal)).toEqual(valuesOf(topology.BoundaryLoopRefusal));
    expect(Object.keys(mirror.BoundaryLoopRefusal).sort()).toEqual(
      Object.keys(topology.BoundaryLoopRefusal).sort(),
    );
  });

  it('maps every boundary refusal key to the same value', () => {
    const original: Record<string, string> = topology.BoundaryLoopRefusal;
    for (const [key, value] of Object.entries(mirror.BoundaryLoopRefusal)) {
      expect(original[key], `key ${key} drifted`).toBe(value);
    }
  });

  it('is compile-time checked in both directions', () => {
    expect(mirror.HOLE_FILL_CONTRACT_CHECKED).toEqual([true, true]);
  });
});
