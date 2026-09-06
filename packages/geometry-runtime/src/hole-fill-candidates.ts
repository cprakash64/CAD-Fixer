import { meshByteLength } from '@cadfixer/mesh-core';
import type { CanonicalMesh, PartId } from '@cadfixer/mesh-core';
import { invalidState, modelUnavailable, type AppError } from '@cadfixer/shared';
import type { DocumentHandle, DocumentId } from './resident-documents';

/**
 * WORKER-RESIDENT HOLE-FILL CANDIDATES.
 *
 * A candidate is proposed geometry that is NOT authoritative. It exists so a
 * fill can be computed and validated while the model the user actually has
 * stays exactly as it was. Stage 4B-1B1 builds candidates and nothing more —
 * there is no commit path, no revision movement and no undo record, and there
 * must not be one until Stage 4B-1B2 designs the transaction.
 *
 * WHY A SEPARATE HANDLE TYPE, again. `HoleFillCandidateHandle` is deliberately
 * NOT a `DocumentHandle` and deliberately NOT a `RepairCandidateHandle`. Export,
 * analysis and every other operation take a `DocumentHandle`, so a candidate
 * cannot be handed to one by mistake — the compiler refuses. And a hole-fill
 * candidate cannot be committed through `repair/commit`, because that function
 * does not accept this type. Making all three "an id and a revision" would have
 * been simpler and would have let a candidate be exported as though it were the
 * user's model.
 *
 * WHAT THE PAGE HOLDS: this handle and a scalar summary. Never the mesh. The
 * store lives in the authoritative worker, which is the only place canonical
 * geometry is allowed to be — the same rule ADR 0008 states for documents and
 * repair candidates.
 *
 * STAGE 4B-1B2 ADDS THE TRANSACTION, and nothing else about the store changed.
 * `prepareCommit` applies every identity, staleness and lifecycle guard before
 * a candidate may replace a part, and `markCommitted` consumes it so the same
 * validated patch can never be applied twice. Both mirror
 * `RepairCandidateStore` deliberately: one transactional shape, checked in one
 * place, rather than a second set of rules that could disagree with the first.
 */

declare const holeFillCandidateIdBrand: unique symbol;

export type HoleFillCandidateId = string & { readonly [holeFillCandidateIdBrand]: true };

export const HoleFillCandidateState = {
  /** Validated, resident, and available for a future preview or apply. */
  Resolved: 'resolved',
  /**
   * Applied. Its geometry is now the authoritative part mesh.
   *
   * A TERMINAL STATE, DISTINCT FROM `Discarded` — Stage 4B-1B2. A candidate is
   * consumed by the commit that used it, and asking to apply it a second time
   * has to be refused with a sentence that says what actually happened. Folding
   * this into `Discarded` would tell a user their fill "was discarded" when it
   * had in fact been applied, which is the opposite of true.
   */
  Committed: 'committed',
  /** Released. Its geometry is gone and it can never be revived. */
  Discarded: 'discarded',
} as const;

export type HoleFillCandidateState =
  (typeof HoleFillCandidateState)[keyof typeof HoleFillCandidateState];

export interface HoleFillCandidateHandle {
  readonly candidateId: HoleFillCandidateId;
  readonly documentId: DocumentId;
  /**
   * The part this candidate proposes to replace.
   *
   * CARRIED ON THE HANDLE. Two parts of one document hold IDENTICAL document
   * handles, so a handle comparison alone cannot say which mesh a candidate
   * describes; without the part id a candidate computed from part A could be
   * applied to part B.
   */
  readonly partId: PartId;
  /** Revision the candidate was computed FROM. Re-checked before publication. */
  readonly sourceRevision: number;
  /** The boundary loop that was filled. Half of what makes it meaningful. */
  readonly boundaryLoopId: string;
  /**
   * Faces the SOURCE part had, which is where the patch begins.
   *
   * FROZEN PROVENANCE, carried on the handle rather than recomputed. Faces
   * `[0, sourceFaceCount)` are the user's and the rest is the patch, so this
   * one number is what lets the patch be previewed and the fill be reversed
   * without re-deriving either from geometry. Re-deriving it would mean two
   * answers to "where does the patch start", and they could disagree.
   */
  readonly sourceFaceCount: number;
  /** Increments whenever a candidate is built. Never reused. */
  readonly generation: number;
}

/** What a caller must STATE to apply a candidate. Nothing is read off the candidate. */
export interface HoleFillCommitRequest {
  readonly candidate: HoleFillCandidateHandle;
  /** The revision the caller believes is authoritative. Re-checked. */
  readonly expectedSource: DocumentHandle;
  /**
   * The part the caller believes it is replacing.
   *
   * STATED, NEVER READ OFF THE CANDIDATE. Reading it off the candidate would
   * compare the candidate with itself and the guard would be vacuous — the
   * document invariant Stage 4A-2A wrote down after getting it wrong once.
   */
  readonly expectedPart: PartId;
  /** The opening the caller believes it is closing. Re-checked for the same reason. */
  readonly expectedLoopId: string;
}

interface CandidateEntry {
  readonly handle: HoleFillCandidateHandle;
  mesh: CanonicalMesh | undefined;
  state: HoleFillCandidateState;
  readonly byteLength: number;
}

export interface HoleFillCandidateStats {
  readonly candidateCount: number;
  readonly totalBytes: number;
}

export class HoleFillCandidateStore {
  private readonly candidates = new Map<HoleFillCandidateId, CandidateEntry>();
  /** At most one live candidate per document — see `create`. */
  private readonly activeByDocument = new Map<DocumentId, HoleFillCandidateId>();
  private nextId = 1;
  private nextGeneration = 1;

  /**
   * Registers a validated candidate and supersedes any earlier one.
   *
   * ONE ACTIVE CANDIDATE PER DOCUMENT, not per part, for exactly the reason the
   * repair store gives: the document carries ONE revision, so any future commit
   * would move it and make every candidate built at the old revision stale,
   * including another part's. Keeping a second alive would retain a whole mesh
   * that could never be used.
   */
  public create(
    source: DocumentHandle,
    part: PartId,
    boundaryLoopId: string,
    mesh: CanonicalMesh,
    sourceFaceCount: number,
  ): HoleFillCandidateHandle {
    const previous = this.activeByDocument.get(source.documentId);
    if (previous !== undefined) this.discardById(previous);

    const candidateId = `hole-fill-candidate-${String(this.nextId)}` as HoleFillCandidateId;
    this.nextId += 1;
    const generation = this.nextGeneration;
    this.nextGeneration += 1;

    const handle: HoleFillCandidateHandle = {
      candidateId,
      documentId: source.documentId,
      partId: part,
      sourceRevision: source.revision,
      boundaryLoopId,
      sourceFaceCount,
      generation,
    };
    this.candidates.set(candidateId, {
      handle,
      mesh,
      state: HoleFillCandidateState.Resolved,
      byteLength: meshByteLength(mesh),
    });
    this.activeByDocument.set(source.documentId, candidateId);
    return handle;
  }

  public stateOf(handle: HoleFillCandidateHandle): HoleFillCandidateState | undefined {
    return this.candidates.get(handle.candidateId)?.state;
  }

  /**
   * The candidate's geometry, if it is still live.
   *
   * Returns `undefined` rather than throwing: Stage 4B-1B1 has no caller that
   * consumes it, and inventing an error taxonomy for a path nothing takes would
   * be designing the 4B-1B2 transaction here, one guess at a time.
   */
  public meshOf(handle: HoleFillCandidateHandle): CanonicalMesh | undefined {
    const entry = this.candidates.get(handle.candidateId);
    if (entry?.state !== HoleFillCandidateState.Resolved) return undefined;
    return entry.mesh;
  }

  /**
   * Resolves a commit request, applying every guard, or returns a typed refusal.
   *
   * THE ONLY DOOR TO APPLYING A FILL. Every check that decides whether proposed
   * geometry may become the user's model is here, in the authoritative worker,
   * behind a `MessagePort` — not in a component, not in a hook and not in a
   * service. A defect in the interface can waste work or show a wrong label; it
   * cannot commit a candidate this function refuses.
   *
   * WHAT IS CHECKED, and why each one is separate rather than folded together:
   *
   *   - the candidate EXISTS. A handle the page kept across a worker restart
   *     names nothing;
   *   - it has not been COMMITTED. Applying the same validated patch twice would
   *     produce a second revision from geometry that is already a successor,
   *     and would append the patch faces to a mesh that already carries them;
   *   - it has not been DISCARDED. A discarded candidate has released its
   *     geometry and must not be revivable;
   *   - it belongs to THIS DOCUMENT. A candidate from a file the user has since
   *     replaced describes a model that is no longer open;
   *   - it belongs to THIS PART. Two parts of one document carry identical
   *     document handles, so the part is half the identity — without this, a
   *     patch built for part A could become part B's geometry;
   *   - it closes THE LOOP THE CALLER NAMED. The weakest of the five to violate
   *     by accident and the easiest to get wrong in a UI that re-lists openings;
   *   - the model is still at the REVISION the candidate was computed from,
   *     both as the caller believes it and as this store actually holds it. Two
   *     independent readings, because a caller that has gone stale would
   *     otherwise pass its own stale belief as evidence.
   */
  public prepareCommit(
    request: HoleFillCommitRequest,
    currentRevision: number | undefined,
  ): CanonicalMesh | AppError {
    const entry = this.candidates.get(request.candidate.candidateId);
    if (entry === undefined) {
      return modelUnavailable('That fill preview is no longer available.', {
        candidateId: request.candidate.candidateId,
      });
    }

    if (entry.state === HoleFillCandidateState.Committed) {
      return invalidState('That fill has already been applied.', {
        candidateId: request.candidate.candidateId,
        state: entry.state,
      });
    }
    if (entry.state === HoleFillCandidateState.Discarded) {
      return invalidState('That fill preview was discarded and can no longer be applied.', {
        candidateId: request.candidate.candidateId,
        state: entry.state,
      });
    }

    if (entry.handle.documentId !== request.expectedSource.documentId) {
      return invalidState('That fill preview belongs to a different model.', {
        candidateId: request.candidate.candidateId,
        candidateDocumentId: entry.handle.documentId,
        requestedDocumentId: request.expectedSource.documentId,
      });
    }

    if (entry.handle.partId !== request.expectedPart) {
      return invalidState('That fill preview belongs to a different part of this model.', {
        candidateId: request.candidate.candidateId,
        candidatePartId: entry.handle.partId,
        requestedPartId: request.expectedPart,
      });
    }

    if (entry.handle.boundaryLoopId !== request.expectedLoopId) {
      return invalidState('That fill preview closes a different opening.', {
        candidateId: request.candidate.candidateId,
        candidateLoopId: entry.handle.boundaryLoopId,
        requestedLoopId: request.expectedLoopId,
      });
    }

    if (
      entry.handle.sourceRevision !== request.expectedSource.revision ||
      currentRevision !== entry.handle.sourceRevision
    ) {
      return modelUnavailable('The model changed after that fill preview was created.', {
        candidateId: request.candidate.candidateId,
        candidateSourceRevision: entry.handle.sourceRevision,
        requestedRevision: request.expectedSource.revision,
        currentRevision: currentRevision ?? -1,
      });
    }

    const mesh = entry.mesh;
    if (mesh === undefined) {
      return modelUnavailable('That fill preview no longer holds geometry.', {
        candidateId: request.candidate.candidateId,
      });
    }
    return mesh;
  }

  /**
   * Marks a candidate applied and releases its geometry reference.
   *
   * Called only AFTER the resident store accepted the swap, so a refused swap
   * leaves the candidate resolved and retryable rather than consumed — the same
   * ordering `RepairCandidateStore.markCommitted` requires, and for the same
   * reason: a transient race must not destroy a validated fill.
   */
  public markCommitted(handle: HoleFillCandidateHandle): void {
    const entry = this.candidates.get(handle.candidateId);
    if (entry === undefined) return;
    entry.state = HoleFillCandidateState.Committed;
    // The resident document owns the mesh now. A second reference here would
    // keep a whole part's geometry alive for something that can never be used
    // again.
    entry.mesh = undefined;
    this.activeByDocument.delete(entry.handle.documentId);
  }

  /**
   * Discards whatever candidate a document currently has.
   *
   * Called when the document is released or replaced. A candidate outlives its
   * usefulness the moment its source revision does — every guard above would
   * refuse it — so retaining a whole part's geometry for it is a leak with no
   * upside.
   */
  public releaseDocument(documentId: DocumentId): boolean {
    const candidateId = this.activeByDocument.get(documentId);
    if (candidateId === undefined) return false;
    return this.discardById(candidateId);
  }

  /**
   * Discards a candidate, releasing its geometry.
   *
   * IDEMPOTENT: discarding twice reports `false` for "something was released"
   * rather than erroring, because a user cancelling twice is not a fault.
   */
  public discard(handle: HoleFillCandidateHandle): boolean {
    return this.discardById(handle.candidateId);
  }

  private discardById(candidateId: HoleFillCandidateId): boolean {
    const entry = this.candidates.get(candidateId);
    if (entry === undefined) return false;
    const released = entry.state === HoleFillCandidateState.Resolved;
    if (released) {
      entry.state = HoleFillCandidateState.Discarded;
      entry.mesh = undefined;
      this.activeByDocument.delete(entry.handle.documentId);
    }
    return released;
  }

  /**
   * Releases everything.
   *
   * Called when the worker session ends. Policy A says authoritative geometry
   * does not survive worker loss, so a candidate certainly must not.
   */
  public releaseAll(): void {
    for (const entry of this.candidates.values()) {
      entry.mesh = undefined;
      entry.state = HoleFillCandidateState.Discarded;
    }
    this.candidates.clear();
    this.activeByDocument.clear();
  }

  public stats(): HoleFillCandidateStats {
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
