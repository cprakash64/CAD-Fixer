import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE PROMOTED KERNEL IS THE QUALIFIED KERNEL.
 *
 * Stage 3C-1A-R1 qualified a specific classifier, broadphase and capacity guard.
 * Stage 3C-1B promoted those files into production. The evidence only describes
 * what ships if the two stay identical, so this asserts it rather than trusting
 * that nobody edited one copy.
 *
 * It also asserts the capacity guard is still WIRED, because that guard is the
 * difference between a malformed pair degrading a report to PARTIAL and the same
 * pair killing the diagnostic worker outright.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const QUALIFIED = '../../../experiments/self-intersection';

describe('the production kernel matches the qualified research kernel', () => {
  for (const file of ['si_core.h', 'si_bvh.h'] as const) {
    it(`is byte-identical: ${file}`, () => {
      expect(read(`./${file}`)).toBe(read(`${QUALIFIED}/${file}`));
    });
  }
});

describe('the capacity guard is present and wired', () => {
  const core = read('./si_core.h');

  it('sets the assertion mode explicitly rather than inheriting it', () => {
    // ASSERT_ABORT would call abort() and take the worker with it. The mode is
    // chosen, not assumed.
    expect(core).toContain('GEO::set_assert_mode(GEO::ASSERT_THROW)');
  });

  it('wraps the narrowphase call so a thrown assertion is caught', () => {
    const call = core.indexOf('GEO::triangles_intersections(');
    expect(call).toBeGreaterThan(-1);
    const before = core.slice(Math.max(0, call - 800), call);
    expect(before, 'the narrowphase call must sit inside a try block').toContain('try {');
  });

  it('counts a refused pair instead of discarding it', () => {
    expect(core).toContain('++out.narrowphase_refusals');
  });

  it('forces PARTIAL when any pair could not be classified', () => {
    // The load-bearing line: a pair the kernel could not examine must never be
    // silently absorbed into a CHECKED verdict.
    expect(core).toContain('out.narrowphase_refusals > 0');
    const statusBlock = core.slice(core.indexOf('STATUS IS DECIDED LAST'));
    expect(statusBlock).toContain('SI_STATUS_PARTIAL');
  });

  it('never sends a topological duplicate to the narrowphase', () => {
    // The configuration proven during qualification to overflow the fixed
    // 20-element symbolic buffer.
    expect(core).toContain('shared_now == 3');
  });
});

describe('the shipped artifact carries no excluded component', () => {
  it('contains no tetgen or triangle symbols', () => {
    const wasm = readFileSync(new URL('../artifacts/self-intersection.wasm', import.meta.url));
    const text = wasm.toString('latin1');
    for (const symbol of ['tetgenmesh', 'tetgenio', 'triangulateio']) {
      expect(text.includes(symbol), `the shipped kernel must not contain ${symbol}`).toBe(false);
    }
  });
});
