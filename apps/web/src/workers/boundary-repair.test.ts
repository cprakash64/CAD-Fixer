import { afterEach, describe, expect, it } from 'vitest';
import {
  singlePartDocument,
  partId,
  triangleCount,
  type CanonicalMesh,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  BoundaryFillOutcomeStatus,
  BoundaryFillScanStatus,
  BoundaryFillVerdict,
  RepairAcceptance,
  type DocumentHandle,
  type OperationContext,
  type ProtocolPort,
  type RepairOperation,
  type RepairPlanOperationResult,
} from '@cadfixer/geometry-runtime';
import {
  AppErrorCode,
  CancellationSource,
  isAppError,
  operationCancelled,
  uncancellable,
  type CancellationToken,
} from '@cadfixer/shared';
import { classifyLocalPatches } from '@cadfixer/mesh-hole-fill';
import * as fx from '@cadfixer/mesh-hole-fill/fixtures';
import { analyseTopology, scanBoundaries } from '@cadfixer/mesh-topology';
import { repairCandidates, repairHistory, residentDocuments } from './stl-handlers';
import {
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairPlanHandler,
  repairUndoHandler,
} from './repair-handlers';
import type { LocalVerifyMessage, LocalVerifyReply } from './hole-fill-protocol';

/**
 * REPAIR-CORE-02 THROUGH THE REAL HANDLERS.
 *
 * Plan → candidate (with a verifier channel) → commit → undo, in-process,
 * against the resident document store the product uses. The verifier here runs
 * the same `classifyLocalPatches` the disposable worker runs, with the
 * test-only reference narrowphase; the kernel-backed equivalence is
 * `node-tests/local-fill-kernel.test.ts`.
 */

const PART = partId('part-1');
const REQUESTED: readonly RepairOperation[] = [
  'remove-duplicate-faces',
  'remove-repeated-position-faces',
  'remove-zero-area-faces',
  'unify-winding',
];

function context(cancellation: CancellationToken = uncancellable): OperationContext {
  return {
    cancellation,
    interruptible: true,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

interface Verifier {
  readonly port: ProtocolPort;
  readonly requests: LocalVerifyMessage[];
  close(): void;
}

/** A verifier that answers like the disposable worker — or never, when `silent`. */
function verifier(options: { readonly silent?: boolean } = {}): Verifier {
  const channel = new MessageChannel();
  const requests: LocalVerifyMessage[] = [];
  channel.port2.onmessage = (event: MessageEvent<LocalVerifyMessage>): void => {
    const message = event.data;
    requests.push(message);
    if (options.silent === true) return;
    const verdicts = classifyLocalPatches(
      {
        positions: message.positions,
        triangles: message.triangles,
        sourceFaceCount: message.sourceFaceCount,
        loopRanges: message.loopRanges,
        loopIds: [],
        excluded: [],
      },
      fx.referenceNarrowphase(),
    );
    const reply: LocalVerifyReply = {
      kind: 'verified',
      operationId: message.operationId,
      verdicts: verdicts.map((verdict) => ({ ...verdict })),
    };
    channel.port2.postMessage(reply);
  };
  return {
    port: channel.port1,
    requests,
    close: (): void => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

function resident(handle: DocumentHandle, part: PartId = PART): CanonicalMesh {
  const resolved = residentDocuments.resolvePart(handle, part);
  if (isAppError(resolved)) throw resolved;
  return resolved.mesh;
}

function boundaryEdges(mesh: CanonicalMesh): number {
  return scanBoundaries(mesh, { limits: { maxBoundaryEdges: 1_000_000, maxLoopVertices: 512 } })
    .boundaryEdgeCount;
}

async function plan(handle: DocumentHandle): Promise<RepairPlanOperationResult> {
  return (
    await repairPlanHandler(
      { handle, partId: PART, requested: REQUESTED, fillOpenings: true },
      context(),
    )
  ).value;
}

afterEach(() => {
  residentDocuments.releaseAll();
  repairCandidates.releaseAll();
  repairHistory.releaseAll();
});

describe('planning', () => {
  it(
    'admits openings on a part far above the per-opening engine’s ceiling',
    { timeout: 60_000 },
    async () => {
      // 300,000+ faces: above the 250,000-face per-opening ceiling.
      const mesh = fx.hp27LargeInPolicyPart(300_000);
      expect(triangleCount(mesh)).toBeGreaterThan(250_000);
      const handle = residentDocuments.commit(singlePartDocument(mesh));
      const planned = await plan(handle);
      expect(planned.plan.noOp).toBe(true);
      expect(planned.boundaryFill.status).toBe(BoundaryFillScanStatus.Scanned);
      expect(planned.boundaryFill.admittedCount).toBe(2);
    },
  );

  it('plans nothing when filling is not asked for', async () => {
    const handle = residentDocuments.commit(singlePartDocument(fx.hp02QuadHole()));
    const planned = await repairPlanHandler(
      { handle, partId: PART, requested: REQUESTED },
      context(),
    );
    expect(planned.value.boundaryFill.status).toBe(BoundaryFillScanStatus.NotRequested);
  });
});

describe('candidate, commit and undo', () => {
  it(
    'builds ONE combined candidate, commits it atomically, and undo restores the exact object',
    {
      timeout: 60_000,
    },
    async () => {
      const mesh = fx.hp27LargeInPolicyPart(300_000);
      const handle = residentDocuments.commit(singlePartDocument(mesh));
      const planned = await plan(handle);
      const check = verifier();
      const built = await repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash: planned.plan.planHash,
          fillOpenings: true,
          fillPlanHash: planned.boundaryFill.planHash,
          verifierPort: check.port,
        },
        context(),
      );
      check.close();
      const value = built.value;
      expect(value.validation.acceptance).toBe(RepairAcceptance.Accepted);
      expect(value.boundaryFill?.status).toBe(BoundaryFillOutcomeStatus.Filled);
      expect(value.boundaryFill?.filledCount).toBe(2);
      expect(value.counts.candidateFaceCount).toBe(triangleCount(mesh) + 4);
      // Fill-only: the preview carries the four patch triangles, never a second
      // copy of the 300,000-face part.
      expect(value.render).toBeUndefined();
      expect(value.patchRender?.vertexCount).toBe(4 * 3);
      // ONLY the local region crossed to the verifier: a handful of faces, not
      // the 300,000-face part.
      const request = check.requests[0];
      expect(request?.sourceFaceCount).toBeLessThan(20);
      const candidate = value.candidate;
      if (candidate === undefined) throw new Error('no candidate');

      const committed = await repairCommitHandler(
        {
          candidate,
          expectedSource: handle,
          expectedPart: PART,
          planHash: planned.plan.planHash,
        },
        context(),
      );
      const repaired = resident(committed.value.handle);
      expect(boundaryEdges(repaired)).toBe(0);
      // The existing triangles are byte-identical: the patch is appended.
      expect(repaired.positions).toBe(mesh.positions);
      expect(new Uint8Array(repaired.indices.buffer, 0, mesh.indices.byteLength)).toEqual(
        new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength),
      );

      const undone = await repairUndoHandler(
        { handle: committed.value.handle, recordId: committed.value.repairRecordId },
        context(),
      );
      expect(resident(undone.value.handle)).toBe(mesh);
    },
  );

  it('fails closed without a verifier: nothing is filled', async () => {
    const handle = residentDocuments.commit(singlePartDocument(fx.hp02QuadHole()));
    const planned = await plan(handle);
    const built = await repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash: planned.plan.planHash,
        fillOpenings: true,
        fillPlanHash: planned.boundaryFill.planHash,
      },
      context(),
    );
    expect(built.value.candidate).toBeUndefined();
    expect(built.value.boundaryFill?.status).toBe(BoundaryFillOutcomeStatus.NothingPassed);
    expect(built.value.boundaryFill?.loops.every((loop) => loop.verdict !== 'FILLED')).toBe(true);
  });

  it('fills what passes and names what the exact check refused (HP23)', async () => {
    const handle = residentDocuments.commit(singlePartDocument(fx.hp23PatchPiercesOppositeShell()));
    const planned = await plan(handle);
    const check = verifier();
    const built = await repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash: planned.plan.planHash,
        fillOpenings: true,
        fillPlanHash: planned.boundaryFill.planHash,
        verifierPort: check.port,
      },
      context(),
    );
    check.close();
    const verdicts = built.value.boundaryFill?.loops.map((loop) => loop.verdict) ?? [];
    expect(verdicts).toContain(BoundaryFillVerdict.WouldIntersect);
    expect(verdicts).toContain(BoundaryFillVerdict.Filled);
    expect(built.value.validation.acceptance).toBe(RepairAcceptance.Accepted);
  });

  it('combines a conservative removal with the fills in the same candidate', async () => {
    // The tube plus one exact duplicate of its first face, far from both rims.
    const tube = fx.hp02QuadHole();
    const duplicate = fx.soup([
      [
        [50, 50, 50],
        [51, 50, 50],
        [50, 51, 50],
      ],
      [
        [50, 50, 50],
        [51, 50, 50],
        [50, 51, 50],
      ],
      [
        [50, 50, 50],
        [50, 51, 50],
        [51, 50, 50],
      ],
    ]);
    const mesh = fx.concatMeshes(tube, duplicate);
    const handle = residentDocuments.commit(singlePartDocument(mesh));
    const planned = await plan(handle);
    expect(planned.plan.noOp).toBe(false);
    const check = verifier();
    const built = await repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash: planned.plan.planHash,
        fillOpenings: true,
        fillPlanHash: planned.boundaryFill.planHash,
        verifierPort: check.port,
      },
      context(),
    );
    check.close();
    expect(built.value.validation.acceptance).toBe(RepairAcceptance.Accepted);
    expect(built.value.counts.removedDuplicateFaces).toBe(1);
    // Conservative repair changed existing triangles, so the full candidate is drawn.
    expect(built.value.render).toBeDefined();
    expect(built.value.patchRender).toBeUndefined();
    expect(built.value.boundaryFill?.filledCount).toBeGreaterThan(0);
  });

  it('is deterministic: two builds give byte-identical candidates', async () => {
    const mesh = fx.hp12TwoIndependentHoles();
    const handle = residentDocuments.commit(singlePartDocument(mesh));
    const planned = await plan(handle);
    const build = async (): Promise<CanonicalMesh> => {
      const check = verifier();
      const built = await repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash: planned.plan.planHash,
          fillOpenings: true,
          fillPlanHash: planned.boundaryFill.planHash,
          verifierPort: check.port,
        },
        context(),
      );
      check.close();
      const candidate = built.value.candidate;
      if (candidate === undefined) throw new Error('no candidate');
      const resolved = repairCandidates.prepareCommit(
        { candidate, expectedSource: handle, expectedPart: PART, planHash: planned.plan.planHash },
        handle.revision,
      );
      if (isAppError(resolved)) throw resolved;
      return resolved;
    };
    const first = await build();
    const second = await build();
    expect(new Uint8Array(second.indices.buffer)).toEqual(new Uint8Array(first.indices.buffer));
  });
});

describe('staleness and cancellation', () => {
  it('refuses a candidate for a fill plan the source no longer matches', async () => {
    const handle = residentDocuments.commit(singlePartDocument(fx.hp02QuadHole()));
    const planned = await plan(handle);
    await expect(
      repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash: planned.plan.planHash,
          fillOpenings: true,
          fillPlanHash: 'bf-not-this-one',
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: AppErrorCode.InvalidState });
  });

  it('refuses a stale handle after the document moved on', async () => {
    const mesh = fx.hp02QuadHole();
    const handle = residentDocuments.commit(singlePartDocument(mesh));
    const planned = await plan(handle);
    residentDocuments.releaseAll();
    const replaced = residentDocuments.commit(singlePartDocument(fx.hp12TwoIndependentHoles()));
    expect(replaced.documentId).not.toBe(handle.documentId);
    await expect(
      repairCreateCandidateHandler(
        {
          handle,
          partId: PART,
          requested: REQUESTED,
          planHash: planned.plan.planHash,
          fillOpenings: true,
          fillPlanHash: planned.boundaryFill.planHash,
        },
        context(),
      ),
    ).rejects.toBeDefined();
  });

  it('cancels while waiting for the verifier, and registers nothing', async () => {
    const handle = residentDocuments.commit(singlePartDocument(fx.hp02QuadHole()));
    const planned = await plan(handle);
    const check = verifier({ silent: true });
    const source = new CancellationSource();
    const pending = repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash: planned.plan.planHash,
        fillOpenings: true,
        fillPlanHash: planned.boundaryFill.planHash,
        verifierPort: check.port,
      },
      context(source.token),
    );
    // Let the request reach the verifier, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(check.requests).toHaveLength(1);
    source.cancel();
    await expect(pending).rejects.toMatchObject({ code: AppErrorCode.OperationCancelled });
    check.close();
    expect(repairCandidates.stats().candidateCount).toBe(0);
  });
});

describe('the filled result survives the formats', () => {
  it('re-analyses closed where it was filled', async () => {
    const handle = residentDocuments.commit(singlePartDocument(fx.hp04ConcaveL()));
    const planned = await plan(handle);
    const check = verifier();
    const built = await repairCreateCandidateHandler(
      {
        handle,
        partId: PART,
        requested: REQUESTED,
        planHash: planned.plan.planHash,
        fillOpenings: true,
        fillPlanHash: planned.boundaryFill.planHash,
        verifierPort: check.port,
      },
      context(),
    );
    check.close();
    const candidate = built.value.candidate;
    if (candidate === undefined) throw new Error('no candidate');
    const resolved = repairCandidates.prepareCommit(
      { candidate, expectedSource: handle, expectedPart: PART, planHash: planned.plan.planHash },
      handle.revision,
    );
    if (isAppError(resolved)) throw resolved;
    const report = analyseTopology(resolved, {
      documentId: 'x',
      partId: 'p',
      documentRevision: 1,
      cancellation: uncancellable,
    }).report;
    expect(report.boundaryEdgeCount).toBe(0);
  });
});
