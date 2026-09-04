import { uncancellable } from '@cadfixer/shared';
import { computeBounds, triangleCount, validateMeshStructure } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from '@cadfixer/mesh-topology';
import type { TopologyReport } from '@cadfixer/mesh-topology';
import {
  ForbiddenOutcome,
  RepairStatus,
  summariseReport,
  type AcceptanceVerdict,
  type BakeoffRow,
  type GeometryChange,
  type RepairKernelCandidate,
  type RepairOperation,
  type RepairParameters,
  type TopologySummaryRow,
} from './contract';
import type { AcceptanceCriteria, ExpectedDiagnosis, RepairFixture } from './corpus';
import { FixtureScale } from './corpus';

/**
 * THE BAKEOFF HARNESS.
 *
 * Candidate-independent by construction: it knows about `RepairKernelCandidate`
 * and nothing about any particular kernel. There is no branch anywhere in this
 * file on a candidate id, because a harness that special-cases a candidate is
 * measuring itself.
 *
 * CAD FIXER DECIDES SUCCESS. A candidate reports what it did; this module runs
 * our own structural validation and our own topology analysis on the output and
 * forms the verdict from those. `kernelReportedSuccess` is carried into the
 * results as evidence about the kernel and is never consulted here.
 *
 * ONE FAILURE DOES NOT STOP THE RUN. A candidate that throws, traps, or hangs
 * produces a recorded row and the bakeoff continues — otherwise the first bad
 * kernel would deny us data about every other one.
 */

export interface HarnessOptions {
  /** Runs per case, for determinism checking. Two is the useful minimum. */
  readonly runs?: number;
  /** Per-operation ceiling. Exceeding it is recorded, not thrown. */
  readonly timeoutMs?: number;
  /**
   * Output triangle count beyond `inputTriangles × this` counts as an explosion.
   *
   * Generous on purpose: hole filling and intersection resolution legitimately
   * add geometry. This catches runaway output, not ordinary growth.
   */
  readonly triangleExplosionFactor?: number;
}

const DEFAULTS = {
  runs: 2,
  timeoutMs: 30_000,
  triangleExplosionFactor: 50,
} as const;

/**
 * Runs the full Stage 2 analysis. The independent oracle, used on both sides.
 *
 * Only the report is kept: the bounded detail samples exist to draw overlays,
 * and a benchmark has nothing to draw.
 */
export function diagnose(mesh: CanonicalMesh): TopologyReport {
  return analyseTopology(mesh, {
    documentId: 'evaluation',
    partId: 'part-1',
    documentRevision: 1,
    cancellation: uncancellable,
  }).report;
}

/**
 * Checks a fixture's pinned pre-repair diagnosis.
 *
 * Run BEFORE any candidate touches the mesh. A corpus whose fixtures do not
 * contain the defects they claim would make every subsequent number meaningless
 * — a "repair" of an absent defect scores perfectly.
 */
export function checkExpectation(
  report: TopologyReport,
  expected: ExpectedDiagnosis,
): readonly string[] {
  const summary = summariseReport(report);
  const failures: string[] = [];

  const exact = (
    label: string,
    actual: number | boolean,
    wanted: number | boolean | undefined,
  ): void => {
    if (wanted === undefined) return;
    if (actual !== wanted)
      failures.push(`${label}: expected ${String(wanted)}, got ${String(actual)}`);
  };
  const atLeast = (label: string, actual: number, wanted: number | undefined): void => {
    if (wanted === undefined) return;
    if (actual < wanted)
      failures.push(`${label}: expected at least ${String(wanted)}, got ${String(actual)}`);
  };

  exact('triangles', summary.triangles, expected.triangles);
  exact('topologicalVertices', summary.topologicalVertices, expected.topologicalVertices);
  exact('components', summary.components, expected.components);
  exact('boundaryEdges', summary.boundaryEdges, expected.boundaryEdges);
  atLeast('boundaryEdges', summary.boundaryEdges, expected.boundaryEdgesAtLeast);
  exact('simpleBoundaryLoops', summary.simpleBoundaryLoops, expected.simpleBoundaryLoops);
  exact('openBoundaryChains', summary.openBoundaryChains, expected.openBoundaryChains);
  exact('branchedBoundaries', summary.branchedBoundaries, expected.branchedBoundaries);
  exact('nonManifoldEdges', summary.nonManifoldEdges, expected.nonManifoldEdges);
  atLeast('nonManifoldEdges', summary.nonManifoldEdges, expected.nonManifoldEdgesAtLeast);
  exact('nonManifoldVertices', summary.nonManifoldVertices, expected.nonManifoldVertices);
  atLeast('nonManifoldVertices', summary.nonManifoldVertices, expected.nonManifoldVerticesAtLeast);
  exact('windingConflicts', summary.windingConflicts, expected.windingConflicts);
  atLeast('windingConflicts', summary.windingConflicts, expected.windingConflictsAtLeast);
  exact('duplicateFaces', summary.duplicateFaces, expected.duplicateFaces);
  exact('reversedDuplicateFaces', summary.reversedDuplicateFaces, expected.reversedDuplicateFaces);
  exact('repeatedPositionFaces', summary.repeatedPositionFaces, expected.repeatedPositionFaces);
  exact('zeroAreaFaces', summary.zeroAreaFaces, expected.zeroAreaFaces);
  exact('isEdgeManifold', summary.isEdgeManifold, expected.isEdgeManifold);
  exact('isVertexManifold', summary.isVertexManifold, expected.isVertexManifold);
  exact('isWindingConsistent', summary.isWindingConsistent, expected.isWindingConsistent);
  exact('isBoundaryFree', summary.isBoundaryFree, expected.isBoundaryFree);

  if (expected.signedVolumeSign !== undefined && expected.signedVolumeSign !== 0) {
    const sign = Math.sign(summary.signedVolume);
    if (sign !== expected.signedVolumeSign) {
      failures.push(
        `signedVolumeSign: expected ${String(expected.signedVolumeSign)}, got ${String(sign)}`,
      );
    }
  }

  return failures;
}

/** Kernel-neutral geometry-change metrics. All cheap; none require a kernel. */
export function measureChange(
  before: CanonicalMesh,
  beforeReport: TopologyReport,
  after: CanonicalMesh,
  afterReport: TopologyReport,
): GeometryChange {
  const boundsBefore = computeBounds(before);
  const boundsAfter = computeBounds(after);

  let boundingBoxDelta = 0;
  if (boundsBefore !== undefined && boundsAfter !== undefined) {
    for (let axis = 0; axis < 3; axis += 1) {
      boundingBoxDelta = Math.max(
        boundingBoxDelta,
        Math.abs((boundsAfter.min[axis] ?? 0) - (boundsBefore.min[axis] ?? 0)),
        Math.abs((boundsAfter.max[axis] ?? 0) - (boundsBefore.max[axis] ?? 0)),
      );
    }
  }

  // Volume delta only where the number means something on BOTH sides. A delta
  // between two uninterpretable algebraic sums would invent meaning.
  const volumeInterpretable = beforeReport.isBoundaryFree && afterReport.isBoundaryFree;

  return {
    triangleDelta: triangleCount(after) - triangleCount(before),
    topologicalVertexDelta:
      afterReport.topologicalVertexCount - beforeReport.topologicalVertexCount,
    componentDelta: afterReport.componentCount - beforeReport.componentCount,
    boundingBoxDelta,
    surfaceAreaDelta: afterReport.totalSurfaceArea - beforeReport.totalSurfaceArea,
    signedVolumeDelta: volumeInterpretable
      ? afterReport.totalSignedVolume - beforeReport.totalSignedVolume
      : undefined,
  };
}

/**
 * A stable summary of an output, for determinism comparison.
 *
 * Counts and rounded metrics rather than coordinates: bitwise coordinate
 * equality is too strict — a kernel may legitimately reorder output — and raw
 * coordinates must never enter a results file.
 */
export function digestOf(summary: TopologySummaryRow | undefined): string {
  if (summary === undefined) return 'none';
  return [
    summary.triangles,
    summary.topologicalVertices,
    summary.uniqueEdges,
    summary.components,
    summary.boundaryEdges,
    summary.nonManifoldEdges,
    summary.nonManifoldVertices,
    summary.windingConflicts,
    summary.surfaceArea.toFixed(6),
    summary.signedVolume.toFixed(6),
  ].join(':');
}

function hasNonFinite(mesh: CanonicalMesh): boolean {
  for (const value of mesh.positions) {
    if (!Number.isFinite(value)) return true;
  }
  return false;
}

/** Applies one fixture's acceptance criteria to a result. */
export function judge(
  criteria: readonly AcceptanceCriteria[],
  before: TopologySummaryRow,
  after: TopologySummaryRow | undefined,
  afterReport: TopologyReport | undefined,
  change: GeometryChange | undefined,
  forbidden: readonly ForbiddenOutcome[],
): AcceptanceVerdict {
  const satisfied: string[] = [];
  const violated: string[] = [];

  for (const criterion of criteria) {
    const failures: string[] = [];

    if (criterion.requiresUnchanged === true) {
      if (after === undefined) failures.push('no output');
      else if (digestOf(after) !== digestOf(before)) failures.push('output differs from input');
    }

    if (criterion.post !== undefined) {
      if (afterReport === undefined) failures.push('no output to check');
      else failures.push(...checkExpectation(afterReport, criterion.post));
    }

    if (criterion.maxAreaChangeFraction !== undefined && change !== undefined) {
      const fraction =
        before.surfaceArea === 0 ? 0 : Math.abs(change.surfaceAreaDelta) / before.surfaceArea;
      if (fraction > criterion.maxAreaChangeFraction) {
        failures.push(`area changed by ${(fraction * 100).toFixed(3)}%`);
      }
    }

    if (failures.length === 0) satisfied.push(criterion.id);
    else violated.push(`${criterion.id}: ${failures.join('; ')}`);
  }

  return {
    accepted: violated.length === 0 && forbidden.length === 0,
    satisfied,
    violated,
    forbidden,
  };
}

/**
 * Runs one candidate against one fixture for one operation.
 *
 * Never throws for a candidate failure. A trapped WASM call, a rejected
 * promise, and a timeout all become recorded rows so the run continues.
 */
export async function runCase(
  candidate: RepairKernelCandidate,
  fixture: RepairFixture,
  operation: RepairOperation,
  parameters: RepairParameters,
  options: HarnessOptions = {},
  scale: FixtureScale = FixtureScale.Tiny,
): Promise<BakeoffRow> {
  const runs = options.runs ?? DEFAULTS.runs;
  const explosionFactor = options.triangleExplosionFactor ?? DEFAULTS.triangleExplosionFactor;

  const input = fixture.build(scale);
  const inputTriangles = triangleCount(input);
  const preReport = diagnose(input);
  const pre = summariseReport(preReport);

  const forbidden: ForbiddenOutcome[] = [];
  const digests: string[] = [];

  let lastStatus: RepairStatus = RepairStatus.Failed;
  let lastWarnings: readonly string[] = [];
  let lastKernelSuccess = false;
  let lastElapsed = 0;
  let lastHeap: number | undefined;
  let post: TopologySummaryRow | undefined;
  let postReport: TopologyReport | undefined;
  let change: GeometryChange | undefined;
  let outputTriangles: number | undefined;

  for (let run = 0; run < runs; run += 1) {
    // A fresh input per run: a candidate that mutated its input would otherwise
    // make run 2 look non-deterministic for the wrong reason.
    const mesh = fixture.build(scale);

    let outcome;
    try {
      outcome = await candidate.repair(mesh, operation, parameters);
    } catch {
      // Recorded, not rethrown. The bakeoff continues.
      forbidden.push(ForbiddenOutcome.Crashed);
      lastStatus = RepairStatus.Failed;
      digests.push('crashed');
      continue;
    }

    lastStatus = outcome.status;
    lastWarnings = outcome.warnings;
    lastKernelSuccess = outcome.kernelReportedSuccess;
    lastElapsed = outcome.elapsedMs;
    lastHeap = outcome.peakWasmHeapBytes;

    if (outcome.status !== RepairStatus.Completed) {
      digests.push(`status:${outcome.status}`);
      continue;
    }

    const output = outcome.mesh;
    if (output === undefined) {
      forbidden.push(ForbiddenOutcome.UnexpectedlyEmpty);
      digests.push('empty');
      continue;
    }

    if (hasNonFinite(output)) {
      // Checked before anything else touches the mesh: a NaN coordinate makes
      // every downstream metric meaningless.
      forbidden.push(ForbiddenOutcome.NonFiniteCoordinate);
      digests.push('non-finite');
      continue;
    }

    // EMPTY IS CHECKED FIRST. An empty mesh also fails structural validation,
    // and reporting it as "not re-importable" would be true but useless — the
    // interesting fact is that the candidate deleted the model, which is a
    // different failure with a different cause.
    outputTriangles = triangleCount(output);
    if (outputTriangles === 0 && inputTriangles > 0) {
      forbidden.push(ForbiddenOutcome.UnexpectedlyEmpty);
      digests.push('empty');
      continue;
    }

    // OUR validation, not the candidate's claim.
    const structural = validateMeshStructure(output);
    if (!structural.valid) {
      forbidden.push(ForbiddenOutcome.OutputNotReimportable);
      digests.push('structurally-invalid');
      continue;
    }

    if (outputTriangles > inputTriangles * explosionFactor) {
      forbidden.push(ForbiddenOutcome.TriangleExplosion);
    }

    postReport = diagnose(output);
    post = summariseReport(postReport);
    change = measureChange(input, preReport, output, postReport);
    digests.push(digestOf(post));
  }

  // Determinism: every run must summarise identically.
  const first = digests[0];
  if (digests.length > 1 && digests.some((entry) => entry !== first)) {
    forbidden.push(ForbiddenOutcome.NonDeterministic);
  }

  const verdict = judge(
    fixture.acceptance,
    pre,
    post,
    postReport,
    change,
    // De-duplicated: the same forbidden outcome across runs is one finding.
    [...new Set([...forbidden, ...detectFixtureForbidden(fixture, pre, post)])],
  );

  return {
    candidateId: candidate.metadata.candidateId,
    candidateVersion: candidate.metadata.upstreamVersion,
    fixtureId: fixture.id,
    operation,
    confidence: confidenceOf(operation),
    parameters,
    status: lastStatus,
    kernelReportedSuccess: lastKernelSuccess,
    warnings: lastWarnings,
    elapsedMs: lastElapsed,
    initialisationMs: 0,
    wasmByteLength: candidate.metadata.wasmByteLength,
    peakWasmHeapBytes: lastHeap,
    inputTriangles,
    outputTriangles,
    preDiagnostics: pre,
    postDiagnostics: post,
    selfIntersection: candidate.selfIntersection,
    geometryChange: change,
    verdict,
    resultDigest: first ?? 'none',
  };
}

/**
 * Fixture-specific forbidden outcomes derived from the before/after summaries.
 *
 * These are the silent-damage checks. They are computed from OUR diagnosis of
 * both sides, so a candidate cannot avoid them by what it reports.
 */
function detectFixtureForbidden(
  fixture: RepairFixture,
  before: TopologySummaryRow,
  after: TopologySummaryRow | undefined,
): readonly ForbiddenOutcome[] {
  if (after === undefined) return [];
  const found: ForbiddenOutcome[] = [];
  const declared = new Set(fixture.forbidden);

  if (declared.has(ForbiddenOutcome.MergedDisjointShells) && after.components < before.components) {
    found.push(ForbiddenOutcome.MergedDisjointShells);
  }
  // Filling is detected by BOUNDARY EDGES falling, not by the loop count
  // falling. Damage that merges two rims into one also reduces the loop count
  // without filling anything, and calling that "filled an opening" would put a
  // wrong reason on a real failure. Filling is the operation that removes
  // boundary edges.
  if (
    declared.has(ForbiddenOutcome.FilledIntentionalOpening) &&
    after.boundaryEdges < before.boundaryEdges
  ) {
    found.push(ForbiddenOutcome.FilledIntentionalOpening);
  }
  if (declared.has(ForbiddenOutcome.CleanInputChanged) && digestOf(after) !== digestOf(before)) {
    found.push(ForbiddenOutcome.CleanInputChanged);
  }
  if (
    declared.has(ForbiddenOutcome.IntroducedNewDefect) &&
    (after.nonManifoldEdges > before.nonManifoldEdges ||
      after.nonManifoldVertices > before.nonManifoldVertices ||
      after.windingConflicts > before.windingConflicts ||
      after.boundaryEdges > before.boundaryEdges)
  ) {
    found.push(ForbiddenOutcome.IntroducedNewDefect);
  }

  return found;
}

/** The confidence class each operation carries, per REPAIR_POLICY.md. */
export function confidenceOf(operation: RepairOperation): BakeoffRow['confidence'] {
  switch (operation) {
    case 'remove-duplicate-faces':
    case 'remove-degenerate-faces':
    case 'unify-winding':
    case 'orient-outward':
      return 'deterministic';
    case 'weld-within-tolerance':
      return 'parameter-dependent';
    case 'fill-boundary-loops':
    case 'resolve-non-manifold':
    case 'resolve-self-intersections':
    case 'union-shells':
      return 'reconstructive';
    case 'rebuild-as-solid':
      return 'destructive-fallback';
  }
}
