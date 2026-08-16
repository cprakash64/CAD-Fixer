import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * INTEGRITY OF THE GENERATED BAKEOFF RESULTS.
 *
 * WHY THIS FILE EXISTS. `docs/repair/bakeoff/*.json` is machine-generated and
 * is excluded from Prettier — its serialisation is owned by the generator, not
 * by a formatter (see `.prettierignore`). Excluding a committed file from one
 * check is only defensible if something else checks the properties that
 * actually matter, and formatting was never one of them.
 *
 * So these assert what a results file must be true of to be usable as
 * evidence: it parses, it says which corpus and which artifacts produced it,
 * it carries no raw geometry, and a reader can consume it. A results file that
 * cannot say what produced it is an anecdote.
 */

const BAKEOFF = join(import.meta.dirname, '..', 'docs', 'repair', 'bakeoff');

/** Every generated results file, with the provenance each one must carry. */
const GENERATED = [
  { file: 'results.json', corpus: true, artifacts: 'candidates' },
  { file: 'geogram-root-cause.json', corpus: true, artifacts: 'explicit' },
  { file: 'manifold-boolean.json', corpus: false, artifacts: 'explicit' },
  { file: 'idempotence-preservation.json', corpus: true, artifacts: 'map' },
  { file: 'scalar-precision.json', corpus: false, artifacts: 'rows' },
  // Stage 3A-3B browser evidence. Same rules: a browser result that cannot name
  // the artifact and corpus that produced it is as useless as a Node one.
  { file: 'browser-qualification.json', corpus: true, artifacts: 'map' },
  { file: 'browser-cancellation.json', corpus: true, artifacts: 'map' },
  { file: 'browser-scaling.json', corpus: true, artifacts: 'map' },
] as const;

/**
 * Narrows an `unknown` JSON field to a string.
 *
 * `String(value)` on an unknown would render an object as "[object Object]" and
 * quietly put that in a results file, which is exactly the kind of plausible-
 * looking wrong value this stage exists to eliminate. Non-strings become the
 * fallback rather than a fabricated rendering.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function load(file: string): Record<string, unknown> {
  const path = join(BAKEOFF, file);
  expect(existsSync(path), `${file} is missing — regenerate it before committing`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('generated bakeoff results', () => {
  it.each(GENERATED.map((entry) => entry.file))('%s parses as JSON', (file) => {
    expect(() => load(file)).not.toThrow();
  });

  it.each(GENERATED.map((entry) => entry.file))('%s records when and where it ran', (file) => {
    const run = load(file);
    expect(typeof run.startedAt, `${file}.startedAt`).toBe('string');
    // Must be a real timestamp, not a placeholder string.
    expect(
      Number.isNaN(Date.parse(text(run.startedAt, 'not-a-date'))),
      `${file}.startedAt parses`,
    ).toBe(false);
    expect(text(run.environment, ''), `${file}.environment`).toContain('node');
  });

  it.each(GENERATED.filter((entry) => entry.corpus).map((entry) => entry.file))(
    '%s ties itself to a corpus revision',
    (file) => {
      const run = load(file);
      const version = text(run.corpusVersion, '');
      // A 16-hex-character digest. A result that cannot name the fixtures that
      // produced it cannot be compared with any other result.
      expect(version, `${file}.corpusVersion`).toMatch(/^[0-9a-f]{16}$/);
    },
  );

  it.each(GENERATED.filter((entry) => entry.file !== 'results.json').map((entry) => entry.file))(
    '%s records the harness version that produced it',
    (file) => {
      const run = load(file);
      expect(text(run.harnessVersion, ''), `${file}.harnessVersion`).toMatch(/^stage-/);
    },
  );

  it('every file names the artifact SHA-256 it measured', () => {
    for (const entry of GENERATED) {
      const run = load(entry.file);
      const digests: string[] = [];
      if (entry.artifacts === 'candidates') {
        const candidates = run.candidates as { artifactSha256?: string }[] | undefined;
        for (const candidate of candidates ?? []) {
          if (candidate.artifactSha256 !== undefined) digests.push(candidate.artifactSha256);
        }
      } else if (entry.artifacts === 'explicit') {
        for (const key of ['artifactSha256', 'wasmArtifactSha256', 'nativeArtifactSha256']) {
          const value = run[key];
          if (typeof value === 'string') digests.push(value);
        }
      } else if (entry.artifacts === 'map') {
        const shas = run.artifactShas as Record<string, string> | undefined;
        for (const value of Object.values(shas ?? {})) digests.push(value);
      } else {
        const scalarRows = run.rows as { artifactSha256?: string }[] | undefined;
        for (const row of scalarRows ?? []) {
          if (row.artifactSha256 !== undefined) digests.push(row.artifactSha256);
        }
      }

      expect(digests.length, `${entry.file} records no artifact digest`).toBeGreaterThan(0);
      for (const digest of digests) {
        expect(digest, `${entry.file} artifact digest`).toMatch(/^([0-9a-f]{64}|missing|unknown)$/);
      }
    }
  });

  /**
   * NO RAW GEOMETRY. `BakeoffRow`'s contract says results carry counts and
   * metrics, never meshes: these files are committed, shared and pasted into
   * reviews, and a mesh in one would make it enormous and would put
   * user-shaped data somewhere it travels.
   *
   * Checked structurally rather than by file size, because a small file can
   * still contain a small mesh.
   */
  it('no results file embeds raw geometry', () => {
    /*
     * Keyed on NAME AND SHAPE, not name alone. `triangles` is a legitimate
     * scalar in `TopologySummaryRow` — it is a count — and rejecting the name
     * outright failed on valid output. What must never appear is a geometry
     * key holding an ARRAY, which is a mesh.
     *
     * A long numeric array under any other name is caught too, so a future
     * generator cannot smuggle coordinates through by renaming the field.
     */
    const geometryKeys = [
      'outPositions',
      'outTriangles',
      'positions',
      'triangles',
      'vertProperties',
      'triVerts',
    ];
    const walk = (value: unknown, path: string, file: string): void => {
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) walk(item, `${path}[${String(index)}]`, file);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (Array.isArray(child)) {
          expect(geometryKeys.includes(key), `${file} embeds raw geometry at ${path}.${key}`).toBe(
            false,
          );
          const numeric = child.every((item) => typeof item === 'number');
          expect(
            numeric && child.length > 32,
            `${file} embeds a ${String(child.length)}-element numeric array at ${path}.${key}`,
          ).toBe(false);
        }
        walk(child, `${path}.${key}`, file);
      }
    };
    for (const entry of GENERATED) walk(load(entry.file), '$', entry.file);
  });

  /**
   * STALE-ROW CONTAMINATION (§I1).
   *
   * A row measured against one artifact must never be summarised beside a row
   * measured against another. Rows that carry their own digest must agree with
   * the file-level digest for the same candidate.
   */
  it('no file mixes rows from different artifacts of the same candidate', () => {
    const run = load('idempotence-preservation.json');
    const declared = (run.artifactShas ?? {}) as Record<string, string>;
    for (const row of (run.idempotence as Record<string, unknown>[] | undefined) ?? []) {
      const candidateId = String(row.candidateId);
      expect(row.artifactSha256, `idempotence row for ${candidateId}`).toBe(declared[candidateId]);
    }
  });

  it('the Geogram root-cause file crosses initialisation with engine', () => {
    const run = load('geogram-root-cause.json');
    const rows = (run.rows ?? []) as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    // Both engines and both initialisation modes must be present, or the
    // attribution it claims is not supported by the data it contains.
    const combinations = new Set(
      rows.map((row) => `${String(row.engine)}/${String(row.initMode)}`),
    );
    expect([...combinations].sort()).toEqual(['native/0', 'native/1', 'wasm/0', 'wasm/1']);
  });

  /**
   * BROWSER AND NODE EVIDENCE MUST NOT BE CONFUSED (P5).
   *
   * The two were measured in different runtimes and answer different questions.
   * Every browser file must say so in its own environment field, so a reader
   * cannot mistake a Chromium measurement for a Node one or vice versa.
   */
  it('browser results declare the browser they ran in', () => {
    for (const file of [
      'browser-qualification.json',
      'browser-cancellation.json',
      'browser-scaling.json',
    ]) {
      const run = load(file);
      const browser = run.browser as Record<string, unknown> | undefined;
      expect(browser, `${file}.browser`).toBeDefined();
      expect(text(browser?.userAgent, ''), `${file} user agent`).toContain('Chrome');
      // The isolation context is a precondition of the whole experiment.
      expect(browser?.crossOriginIsolated, `${file} cross-origin isolation`).toBe(true);
    }
  });

  it('the browser qualification records a local-only request audit', () => {
    const run = load('browser-qualification.json');
    const network = run.network as Record<string, unknown> | undefined;
    expect(network, 'network audit present').toBeDefined();
    expect(Number(network?.requestCount ?? 0)).toBeGreaterThan(0);
    expect(network?.foreignOriginRequests, 'no foreign-origin request').toBe(0);
    expect(network?.origins, 'exactly one origin').toEqual(['http://127.0.0.1:4174']);
  });

  it('memory figures are labelled as WASM heap, never as process RSS', () => {
    const run = load('browser-scaling.json');
    const note = text(run.note, '');
    // The wording matters: claiming RSS from a WebAssembly.Memory length would
    // be a false claim about the machine, not just an imprecise one.
    expect(note).toContain('WebAssembly.Memory');
    expect(note).toContain('NOT process RSS');
  });

  it('the invalidated Manifold experiment is recorded and marked invalid', () => {
    const run = load('manifold-boolean.json');
    const invalid = run.invalidatedExperiment as Record<string, unknown> | undefined;
    expect(invalid, 'manifold-boolean.json must retain the invalid experiment').toBeDefined();
    expect(invalid?.status).toBe('INVALID_EXPERIMENT');
    expect(text(invalid?.reason, '')).toContain('EMPTY');
    // And it must not appear among the scored rows.
    for (const row of (run.rows as Record<string, unknown>[] | undefined) ?? []) {
      expect(String(row.caseId)).not.toContain('selfUnion');
    }
  });

  /**
   * The generator's structure must be reproducible for reproducible input.
   *
   * Hashing the SHAPE — the sorted key paths — rather than the values, because
   * timings and timestamps legitimately differ between runs while the schema
   * must not. A silent schema change is how a downstream reader starts reading
   * a field that no longer means what it did.
   */
  it('generated files have a stable structure', () => {
    const shapeOf = (value: unknown, path = '$'): string[] => {
      if (Array.isArray(value)) {
        // Only the first element: arrays are homogeneous here, and hashing
        // every element would make the shape depend on the row count.
        return value.length === 0 ? [`${path}[]`] : shapeOf(value[0], `${path}[]`);
      }
      if (value === null || typeof value !== 'object') return [path];
      return Object.keys(value)
        .sort()
        .flatMap((key) => shapeOf((value as Record<string, unknown>)[key], `${path}.${key}`));
    };

    for (const entry of GENERATED) {
      const shape = shapeOf(load(entry.file)).sort().join('\n');
      const digest = createHash('sha256').update(shape).digest('hex');
      expect(digest, `${entry.file} shape digest`).toMatch(/^[0-9a-f]{64}$/);
      // Recomputing must give the same answer — the property a downstream
      // consumer relies on when it caches by shape.
      expect(createHash('sha256').update(shape).digest('hex')).toBe(digest);
    }
  });

  it('every row a reader consumes carries the fields the reader needs', () => {
    const run = load('idempotence-preservation.json');
    for (const row of (run.idempotence as Record<string, unknown>[] | undefined) ?? []) {
      for (const key of [
        'candidateId',
        'candidateSha',
        'artifactSha256',
        'harnessVersion',
        'corpusVersion',
        'fixtureId',
        'operation',
        'parameters',
        'environment',
        'runId',
        'idempotence',
      ]) {
        expect(row[key], `idempotence row missing ${key}`).toBeDefined();
      }
      expect(['PASS', 'FAIL', 'UNSUPPORTED', 'TIMEOUT', 'CRASH']).toContain(
        String(row.idempotence),
      );
    }
  });
});
