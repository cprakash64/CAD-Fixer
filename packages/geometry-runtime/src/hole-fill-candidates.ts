import { meshByteLength } from '@cadfixer/mesh-core';
import type { CanonicalMesh, PartId } from '@cadfixer/mesh-core';
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
 */

declare const holeFillCandidateIdBrand: unique symbol;

export type HoleFillCandidateId = string & { readonly [holeFillCandidateIdBrand]: true };

export const HoleFillCandidateState = {
  /** Validated, resident, and available for a future preview or apply. */
  Resolved: 'resolved',
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
  /** Increments whenever a candidate is built. Never reused. */
  readonly generation: number;
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
