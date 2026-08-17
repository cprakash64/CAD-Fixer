import { describe, expect, it } from 'vitest';
import * as engine from '@cadfixer/mesh-repair';
import * as mirror from './repair';

/**
 * THE MIRROR MUST NOT DRIFT.
 *
 * `repair.ts` restates the repair contract's constants so the main-thread bundle
 * never gains a runtime edge to the repair engine. The restatement is checked at
 * compile time by `Exactly<>` — but that only proves the two TYPES agree, and a
 * type made of string literals is satisfied by a constant whose keys were
 * renamed or reordered.
 *
 * This asserts the RUNTIME VALUES are identical, which is what actually decides
 * whether the interface can compare a decision against the one the worker sent.
 * A mismatch here would not fail the build; it would show a user "unknown" for
 * every refusal, forever.
 */

function valuesOf(entries: Readonly<Record<string, string>>): string[] {
  return Object.values(entries).sort();
}

describe('the restated repair contract', () => {
  it('has the same operations as the engine', () => {
    expect(valuesOf(mirror.RepairOperation)).toEqual(valuesOf(engine.RepairOperation));
    expect(Object.keys(mirror.RepairOperation).sort()).toEqual(
      Object.keys(engine.RepairOperation).sort(),
    );
  });

  it('runs operations in the same order the engine does', () => {
    // The panel lists operations in pipeline order. A UI that showed a different
    // order would be describing a repair that does not happen — duplicates are
    // removed BEFORE winding is solved, and that is why some winding refusals
    // disappear once the duplicates are gone.
    expect([...mirror.REPAIR_PIPELINE_ORDER]).toEqual([...engine.REPAIR_PIPELINE_ORDER]);
  });

  it('has the same decisions as the engine', () => {
    expect(valuesOf(mirror.RepairDecision)).toEqual(valuesOf(engine.RepairDecision));
  });

  it('has the same reasons as the engine', () => {
    expect(valuesOf(mirror.RepairReason)).toEqual(valuesOf(engine.RepairReason));
  });

  it('has the same acceptance states as the engine', () => {
    expect(valuesOf(mirror.RepairAcceptance)).toEqual(valuesOf(engine.RepairAcceptance));
  });

  it('has the same regressions as the engine', () => {
    expect(valuesOf(mirror.RepairRegression)).toEqual(valuesOf(engine.RepairRegression));
  });

  it('has the same volume and bounds comparisons as the engine', () => {
    expect(valuesOf(mirror.VolumeComparison)).toEqual(valuesOf(engine.VolumeComparison));
    expect(valuesOf(mirror.BoundsComparison)).toEqual(valuesOf(engine.BoundsComparison));
  });

  it('maps every key to the same value, not merely the same set', () => {
    // A set comparison alone would accept two constants whose keys were swapped,
    // which reads correctly in a test and produces the wrong label at runtime.
    const pairs: readonly (readonly [Readonly<Record<string, string>>, Record<string, string>])[] =
      [
        [mirror.RepairOperation, engine.RepairOperation],
        [mirror.RepairDecision, engine.RepairDecision],
        [mirror.RepairReason, engine.RepairReason],
        [mirror.RepairAcceptance, engine.RepairAcceptance],
        [mirror.RepairRegression, engine.RepairRegression],
        [mirror.VolumeComparison, engine.VolumeComparison],
        [mirror.BoundsComparison, engine.BoundsComparison],
      ];

    for (const [restated, original] of pairs) {
      for (const [key, value] of Object.entries(restated)) {
        expect(original[key], `key ${key} drifted`).toBe(value);
      }
    }
  });
});
