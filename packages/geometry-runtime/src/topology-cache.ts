import type { TopologyReport } from '@cadfixer/mesh-topology';
import type { PartId } from '@cadfixer/mesh-core';
import type { DocumentHandle, DocumentId } from './resident-documents';

/**
 * The most recent topology report per resident model.
 *
 * WHY THIS EXISTS. A repair is planned from a topology report, and the
 * application has almost always just computed one: analysis runs automatically
 * on import. Without this cache, opening the repair workflow re-analysed the
 * same unchanged mesh, and building a candidate analysed it a third time — three
 * full passes over a multi-million-triangle model to answer a question that was
 * already answered. The worker stays responsive either way, but spending a
 * user's battery to recompute an identical result is not a neutral cost.
 *
 * WHY IT IS SAFE. Geometry at a given revision is immutable: `replace` produces
 * a NEW revision rather than mutating in place, so a report stored against
 * (documentId, revision, partId) describes exactly the mesh that handle and part
 * resolve to, for as long as they resolve at all. The revision is stored and
 * compared, not assumed — a report for revision 3 is never returned for revision
 * 4, and a report for part A is never returned for part B.
 *
 * WHAT IT HOLDS. Counts, statuses and BOUNDED per-component summaries. Not
 * geometry, not samples, and not per-face arrays: `TopologyDetail` is
 * deliberately excluded, because it is the part that carries coordinates and the
 * part whose size depends on the sample cap rather than on being useful later.
 *
 * ONE ENTRY PER (DOCUMENT, PART). Analysis is per part: a document's parts are
 * separate meshes, and combining them into one topology report would invent
 * connectivity between things the file declared separate. Older revisions are
 * dropped as soon as a newer report arrives — nothing can ask for them, because
 * their handles no longer resolve.
 */

interface CachedReport {
  readonly revision: number;
  readonly report: TopologyReport;
}

/**
 * One entry per (document, part).
 *
 * The revision is stored INSIDE the entry rather than in the key, so a new
 * document revision cannot leave stale entries readable under old keys: every
 * lookup compares the revision it wanted with the revision that was stored.
 */
type PartReports = Map<PartId, CachedReport>;

export class TopologyReportCache {
  private readonly reports = new Map<DocumentId, PartReports>();

  /**
   * The report for exactly this handle, or `undefined`.
   *
   * Returns nothing rather than something close: a stale report is worse than no
   * report, because a caller that receives one has no way to tell.
   */
  public get(handle: DocumentHandle, part: PartId): TopologyReport | undefined {
    const cached = this.reports.get(handle.documentId)?.get(part);
    if (cached?.revision !== handle.revision) return undefined;
    return cached.report;
  }

  public set(handle: DocumentHandle, part: PartId, report: TopologyReport): void {
    let parts = this.reports.get(handle.documentId);
    if (parts === undefined) {
      parts = new Map<PartId, CachedReport>();
      this.reports.set(handle.documentId, parts);
    } else {
      /*
       * A NEW DOCUMENT REVISION DROPS EVERY PART'S REPORT. The document carries
       * one revision, so an edit to part A moves part B's handle on too and B's
       * stored report no longer describes anything reachable. `get` would refuse
       * it anyway; clearing here keeps the cache from holding reports nothing
       * can ever ask for again.
       */
      for (const cached of parts.values()) {
        if (cached.revision !== handle.revision) parts.clear();
        break;
      }
    }
    parts.set(part, { revision: handle.revision, report });
  }

  /** Drops a document's reports. Used when the document itself is released. */
  public release(documentId: DocumentId): void {
    this.reports.delete(documentId);
  }

  public releaseAll(): void {
    this.reports.clear();
  }

  /** Number of retained (document, part) reports. */
  public get size(): number {
    let total = 0;
    for (const parts of this.reports.values()) total += parts.size;
    return total;
  }
}
