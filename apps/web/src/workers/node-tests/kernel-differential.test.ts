import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import createCurrentKernel from '@cadfixer/self-intersection-kernel';
import { FIXTURES } from '../../../../../experiments/self-intersection/fixtures.mjs';

/**
 * OLD VERSUS NEW GEOGRAM ARTIFACT — a SEMANTIC differential.
 *
 * WHY THIS EXISTS. Stage 4B-1B1 added `cf_hf_begin` / `cf_hf_classify` /
 * `cf_hf_end` to `binding.cpp` and rebuilt the WebAssembly, so the artifact that
 * ships is no longer byte-identical to the one Stage 3C-1A-R1 qualified. Three
 * things were already established: the unchanged source rebuilt
 * byte-identically before the addition, `si_core.h` and `si_bvh.h` are still
 * byte-identical to the research copies, and the Stage 3C suites are green.
 *
 * None of those is the same claim as "the diagnostic answers the same thing".
 * A shared translation unit, a changed link order, a different heap layout or a
 * new global with a constructor could in principle move a result without moving
 * a header. So this runs the FROZEN Stage 3C corpus through BOTH artifacts and
 * compares every deterministic field.
 *
 * THE HASHES ARE EXPECTED TO DIFFER. Behaviour is what is being proven.
 *
 * THE BASELINE IS READ OUT OF GIT, never out of a rebuild. `git show` extracts
 * the committed pre-B1B1 artifact into a temporary directory; nothing in the
 * repository is modified, no history is rewritten, and the reference cannot
 * drift because it is a blob at a fixed commit.
 */

/** The last commit before Stage 4B-1B1 touched the kernel. */
const BASELINE_COMMIT = '34efd8b92f7164dc837c903611926026e0a2b941';
const ARTIFACT_DIRECTORY = 'packages/self-intersection-kernel/artifacts';

interface Kernel {
  _cf_si_run(
    positions: number,
    vertexCount: number,
    triangles: number,
    faceCount: number,
    maxCandidatePairs: number,
    maxTestedPairs: number,
    maxSamples: number,
  ): number;
  _cf_si_failed(): number;
  _cf_si_candidate_pairs(): number;
  _cf_si_tested_pairs(): number;
  _cf_si_intersecting_pairs(): number;
  _cf_si_affected_faces(): number;
  _cf_si_proper_crossing(): number;
  _cf_si_coplanar_overlap(): number;
  _cf_si_point_touch(): number;
  _cf_si_edge_touch(): number;
  _cf_si_adjacent_beyond(): number;
  _cf_si_duplicate(): number;
  _cf_si_legitimate(): number;
  _cf_si_skipped_faces(): number;
  _cf_si_skipped_pairs(): number;
  _cf_si_unclassified_pairs(): number;
  _cf_si_sample_pairs(): number;
  _cf_si_samples_truncated(): number;
  _cf_si_samples(): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  readonly HEAPF64: Float64Array;
  readonly HEAPU32: Uint32Array;
}

function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, ARTIFACT_DIRECTORY))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate ${ARTIFACT_DIRECTORY} from ${process.cwd()}`);
}

/**
 * Extracts the pre-B1B1 artifact from git into a temporary directory.
 *
 * The glue keeps the name `self-intersection.js` deliberately: `vitest.config.ts`
 * externalises that filename so Node imports it natively, which Geogram's
 * CommonJS-detection `EM_ASM` requires (see the worker-kernel project comment).
 */
function extractBaseline(root: string): { glue: string; wasm: Buffer } {
  const directory = mkdtempSync(join(tmpdir(), 'cadfixer-kernel-baseline-'));
  mkdirSync(directory, { recursive: true });

  const show = (file: string): Buffer =>
    execFileSync('git', ['show', `${BASELINE_COMMIT}:${ARTIFACT_DIRECTORY}/${file}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    });

  const glue = join(directory, 'self-intersection.js');
  writeFileSync(glue, show('self-intersection.js'));
  return { glue, wasm: show('self-intersection.wasm') };
}

/** Every deterministic field `cf_si_run` publishes. Timings are excluded. */
interface Reading {
  status: number;
  failed: number;
  candidatePairs: number;
  testedPairs: number;
  intersectingPairs: number;
  affectedFaces: number;
  properCrossing: number;
  coplanarOverlap: number;
  pointTouch: number;
  edgeTouch: number;
  adjacentBeyond: number;
  duplicate: number;
  legitimate: number;
  skippedFaces: number;
  skippedPairs: number;
  unclassifiedPairs: number;
  samplePairs: number;
  samplesTruncated: number;
  samples: number[];
}

function read(
  kernel: Kernel,
  positions: readonly number[],
  triangles: readonly number[],
  caps: { candidates: number; tested: number; samples: number },
): Reading {
  const pos = Float64Array.from(positions);
  const tris = Uint32Array.from(triangles);
  const positionsPointer = kernel._malloc(pos.byteLength);
  const trianglesPointer = kernel._malloc(tris.byteLength);
  try {
    kernel.HEAPF64.set(pos, positionsPointer / Float64Array.BYTES_PER_ELEMENT);
    kernel.HEAPU32.set(tris, trianglesPointer / Uint32Array.BYTES_PER_ELEMENT);

    const status = kernel._cf_si_run(
      positionsPointer,
      pos.length / 3,
      trianglesPointer,
      tris.length / 3,
      caps.candidates,
      caps.tested,
      caps.samples,
    );

    const samplePairs = kernel._cf_si_sample_pairs();
    const samplesPointer = kernel._cf_si_samples();
    const samples =
      samplePairs > 0
        ? [
            ...kernel.HEAPU32.subarray(
              samplesPointer / Uint32Array.BYTES_PER_ELEMENT,
              samplesPointer / Uint32Array.BYTES_PER_ELEMENT + samplePairs * 3,
            ),
          ]
        : [];

    return {
      status,
      failed: kernel._cf_si_failed(),
      candidatePairs: kernel._cf_si_candidate_pairs(),
      testedPairs: kernel._cf_si_tested_pairs(),
      intersectingPairs: kernel._cf_si_intersecting_pairs(),
      affectedFaces: kernel._cf_si_affected_faces(),
      properCrossing: kernel._cf_si_proper_crossing(),
      coplanarOverlap: kernel._cf_si_coplanar_overlap(),
      pointTouch: kernel._cf_si_point_touch(),
      edgeTouch: kernel._cf_si_edge_touch(),
      adjacentBeyond: kernel._cf_si_adjacent_beyond(),
      duplicate: kernel._cf_si_duplicate(),
      legitimate: kernel._cf_si_legitimate(),
      skippedFaces: kernel._cf_si_skipped_faces(),
      skippedPairs: kernel._cf_si_skipped_pairs(),
      unclassifiedPairs: kernel._cf_si_unclassified_pairs(),
      samplePairs,
      samplesTruncated: kernel._cf_si_samples_truncated(),
      samples,
    };
  } finally {
    kernel._free(positionsPointer);
    kernel._free(trianglesPointer);
  }
}

interface Fixture {
  readonly id: string;
  readonly positions: readonly number[];
  readonly triangles: readonly number[];
}

const DEFAULT_CAPS = { candidates: 40_000_000, tested: 20_000_000, samples: 4_096 };

let baseline: Kernel;
let current: Kernel;
let corpus: readonly Fixture[] = [];
let baselineWasmSha = '';
let currentWasmSha = '';

beforeAll(async () => {
  const root = repositoryRoot();
  const extracted = extractBaseline(root);

  const factory = (await import(pathToFileURL(extracted.glue).href)) as {
    default: (options: { wasmBinary: Buffer }) => Promise<Kernel>;
  };
  baseline = await factory.default({ wasmBinary: extracted.wasm });

  const currentWasm = readFileSync(join(root, ARTIFACT_DIRECTORY, 'self-intersection.wasm'));
  current = await createCurrentKernel({ wasmBinary: currentWasm });

  const { createHash } = await import('node:crypto');
  baselineWasmSha = createHash('sha256').update(extracted.wasm).digest('hex');
  currentWasmSha = createHash('sha256').update(currentWasm).digest('hex');

  const generated = JSON.parse(
    readFileSync(join(root, 'experiments/self-intersection/generated-fixtures.json'), 'utf8'),
  ) as { fixtures: readonly Fixture[] };

  // The WHOLE frozen corpus: the 24 hand-authored adversarial cases plus the
  // three regenerated Stage 3A shells. Not a happy-path subset.
  corpus = [...(FIXTURES as readonly Fixture[]), ...generated.fixtures];
}, 120_000);

describe('the rebuilt kernel is a different binary', () => {
  it('has a different hash, which is expected and is not the claim', () => {
    expect(baselineWasmSha).not.toBe(currentWasmSha);
    expect(baselineWasmSha).toBe(
      '8f6b3fa78be55078780615ed2118d4446422030734d413d9e3b9ea4be582482f',
    );
  });

  it('covers the whole frozen Stage 3C corpus, not a subset', () => {
    expect(corpus.length).toBe(27);
    const ids = corpus.map((fixture) => fixture.id);
    // The classification cases §19 names, by the fixture that exercises each.
    for (const required of [
      'SI01', // clean
      'SI04', // proper crossing
      'SI08', // coplanar overlap
      'SI06', // non-adjacent point touch
      'SI07', // non-adjacent edge touch
      'SI02', // legitimate adjacency at scale
      'SI14', // adjacent overlap beyond the shared feature
      'SI13', // duplicate topology
      'SI16', // degenerate faces
      'R16', // regenerated interpenetrating shells
      'R17',
      'R18',
    ]) {
      expect(ids, `the corpus must retain ${required}`).toContain(required);
    }
  });
});

describe('cf_si_run is SEMANTICALLY unchanged across the rebuild', () => {
  it('agrees on every field of every frozen fixture', () => {
    const disagreements: string[] = [];
    for (const fixture of corpus) {
      const before = read(baseline, fixture.positions, fixture.triangles, DEFAULT_CAPS);
      const after = read(current, fixture.positions, fixture.triangles, DEFAULT_CAPS);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        disagreements.push(`${fixture.id}: ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
      }
    }
    expect(disagreements, 'the rebuilt kernel changed a Stage 3C answer').toEqual([]);
  });

  it('agrees fixture by fixture, so a failure names the case', () => {
    for (const fixture of corpus) {
      const before = read(baseline, fixture.positions, fixture.triangles, DEFAULT_CAPS);
      const after = read(current, fixture.positions, fixture.triangles, DEFAULT_CAPS);
      expect(after, `fixture ${fixture.id}`).toEqual(before);
    }
  });

  it('agrees on RESOURCE-CEILING behaviour, not only on clean completion', () => {
    /*
     * The path a rebuild is most likely to disturb: caps fire mid-traversal, so
     * the reported counts depend on the order the broadphase produced pairs.
     * Ceilings are pushed low enough to fire on the densest fixtures.
     */
    const tight = [
      { candidates: 4, tested: 4, samples: 1 },
      { candidates: 32, tested: 16, samples: 2 },
      { candidates: 1, tested: 1, samples: 0 },
    ];
    for (const caps of tight) {
      for (const fixture of corpus) {
        const before = read(baseline, fixture.positions, fixture.triangles, caps);
        const after = read(current, fixture.positions, fixture.triangles, caps);
        expect(after, `fixture ${fixture.id} at caps ${JSON.stringify(caps)}`).toEqual(before);
      }
    }
  }, 120_000);

  it('agrees on the DEGENERATE and PARTIAL paths', () => {
    // Explicitly, because a PARTIAL verdict is the one result a rebuild could
    // silently upgrade to CHECKED and make a lost diagnosis look like a clean one.
    const degenerate = corpus.filter((fixture) => {
      const before = read(baseline, fixture.positions, fixture.triangles, DEFAULT_CAPS);
      return before.skippedFaces > 0 || before.status === 1 || before.unclassifiedPairs > 0;
    });
    expect(degenerate.length).toBeGreaterThan(0);
    for (const fixture of degenerate) {
      const before = read(baseline, fixture.positions, fixture.triangles, DEFAULT_CAPS);
      const after = read(current, fixture.positions, fixture.triangles, DEFAULT_CAPS);
      expect(after, `degenerate/partial fixture ${fixture.id}`).toEqual(before);
    }
  });
});
