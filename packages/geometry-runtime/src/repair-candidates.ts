import { invalidState, modelUnavailable, type AppError } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { RepairInversePatch, RepairValidation } from '@cadfixer/mesh-repair';
import { meshByteLength, type ModelHandle, type ModelId } from './resident-models';

/**
 * WORKER-RESIDENT REPAIR CANDIDATES.
 *
 * A candidate is proposed geometry that is NOT authoritative. It exists so a
 * repair can be computed, validated and previewed while the model the user
 * actually has stays exactly as it was. Only `commit` makes a candidate real,
 * and only if every guard still holds at that moment.
 *
 * WHY A SEPARATE HANDLE TYPE. `RepairCandidateHandle` is deliberately NOT a
 * `ModelHandle`. Export, analysis and every future operation take a
 * `ModelHandle`, so a candidate cannot be passed to them by mistake — the
 * compiler refuses. Making both "an id and a revision" would have been simpler
 * and would have let a candidate be exported as though it were the user's
 * model.
 *
 * THE GUARDS, each protecting a specific failure:
 *   - source revision must still be current   (stale repair cannot land)
 *   - candidate must be RESOLVED              (unvalidated geometry cannot land)
 *   - validation must be ACCEPTED             (a rejected repair cannot land)
 *   - plan hash must match                    (commit what was previewed)
 *   - a candidate commits or discards ONCE    (no double commit, no revival)
 */

declare const candidateIdBrand: unique symbol;

export type RepairCandidateId = string & { readonly [candidateIdBrand]: true };

export const CandidateState = {
  /** Geometry built, not yet judged. */
  Draft: 'draft',
  /** Validated and eligible to commit, if it was accepted. */
  Resolved: 'resolved',
  Committed: 'committed',
  Discarded: 'discarded',
} as const;

export type CandidateState = (typeof CandidateState)[keyof typeof CandidateState];

export interface RepairCandidateHandle {
  readonly candidateId: RepairCandidateId;
  readonly modelId: ModelId;
  /** Revision the candidate was computed FROM. Checked again at commit. */
  readonly sourceRevision: number;
  /** Increments if a candidate is ever recomputed for the same model. */
  readonly generation: number;
}

interface CandidateEntry {
  readonly handle: RepairCandidateHandle;
  mesh: CanonicalMesh | undefined;
  state: CandidateState;
  readonly validation: RepairValidation;
  readonly inverse: RepairInversePatch | undefined;
  readonly byteLength: number;
}

export interface CandidateStats {
  readonly candidateCount: number;
  readonly totalBytes: number;
}

export interface CommitRequest {
  readonly candidate: RepairCandidateHandle;
  /** What the caller believes is authoritative. Must still be true. */
  readonly expectedSource: ModelHandle;
  /** Identity of the validation the caller accepted. */
  readonly planHash: string;
}

export class RepairCandidateStore {
  private readonly candidates = new Map<RepairCandidateId, CandidateEntry>();
  /** At most one live candidate per model — see `create`. */
  private readonly activeByModel = new Map<ModelId, RepairCandidateId>();
  private nextId = 1;
  private nextGeneration = 1;

  /**
   * Registers a validated candidate and supersedes any earlier one.
   *
   * ONE ACTIVE CANDIDATE PER MODEL. The simplest safe policy: a second repair
   * proposal for the same model deterministically invalidates the first, whose
   * geometry is released immediately. Allowing several would mean deciding
   * which one commit meant, and a wrong answer there silently applies the wrong
   * repair.
   */
  public create(
    source: ModelHandle,
    mesh: CanonicalMesh,
    validation: RepairValidation,
    inverse: RepairInversePatch | undefined,
  ): RepairCandidateHandle {
    const previous = this.activeByModel.get(source.modelId);
    if (previous !== undefined) this.discardById(previous);

    const candidateId = `candidate-${String(this.nextId)}` as RepairCandidateId;
    this.nextId += 1;
    const generation = this.nextGeneration;
    this.nextGeneration += 1;

    const handle: RepairCandidateHandle = {
      candidateId,
      modelId: source.modelId,
      sourceRevision: source.revision,
      generation,
    };
    this.candidates.set(candidateId, {
      handle,
      mesh,
      state: CandidateState.Resolved,
      validation,
      inverse,
      byteLength: meshByteLength(mesh),
    });
    this.activeByModel.set(source.modelId, candidateId);
    return handle;
  }

  public validationOf(handle: RepairCandidateHandle): RepairValidation | undefined {
    return this.candidates.get(handle.candidateId)?.validation;
  }

  public inverseOf(handle: RepairCandidateHandle): RepairInversePatch | undefined {
    return this.candidates.get(handle.candidateId)?.inverse;
  }

  public stateOf(handle: RepairCandidateHandle): CandidateState | undefined {
    return this.candidates.get(handle.candidateId)?.state;
  }

  /**
   * Resolves a candidate for commit, applying every guard.
   *
   * Returns the mesh only when the candidate may legitimately become
   * authoritative. Every rejection is a typed `AppError`, never a silent
   * `undefined` a caller might treat as "nothing to do".
   */
  public prepareCommit(
    request: CommitRequest,
    currentRevision: number | undefined,
  ): CanonicalMesh | AppError {
    const entry = this.candidates.get(request.candidate.candidateId);
    if (entry === undefined) {
      return modelUnavailable('That repair candidate is no longer available.', {
        candidateId: request.candidate.candidateId,
      });
    }

    if (entry.state === CandidateState.Committed) {
      // CR22. Committing twice would create a second revision from geometry
      // that is already the previous revision's successor.
      return invalidState('That repair has already been applied.', {
        candidateId: request.candidate.candidateId,
        state: entry.state,
      });
    }
    if (entry.state === CandidateState.Discarded) {
      // CR21. A discarded candidate is gone, and must not be revivable.
      return invalidState('That repair was discarded and can no longer be applied.', {
        candidateId: request.candidate.candidateId,
        state: entry.state,
      });
    }
    if (entry.state !== CandidateState.Resolved) {
      return invalidState('That repair has not finished validating.', {
        candidateId: request.candidate.candidateId,
        state: entry.state,
      });
    }

    if (entry.handle.modelId !== request.expectedSource.modelId) {
      return invalidState('That repair belongs to a different model.', {
        candidateId: request.candidate.candidateId,
        candidateModelId: entry.handle.modelId,
        requestedModelId: request.expectedSource.modelId,
      });
    }

    // CR20. The model must still be at the revision the repair was computed
    // from — both as the caller believes it, and as the store actually holds it.
    if (
      entry.handle.sourceRevision !== request.expectedSource.revision ||
      currentRevision !== entry.handle.sourceRevision
    ) {
      return modelUnavailable('The model changed since this repair was prepared.', {
        candidateId: request.candidate.candidateId,
        candidateSourceRevision: entry.handle.sourceRevision,
        requestedRevision: request.expectedSource.revision,
        currentRevision: currentRevision ?? -1,
      });
    }

    // CR24. A candidate the validators rejected can never be committed, no
    // matter what the caller asks for.
    if (entry.validation.acceptance !== 'ACCEPTED') {
      return invalidState('That repair did not pass validation and cannot be applied.', {
        candidateId: request.candidate.candidateId,
        acceptance: entry.validation.acceptance,
      });
    }

    if (entry.validation.planHash !== request.planHash) {
      // Commit what was previewed. A different plan hash means the caller is
      // approving something other than what it saw.
      return invalidState('That repair plan no longer matches the one that was validated.', {
        candidateId: request.candidate.candidateId,
        expected: entry.validation.planHash,
        received: request.planHash,
      });
    }

    const mesh = entry.mesh;
    if (mesh === undefined) {
      return modelUnavailable('That repair candidate no longer holds geometry.', {
        candidateId: request.candidate.candidateId,
      });
    }
    return mesh;
  }

  /**
   * Marks a candidate committed and releases its geometry reference.
   *
   * Called only AFTER the resident store has accepted the swap, so a failed
   * swap leaves the candidate resolved and retryable rather than consumed.
   */
  public markCommitted(handle: RepairCandidateHandle): void {
    const entry = this.candidates.get(handle.candidateId);
    if (entry === undefined) return;
    entry.state = CandidateState.Committed;
    // The resident store owns the mesh now; the candidate must not keep a
    // second reference alive.
    entry.mesh = undefined;
    this.activeByModel.delete(entry.handle.modelId);
  }

  /**
   * Discards a candidate, releasing its geometry.
   *
   * IDEMPOTENT BY DESIGN for the discard itself: discarding twice reports
   * `false` for "something was released" rather than erroring, because a user
   * cancelling twice is not a fault. Attempting to COMMIT afterwards is a
   * typed error — that is the case where silence would be dangerous.
   */
  public discard(handle: RepairCandidateHandle): boolean {
    return this.discardById(handle.candidateId);
  }

  private discardById(candidateId: RepairCandidateId): boolean {
    const entry = this.candidates.get(candidateId);
    if (entry === undefined) return false;
    const released =
      entry.state === CandidateState.Draft || entry.state === CandidateState.Resolved;
    if (released) {
      entry.state = CandidateState.Discarded;
      entry.mesh = undefined;
      this.activeByModel.delete(entry.handle.modelId);
    }
    return released;
  }

  /**
   * Releases everything.
   *
   * Called when the worker session ends. Policy A says authoritative geometry
   * does not survive worker loss, so a candidate certainly must not — and the
   * application distinguishes the two because a lost session invalidates the
   * MODEL handle too, not just the candidate.
   */
  public releaseAll(): void {
    for (const entry of this.candidates.values()) {
      entry.mesh = undefined;
      entry.state = CandidateState.Discarded;
    }
    this.candidates.clear();
    this.activeByModel.clear();
  }

  public stats(): CandidateStats {
    let totalBytes = 0;
    let candidateCount = 0;
    for (const entry of this.candidates.values()) {
      if (entry.mesh === undefined) continue;
      candidateCount += 1;
      totalBytes += entry.byteLength;
    }
    return { candidateCount, totalBytes };
  }
}
