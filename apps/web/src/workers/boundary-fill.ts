import { assertMeshStructure, type CanonicalMesh } from '@cadfixer/mesh-core';
import {
  analyseTopology,
  BoundaryScanStatus,
  scanBoundaries,
  type TopologyReport,
} from '@cadfixer/mesh-topology';
import {
  admitBoundaryLoops,
  appendPatches,
  buildLocalPatchProblem,
  DEFAULT_BOUNDARY_FILL_LIMITS,
  judgeFilledCandidate,
  sourcePreserved,
  type AdmittedLoop,
  type BoundaryFillAdmission,
} from '@cadfixer/mesh-hole-fill/admission';
import {
  BOUNDARY_FILL_LOOP_LIST_LIMIT,
  BoundaryFillOutcomeStatus,
  BoundaryFillScanStatus,
  BoundaryFillVerdict,
  type BoundaryFillLoopSummary,
  type BoundaryFillOutcome,
  type BoundaryFillPlan,
  type ProtocolPort,
} from '@cadfixer/geometry-runtime';
import { internalError, operationCancelled, type CancellationToken } from '@cadfixer/shared';
import type { LocalVerdictWire, LocalVerifyMessage, LocalVerifyReply } from './hole-fill-protocol';

/**
 * AUTOMATIC BOUNDARY FILLING, AUTHORITATIVE SIDE — REPAIR-CORE-02.
 *
 * WHAT RUNS HERE, and why here. The compact boundary scan (topology only), the
 * bounded per-loop admission (planarity and ear clipping on at most 512 points
 * a loop), the local-region collection, the append-only candidate and the
 * independent Stage 2 re-analysis. Each is either O(part) and cooperatively
 * cancellable, or bounded by the loop limits.
 *
 * WHAT DOES NOT. The exact intersection check. It is not bounded by the loop,
 * it runs C++ that polls no JavaScript flag, and the Geogram kernel is confined
 * to the disposable fill worker — so the region crosses a MessageChannel to
 * that worker, whose termination is the cancel, and only verdicts come back.
 *
 * FAIL CLOSED. No verifier channel means no opening is verified, and an
 * unverified opening is never filled. A re-analysis that disagrees with the
 * prediction fills nothing.
 */

export interface FillPlanRecord {
  readonly plan: BoundaryFillPlan;
  /**
   * Once verified, `admitted` holds ONLY the openings that passed the exact
   * check; `decisions` still lists every opening the scan found.
   */
  readonly admission: BoundaryFillAdmission;
  /** Verdicts the exact check reached for openings it refused. */
  readonly checked: ReadonlyMap<string, BoundaryFillVerdict>;
  /** The exact mesh object the admission was computed for. */
  readonly mesh: CanonicalMesh;
}

/**
 * A few recent plans, keyed by document, revision and part — geometry at a
 * revision is immutable, so a plan for it never goes stale. It holds patches
 * (bounded by the batch limits), never the scan's edge table.
 */
const planCache = new Map<string, FillPlanRecord>();
const PLAN_CACHE_ENTRIES = 4;

export function fillPlanKey(documentId: string, revision: number, partId: string): string {
  return `${documentId}@${String(revision)}/${partId}`;
}

export function releaseFillPlans(documentId: string): void {
  for (const key of [...planCache.keys()]) {
    if (key.startsWith(`${documentId}@`)) planCache.delete(key);
  }
}

/** Plans filling for `mesh`, reusing a cached plan for the same revision and object. */
export function planBoundaryFill(
  key: string,
  mesh: CanonicalMesh,
  poll: () => void,
): FillPlanRecord {
  const cached = planCache.get(key);
  if (cached?.mesh === mesh) return cached;
  const record = computeFillPlan(key, mesh, poll);
  remember(key, record);
  return record;
}

function remember(key: string, record: FillPlanRecord): void {
  planCache.delete(key);
  planCache.set(key, record);
  while (planCache.size > PLAN_CACHE_ENTRIES) {
    const oldest = planCache.keys().next().value;
    if (oldest === undefined) break;
    planCache.delete(oldest);
  }
}

export interface FillCheckContext {
  readonly verifierPort: ProtocolPort;
  readonly operationId: string;
  readonly cancellation: CancellationToken;
  readonly throwIfCancelled: () => void;
}

/**
 * VERIFIES A PLAN BEFORE THE USER SEES IT — REPAIR-RC-03.
 *
 * Runs the exact local intersection check over every admitted opening and
 * returns a record whose `admitted` set is only the openings that passed, with
 * the others' verdicts in `checked`. The verified record replaces the
 * unverified one in the cache, so the candidate that follows binds to exactly
 * what the user was told. The check is deterministic over immutable geometry,
 * which is what makes a cached verdict for a revision safe to reuse.
 */
export async function verifyFillPlan(
  key: string,
  record: FillPlanRecord,
  context: FillCheckContext,
): Promise<FillPlanRecord> {
  if (record.plan.verified) return record;
  const check = await checkAdmitted(record.mesh, record.admission.admitted, context);
  const admission: BoundaryFillAdmission = {
    admitted: check.passing,
    decisions: record.admission.decisions,
  };
  const verified: FillPlanRecord = {
    mesh: record.mesh,
    admission,
    checked: check.refused,
    plan: planOf(key, record.plan, admission, check.refused, true),
  };
  if (planCache.get(key)?.mesh === record.mesh) remember(key, verified);
  return verified;
}

function computeFillPlan(key: string, mesh: CanonicalMesh, poll: () => void): FillPlanRecord {
  const scan = scanBoundaries(mesh, {
    limits: {
      maxBoundaryEdges: DEFAULT_BOUNDARY_FILL_LIMITS.maxBoundaryEdges,
      maxLoopVertices: DEFAULT_BOUNDARY_FILL_LIMITS.maxLoopVertices,
    },
    poll,
  });
  if (scan.status === BoundaryScanStatus.TooManyBoundaryEdges) {
    return {
      mesh,
      admission: { admitted: [], decisions: [] },
      checked: new Map(),
      plan: {
        status: BoundaryFillScanStatus.TooManyBoundaryEdges,
        boundaryEdgeCount: scan.boundaryEdgeCount,
        simpleLoopCount: 0,
        complexBoundaryCount: 0,
        admittedCount: 0,
        admittedPatchFaces: 0,
        loops: [],
        loopsTruncated: false,
        verified: true,
        planHash: hashOf(`${key}|too-many|${String(scan.boundaryEdgeCount)}`),
      },
    };
  }
  const admission = admitBoundaryLoops(mesh, scan);
  const checked = new Map<string, BoundaryFillVerdict>();
  const base: BoundaryFillPlan = {
    status: BoundaryFillScanStatus.Scanned,
    boundaryEdgeCount: scan.boundaryEdgeCount,
    simpleLoopCount: scan.simpleLoopCount,
    complexBoundaryCount: scan.complexBoundaryCount,
    admittedCount: 0,
    admittedPatchFaces: 0,
    loops: [],
    loopsTruncated: false,
    verified: false,
    planHash: '',
  };
  return {
    mesh,
    admission,
    checked,
    plan: planOf(key, base, admission, checked, admission.admitted.length === 0),
  };
}

function planOf(
  key: string,
  base: BoundaryFillPlan,
  admission: BoundaryFillAdmission,
  checked: ReadonlyMap<string, BoundaryFillVerdict>,
  verified: boolean,
): BoundaryFillPlan {
  let patchFaces = 0;
  for (const loop of admission.admitted) patchFaces += loop.patchFaceCount;
  const loops = capped(
    admission.decisions.map((decision) => ({
      id: decision.id,
      vertexCount: decision.vertexCount,
      verdict: checked.get(decision.id) ?? decision.verdict,
    })),
  );
  const ids = admission.admitted.map((loop) => loop.id).join(',');
  return {
    ...base,
    admittedCount: admission.admitted.length,
    admittedPatchFaces: patchFaces,
    loops: loops.rows,
    loopsTruncated: loops.truncated,
    verified,
    planHash: hashOf(`${key}|${verified ? 'verified' : 'admitted'}|${ids}`),
  };
}

export interface FillStageInput {
  /** The mesh to fill: the source, or the conservative candidate built from it. */
  readonly mesh: CanonicalMesh;
  /** Stage 2's report of exactly `mesh`. */
  readonly report: TopologyReport;
  /** A cached admission for `mesh`, when `mesh` is the source. */
  readonly record: FillPlanRecord | undefined;
  readonly verifierPort: ProtocolPort | undefined;
  readonly operationId: string;
  readonly documentId: string;
  readonly partId: string;
  readonly revision: number;
  readonly cancellation: CancellationToken;
  readonly throwIfCancelled: () => void;
  readonly onProgress: (fraction: number, note: string) => void;
}

export interface FillStageResult {
  /** The combined candidate, only when at least one opening was filled and validated. */
  readonly candidate: CanonicalMesh | undefined;
  /** Stage 2's report of `candidate`. */
  readonly after: TopologyReport | undefined;
  readonly outcome: BoundaryFillOutcome;
}

export async function runFillStage(input: FillStageInput): Promise<FillStageResult> {
  const record =
    input.record?.mesh === input.mesh
      ? input.record
      : computeFillPlan('stage', input.mesh, input.throwIfCancelled);

  const verdicts = new Map<string, BoundaryFillVerdict>();
  for (const decision of record.admission.decisions) {
    verdicts.set(decision.id, record.checked.get(decision.id) ?? decision.verdict);
  }
  const summary = (): BoundaryFillLoopSummary[] =>
    record.admission.decisions.map((decision) => ({
      id: decision.id,
      vertexCount: decision.vertexCount,
      verdict: verdicts.get(decision.id) ?? decision.verdict,
    }));
  const finish = (
    status: BoundaryFillOutcomeStatus,
    filled: readonly AdmittedLoop[],
    regressions: readonly string[] = [],
  ): BoundaryFillOutcome => {
    let patchFaces = 0;
    for (const loop of filled) patchFaces += loop.patchFaceCount;
    const rows = capped(summary());
    return {
      status,
      filledCount: filled.length,
      patchFaceCount: patchFaces,
      loops: rows.rows,
      loopsTruncated: rows.truncated,
      regressions,
    };
  };

  const admitted = record.admission.admitted;
  if (admitted.length === 0) {
    return {
      candidate: undefined,
      after: undefined,
      outcome: finish(
        record.checked.size > 0
          ? BoundaryFillOutcomeStatus.NothingPassed
          : BoundaryFillOutcomeStatus.None,
        [],
      ),
    };
  }

  // FAIL CLOSED: an opening nothing could check is never filled.
  if (input.verifierPort === undefined) {
    for (const loop of admitted) verdicts.set(loop.id, BoundaryFillVerdict.NotVerifiable);
    return {
      candidate: undefined,
      after: undefined,
      outcome: finish(BoundaryFillOutcomeStatus.NothingPassed, []),
    };
  }

  /*
   * THE EXACT CHECK RUNS AGAIN, EVEN FOR A VERIFIED PLAN. It is deterministic,
   * so a verified opening passes again; running it is what keeps "no candidate
   * without a check in this operation" a structural fact rather than a cache
   * property.
   */
  input.onProgress(0.8, 'checking openings');
  const check = await checkAdmitted(input.mesh, admitted, {
    verifierPort: input.verifierPort,
    operationId: input.operationId,
    cancellation: input.cancellation,
    throwIfCancelled: input.throwIfCancelled,
  });
  for (const [id, verdict] of check.refused) verdicts.set(id, verdict);
  const filled = check.passing;
  if (filled.length === 0) {
    return {
      candidate: undefined,
      after: undefined,
      outcome: finish(BoundaryFillOutcomeStatus.NothingPassed, []),
    };
  }

  /* ---- the append-only candidate and its independent verdict ---- */
  input.throwIfCancelled();
  input.onProgress(0.85, 'validating candidate');
  const candidate = appendPatches(input.mesh, filled);
  if (!sourcePreserved(input.mesh, candidate)) {
    throw internalError('A filled candidate did not preserve the source geometry.');
  }
  assertMeshStructure(candidate, 'repair/create-candidate');
  const after = analyseTopology(candidate, {
    documentId: input.documentId,
    documentRevision: input.revision,
    partId: input.partId,
    cancellation: input.cancellation,
    sampleLimit: 4096,
    onProgress: ({ fraction }) => {
      input.onProgress(0.85 + fraction * 0.1, 'validating candidate');
    },
  }).report;

  const regressions = judgeFilledCandidate(input.report, after, filled);
  if (regressions.length > 0) {
    return {
      candidate: undefined,
      after: undefined,
      outcome: finish(BoundaryFillOutcomeStatus.Rejected, [], regressions),
    };
  }
  for (const loop of filled) verdicts.set(loop.id, BoundaryFillVerdict.Filled);
  return { candidate, after, outcome: finish(BoundaryFillOutcomeStatus.Filled, filled) };
}

/* ------------------------------------------------------------ internals -- */

interface AdmittedCheck {
  readonly passing: AdmittedLoop[];
  readonly refused: Map<string, BoundaryFillVerdict>;
}

/**
 * The exact local check over `admitted`, in the disposable verifier. The ONE
 * implementation both the plan and the candidate use, so the two cannot
 * disagree about what passes.
 */
async function checkAdmitted(
  mesh: CanonicalMesh,
  admitted: readonly AdmittedLoop[],
  context: FillCheckContext,
): Promise<AdmittedCheck> {
  const refused = new Map<string, BoundaryFillVerdict>();
  if (admitted.length === 0) return { passing: [], refused };
  const problem = buildLocalPatchProblem(mesh, admitted, {
    maxFaces: DEFAULT_BOUNDARY_FILL_LIMITS.maxLocalFaces,
    poll: context.throwIfCancelled,
  });
  for (const id of problem.excluded) refused.set(id, BoundaryFillVerdict.RegionTooLarge);

  let wire: readonly LocalVerdictWire[] = [];
  if (problem.loopIds.length > 0) {
    const message: LocalVerifyMessage = {
      kind: 'verify-local',
      operationId: context.operationId,
      positions: problem.positions,
      triangles: problem.triangles,
      sourceFaceCount: problem.sourceFaceCount,
      loopRanges: problem.loopRanges,
    };
    const reply = await exchange(context.verifierPort, context.cancellation, (port) => {
      port.postMessage(message, [
        problem.positions.buffer,
        problem.triangles.buffer,
        problem.loopRanges.buffer,
      ]);
    });
    if (reply.kind === 'failed') {
      throw internalError('The opening check failed.', { details: { reason: reply.reason } });
    }
    if (reply.verdicts.length !== problem.loopIds.length) {
      throw internalError('The opening check answered for a different set of openings.');
    }
    wire = reply.verdicts;
  }

  const passing: AdmittedLoop[] = [];
  for (const [index, id] of problem.loopIds.entries()) {
    const verdict = wire[index];
    const loop = admitted.find((candidate) => candidate.id === id);
    if (verdict === undefined || loop === undefined) continue;
    if (!verdict.complete) {
      refused.set(id, BoundaryFillVerdict.NotVerifiable);
    } else if (verdict.invalidPatchSourcePairs > 0 || verdict.invalidPatchPatchPairs > 0) {
      refused.set(id, BoundaryFillVerdict.WouldIntersect);
    } else {
      passing.push(loop);
    }
  }
  return { passing, refused };
}

function capped(rows: BoundaryFillLoopSummary[]): {
  rows: BoundaryFillLoopSummary[];
  truncated: boolean;
} {
  return rows.length > BOUNDARY_FILL_LOOP_LIST_LIMIT
    ? { rows: rows.slice(0, BOUNDARY_FILL_LOOP_LIST_LIMIT), truncated: true }
    : { rows, truncated: false };
}

function hashOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return `bf-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/**
 * Posts one request and waits for exactly one reply, settling on cancellation
 * too: a verifier terminated mid-check never answers.
 */
async function exchange(
  port: ProtocolPort,
  cancellation: CancellationToken,
  send: (port: MessagePort) => void,
): Promise<LocalVerifyReply> {
  const channel = port as unknown as MessagePort;
  return new Promise<LocalVerifyReply>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      settled = true;
      channel.onmessage = null;
      unsubscribe();
    };
    const unsubscribe = cancellation.onCancelled(() => {
      if (settled) return;
      finish();
      reject(operationCancelled('Repair was cancelled.'));
    });
    channel.onmessage = (event: MessageEvent<LocalVerifyReply>): void => {
      if (settled) return;
      finish();
      resolve(event.data);
    };
    channel.start();
    if (cancellation.isCancelled) {
      finish();
      reject(operationCancelled('Repair was cancelled.'));
      return;
    }
    send(channel);
  });
}
