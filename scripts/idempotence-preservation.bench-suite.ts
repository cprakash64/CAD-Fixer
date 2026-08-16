import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { computeBounds } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  CORPUS,
  diagnose,
  fromTransfer,
  summariseReport,
  symmetricSampledSurfaceDistance,
  toTransfer,
} from '@cadfixer/repair-evaluation';
import type { TopologySummaryRow } from '@cadfixer/repair-evaluation';

/**
 * STAGE 3A-3A — IDEMPOTENCE (§F) AND GEOMETRY PRESERVATION (§E).
 *
 * IDEMPOTENCE IS NOT A COUNT COMPARISON. `f(f(x)) == f(x)` is asserted over the
 * full Stage 2 summary, the bounding box, the area, the volume AND the sampled
 * surface distance between the two passes — because a kernel that reshuffled
 * coordinates while preserving every count would otherwise pass, and that is
 * the specific inference the spec rules out.
 *
 * PRESERVATION IS QUANTIFIED, NOT JUDGED. A non-zero distance means the
 * geometry changed; whether that change is acceptable is the fixture's
 * acceptance criteria talking, not this file. Filling R08's hole SHOULD move
 * the surface. Welding R21's intentional gap should not.
 *
 * NOT PART OF CI.
 */

const OUT_DIR = join(import.meta.dirname, '..', 'docs', 'repair', 'bakeoff');
const KERNELS = join(import.meta.dirname, '..', 'experiments', 'repair-kernels');
const RUNNER = join(KERNELS, 'scripts', 'run-idempotence.mjs');
const HARNESS_VERSION = 'stage-3a-3a.1';
const TIMEOUT_MS = 30_000;

const CANDIDATE_SHAS: Readonly<Record<string, string>> = {
  manifold: '11235e6b8ebea2dbed8aec4285685aafd3d95667',
  geogram: 'c8529bb00838186938ab31d96008a59b6a892dee',
  pmp: 'af4725ccf6aa308e7ffad9a7bb927c6381b7c858',
};

const ARTIFACTS: Readonly<Record<string, string>> = {
  manifold: join(KERNELS, 'manifold', 'artifacts', 'manifold-candidate.wasm'),
  geogram: join(KERNELS, 'geogram', 'artifacts', 'geogram-candidate.wasm'),
  pmp: join(KERNELS, 'pmp', 'artifacts', 'pmp-candidate.wasm'),
};

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

function sha256Of(path: string): string {
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface Measures {
  readonly topology: TopologySummaryRow;
  readonly boundingBox: readonly number[];
  readonly surfaceArea: number;
  readonly signedVolume: number;
}

function measure(mesh: CanonicalMesh): Measures {
  const topology = summariseReport(diagnose(mesh));
  const bounds = computeBounds(mesh);
  return {
    topology,
    boundingBox: bounds === undefined ? [] : [...bounds.min, ...bounds.max],
    surfaceArea: topology.surfaceArea,
    signedVolume: topology.signedVolume,
  };
}

/** Operations the frozen policy treats as convergent, per candidate role. */
const IDEMPOTENCE_CASES: readonly {
  candidateId: string;
  operation: string;
  parameter: number;
  fixtures: readonly string[];
}[] = [
  // Geogram, deterministic cleanup operations.
  {
    candidateId: 'geogram',
    operation: 'repairTopology',
    parameter: 0,
    fixtures: ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R09', 'R15', 'R21', 'R22', 'R28', 'R30'],
  },
  {
    candidateId: 'geogram',
    operation: 'repairDuplicateFacets',
    parameter: 0,
    fixtures: ['R01', 'R02', 'R03', 'R04', 'R28', 'R30'],
  },
  {
    candidateId: 'geogram',
    operation: 'reorient',
    parameter: 0,
    fixtures: ['R01', 'R02', 'R07', 'R28', 'R30'],
  },
  // Parameter-dependent, but idempotent AT A FIXED TOLERANCE — which is the
  // only sense in which a tolerance operation can be idempotent at all.
  {
    candidateId: 'geogram',
    operation: 'repairColocate',
    parameter: 1e-3,
    fixtures: ['R19', 'R20', 'R21'],
  },
  // PMP hole filling. R09 is deliberately absent: filling it is the product
  // decision R09 exists to catch, so it is never asked for.
  { candidateId: 'pmp', operation: 'fillHoles', parameter: 0, fixtures: ['R08', 'R28'] },
  // Manifold ingest — a round trip that should be the identity on clean solids.
  // R26 and R27 are included as the PRECISION probe: a float32 round trip
  // cannot represent a unit feature at 1e6, so the distance metric reports the
  // quantisation directly instead of us inferring it from a typedef.
  {
    candidateId: 'manifold',
    operation: 'ingest',
    parameter: 0,
    fixtures: ['R01', 'R02', 'R15', 'R16', 'R26', 'R27', 'R30'],
  },
  // PMP ingest at both coordinate extremes. PMP's pinned source selects
  // `using Scalar = float` unless PMP_SCALAR_TYPE_64 is defined (types.h:17),
  // and our build does not define it — so this measures what that costs rather
  // than asserting it from the header.
  {
    candidateId: 'pmp',
    operation: 'ingest',
    parameter: 0,
    fixtures: ['R01', 'R02', 'R22', 'R26', 'R27'],
  },
];

/** Fixtures whose preservation matters most, per §E. */
const PRESERVATION_FIXTURES = [
  'R01',
  'R02',
  'R09',
  'R15',
  'R16',
  'R21',
  'R22',
  'R26',
  'R27',
] as const;

it('measures idempotence and geometry preservation for supported operations', () => {
  const scratch = join(tmpdir(), `cf-idem-${String(process.pid)}`);
  mkdirSync(scratch, { recursive: true });

  const corpusHash = createHash('sha256');
  for (const fixture of CORPUS) {
    corpusHash.update(fixture.id);
    corpusHash.update(new Uint8Array(fixture.build().positions.buffer));
  }
  const corpusVersion = corpusHash.digest('hex').slice(0, 16);

  let sequence = 0;
  const rows: Record<string, unknown>[] = [];
  const preservation: Record<string, unknown>[] = [];

  for (const testCase of IDEMPOTENCE_CASES) {
    for (const fixtureId of testCase.fixtures) {
      const fixture = CORPUS.find((entry) => entry.id === fixtureId);
      if (fixture === undefined) continue;

      const source = fixture.build();
      const transfer = toTransfer(source);
      const pre = measure(source);

      sequence += 1;
      const requestPath = join(scratch, `req-${String(sequence)}.json`);
      const resultPath = join(scratch, `res-${String(sequence)}.json`);
      writeFileSync(
        requestPath,
        JSON.stringify({
          candidateId: testCase.candidateId,
          operation: testCase.operation,
          parameter: testCase.parameter,
          positions: [...transfer.positions],
          triangles: [...transfer.triangles],
        }),
      );

      let killed = false;
      try {
        execFileSync(process.execPath, [RUNNER, requestPath, resultPath], {
          timeout: TIMEOUT_MS,
          stdio: ['ignore', 'ignore', 'ignore'],
          maxBuffer: 128 * 1024 * 1024,
        });
      } catch {
        killed = true;
      }

      const base = {
        candidateId: testCase.candidateId,
        candidateSha: CANDIDATE_SHAS[testCase.candidateId] ?? 'unknown',
        artifactSha256: sha256Of(ARTIFACTS[testCase.candidateId] ?? ''),
        harnessVersion: HARNESS_VERSION,
        corpusVersion,
        fixtureId,
        operation: testCase.operation,
        parameters: { parameter: testCase.parameter },
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        runId: `${HARNESS_VERSION}-${String(sequence)}`,
        pre: pre.topology,
      };

      if (killed || !existsSync(resultPath)) {
        rows.push({
          ...base,
          idempotence: 'TIMEOUT',
          note: 'process killed or produced no result',
        });
        continue;
      }

      const payload = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
      if (payload.outcome === 'ABORTED') {
        rows.push({
          ...base,
          idempotence: 'CRASH',
          note: text(payload.message, '').slice(0, 200),
        });
        continue;
      }

      const first = payload.first as Record<string, unknown> | undefined;
      const second = payload.second as Record<string, unknown> | null | undefined;

      const refusedInput = first?.unsupportedInput === true;
      if (refusedInput || (first?.unsupportedOperation ?? null) !== null) {
        rows.push({
          ...base,
          idempotence: 'UNSUPPORTED',
          note: refusedInput
            ? 'candidate cannot represent this input class'
            : 'operation not implemented by this candidate',
        });
        continue;
      }
      if (
        typeof first?.status === 'number' &&
        first.status !== 0 &&
        testCase.candidateId === 'manifold'
      ) {
        rows.push({
          ...base,
          idempotence: 'UNSUPPORTED',
          note: `manifold rejected input, status ${String(first.status)}`,
        });
        continue;
      }

      if (
        first === undefined ||
        second === null ||
        second === undefined ||
        !Array.isArray(first.positions) ||
        !Array.isArray(first.triangles) ||
        !Array.isArray(second.positions) ||
        !Array.isArray(second.triangles)
      ) {
        rows.push({ ...base, idempotence: 'UNSUPPORTED', note: 'no mesh returned from one pass' });
        continue;
      }

      const meshA = fromTransfer(first.positions as number[], first.triangles as number[]);
      const meshB = fromTransfer(second.positions as number[], second.triangles as number[]);
      const a = measure(meshA);
      const b = measure(meshB);

      // A<->B distance, not just counts. This is what catches a second pass
      // that moved geometry while preserving every tally.
      const between = symmetricSampledSurfaceDistance(meshA, meshB, { samplesPerDirection: 4000 });

      const topologyEqual = JSON.stringify(a.topology) === JSON.stringify(b.topology);
      const boxEqual = JSON.stringify(a.boundingBox) === JSON.stringify(b.boundingBox);
      // Nine decimal places, matching the determinism rule already frozen for
      // the bakeoff.
      const areaEqual = Math.abs(a.surfaceArea - b.surfaceArea) < 1e-9;
      const volumeEqual = Math.abs(a.signedVolume - b.signedVolume) < 1e-9;
      const distanceZero = between.combinedMaxSampledDistance < 1e-9;

      const pass = topologyEqual && boxEqual && areaEqual && volumeEqual && distanceZero;

      rows.push({
        ...base,
        idempotence: pass ? 'PASS' : 'FAIL',
        firstPass: a.topology,
        secondPass: b.topology,
        checks: { topologyEqual, boxEqual, areaEqual, volumeEqual, distanceZero },
        aToBDistance: {
          combinedRms: between.combinedRmsDistance,
          combinedMax: between.combinedMaxSampledDistance,
        },
        surfaceAreaFirst: a.surfaceArea,
        surfaceAreaSecond: b.surfaceArea,
        signedVolumeFirst: a.signedVolume,
        signedVolumeSecond: b.signedVolume,
      });

      // §E — preservation of the INPUT against the first pass, recorded for the
      // control fixtures and for every reconstruction worth quantifying.
      if (
        (PRESERVATION_FIXTURES as readonly string[]).includes(fixtureId) ||
        testCase.operation === 'fillHoles' ||
        testCase.operation === 'repairColocate'
      ) {
        const change = symmetricSampledSurfaceDistance(source, meshA, {
          samplesPerDirection: 8000,
        });
        /*
         * SAMPLE-COUNT SENSITIVITY, RECORDED RATHER THAN HIDDEN.
         *
         * A sampled maximum can miss a change confined to a strip thinner than
         * the sample spacing. R20 showed exactly that between two runs of this
         * stage: welding a 1e-4 gap moves a sliver holding ~1e-5 of the surface
         * area, so whether ANY sample lands on it is close to chance. Reporting
         * one number would have made an unstable estimate look definitive, so
         * the same comparison is taken at three densities and all three are
         * kept. Divergence across them is the signal that counts and topology,
         * not distance, are the reliable evidence for that fixture.
         */
        const sensitivity = [2000, 8000, 32000].map((samples) => {
          const sweep = symmetricSampledSurfaceDistance(source, meshA, {
            samplesPerDirection: samples,
          });
          return {
            samplesPerDirection: samples,
            combinedRms: sweep.combinedRmsDistance,
            combinedMax: sweep.combinedMaxSampledDistance,
          };
        });

        preservation.push({
          sampleCountSensitivity: sensitivity,
          candidateId: testCase.candidateId,
          fixtureId,
          operation: testCase.operation,
          parameters: { parameter: testCase.parameter },
          intentionalReconstruction:
            testCase.operation === 'fillHoles' || testCase.operation === 'repairColocate',
          combinedRms: change.combinedRmsDistance,
          combinedMax: change.combinedMaxSampledDistance,
          p95: change.combinedP95Distance,
          p99: change.combinedP99Distance,
          normalisedRms: change.normalisedCombinedRmsDistance,
          normalisedMax: change.normalisedCombinedMaxSampledDistance,
          referenceDiagonal: change.referenceBoundingBoxDiagonal,
          samplingMode: change.configuration.samplingMode,
          seed: change.configuration.seed,
          triangleDelta: a.topology.triangles - pre.topology.triangles,
          componentDelta: a.topology.components - pre.topology.components,
          boundaryEdgeDelta: a.topology.boundaryEdges - pre.topology.boundaryEdges,
        });
      }
    }
  }

  writeFileSync(
    join(OUT_DIR, 'idempotence-preservation.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
        environment: `node ${process.version} ${process.platform}/${process.arch}`,
        corpusVersion,
        candidateShas: CANDIDATE_SHAS,
        artifactShas: Object.fromEntries(
          Object.entries(ARTIFACTS).map(([id, path]) => [id, sha256Of(path)]),
        ),
        idempotence: rows,
        preservation,
      },
      null,
      2,
    ),
  );
  rmSync(scratch, { recursive: true, force: true });

  const byStatus = new Map<string, number>();
  for (const row of rows) {
    const status = String(row.idempotence);
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  process.stdout.write(
    `\nidempotence: ${[...byStatus.entries()].map(([key, value]) => `${key}=${String(value)}`).join(' ')}\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `  ${String(row.candidateId).padEnd(9)} ${String(row.operation).padEnd(22)} ${String(row.fixtureId)} ${String(row.idempotence)}\n`,
    );
  }
}, 1_800_000);
