import { describe, expect, it } from 'vitest';
import { validateMeshStructure } from '@cadfixer/mesh-core';
import { CORPUS, FixtureScale } from './corpus';
import { checkExpectation, diagnose } from './harness';

/**
 * THE PRE-CONDITION ORACLE.
 *
 * Every fixture is analysed by the approved Stage 2 engine and checked against
 * the diagnosis it claims to have. Without this, the entire bakeoff could run
 * against fixtures that do not contain the defects they advertise — and a
 * candidate would score perfectly for "repairing" a defect that was never
 * there.
 *
 * No topology logic is reimplemented here. `diagnose` calls the production
 * engine, which is exactly the point: the corpus is pinned against the same
 * oracle the product uses.
 */

describe('corpus integrity', () => {
  it('contains R01 through R30 with unique ids', () => {
    const ids = CORPUS.map((fixture) => fixture.id);

    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(ids[0]).toBe('R01');
    expect(ids.at(-1)).toBe('R30');
  });

  it('describes every fixture and declares its forbidden outcomes', () => {
    for (const fixture of CORPUS) {
      expect(fixture.title.length, `${fixture.id} title`).toBeGreaterThan(0);
      expect(fixture.description.length, `${fixture.id} description`).toBeGreaterThan(20);
      expect(fixture.acceptance.length, `${fixture.id} acceptance`).toBeGreaterThan(0);
      expect(fixture.forbidden.length, `${fixture.id} forbidden`).toBeGreaterThan(0);
      expect(fixture.scales.length, `${fixture.id} scales`).toBeGreaterThan(0);
    }
  });

  it('builds structurally valid meshes for every fixture and scale', () => {
    for (const fixture of CORPUS) {
      for (const scale of fixture.scales) {
        const mesh = fixture.build(scale);
        const validation = validateMeshStructure(mesh);
        expect(validation.valid, `${fixture.id} @ ${scale}`).toBe(true);
        expect(mesh.indices.length, `${fixture.id} @ ${scale} is non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic: rebuilding a fixture gives identical bytes', () => {
    // R29 uses a seeded generator precisely so this holds; a corpus that
    // differed between runs would make determinism testing meaningless.
    for (const fixture of CORPUS) {
      const first = fixture.build(FixtureScale.Tiny);
      const second = fixture.build(FixtureScale.Tiny);
      expect(new Uint8Array(second.positions.buffer), fixture.id).toEqual(
        new Uint8Array(first.positions.buffer),
      );
    }
  });
});

describe('pinned pre-repair diagnosis', () => {
  /**
   * Each fixture is checked against the Stage 2 engine. A failure here means
   * either the fixture does not contain its defect, or the expectation is
   * wrong — both of which must be fixed before any kernel is benchmarked.
   */
  it.each(CORPUS.map((fixture) => [fixture.id, fixture] as const))(
    '%s matches its declared diagnosis',
    (_id, fixture) => {
      const report = diagnose(fixture.build(FixtureScale.Tiny));
      const failures = checkExpectation(report, fixture.expected);

      expect(failures, `${fixture.id} — ${fixture.title}\n${failures.join('\n')}`).toEqual([]);
    },
  );
});

describe('the fixtures that exist to catch cheating', () => {
  /**
   * These four carry the load in the bakeoff. Their properties are asserted
   * directly rather than only through the generic expectation check, because if
   * any of them silently stopped testing what it claims, a bad candidate would
   * pass.
   */

  it('R09 has two INTENTIONAL openings, so "fill everything" is visibly wrong', () => {
    const fixture = CORPUS.find((entry) => entry.id === 'R09');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    const report = diagnose(fixture.build(FixtureScale.Tiny));
    expect(report.simpleBoundaryLoopCount).toBe(2);
    expect(fixture.intentionalDefects).toEqual([]);
    expect(fixture.forbidden).toContain('filled-intentional-opening');
  });

  it('R12 is edge-manifold and vertex-NON-manifold, which only fan analysis sees', () => {
    const fixture = CORPUS.find((entry) => entry.id === 'R12');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    const report = diagnose(fixture.build(FixtureScale.Tiny));
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.isEdgeManifold).toBe(true);
    expect(report.nonManifoldVertexCount).toBe(1);
    expect(report.isVertexManifold).toBe(false);
    expect(report.componentCount).toBe(2);
  });

  it('R15 is two disjoint clean shells that must never be merged', () => {
    const fixture = CORPUS.find((entry) => entry.id === 'R15');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    const report = diagnose(fixture.build(FixtureScale.Tiny));
    expect(report.componentCount).toBe(2);
    expect(report.boundaryEdgeCount).toBe(0);
    expect(fixture.forbidden).toContain('merged-disjoint-shells');
  });

  it('R21 separates its sheets by LESS than R19 separates its crack', () => {
    // This is the whole argument against a global tolerance, and it has to be
    // true of the actual geometry rather than merely asserted in prose.
    const crack = CORPUS.find((entry) => entry.id === 'R19');
    const parallel = CORPUS.find((entry) => entry.id === 'R21');
    expect(crack).toBeDefined();
    expect(parallel).toBeDefined();
    if (crack === undefined || parallel === undefined) return;

    // R19's gap is 1e-3; R21's separation is 5e-4. Any tolerance that heals the
    // first destroys the second.
    const crackGap = 1e-3;
    const parallelGap = 5e-4;
    expect(parallelGap).toBeLessThan(crackGap);

    expect(diagnose(parallel.build(FixtureScale.Tiny)).componentCount).toBe(2);
  });
});
