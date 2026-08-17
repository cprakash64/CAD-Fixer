import type { TopologyReport } from '@cadfixer/mesh-topology';
import type { ModelHandle, ModelId } from './resident-models';

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
 * (modelId, revision) describes exactly the mesh that handle resolves to, for as
 * long as that handle resolves at all. The revision is stored and compared, not
 * assumed — a report for revision 3 is never returned for revision 4.
 *
 * WHAT IT HOLDS. Counts, statuses and BOUNDED per-component summaries. Not
 * geometry, not samples, and not per-face arrays: `TopologyDetail` is
 * deliberately excluded, because it is the part that carries coordinates and the
 * part whose size depends on the sample cap rather than on being useful later.
 *
 * ONE ENTRY PER MODEL. Older revisions of the same model are dropped as soon as
 * a newer report arrives — nothing can ask for them, because their handles no
 * longer resolve.
 */

interface CachedReport {
  readonly revision: number;
  readonly report: TopologyReport;
}

export class TopologyReportCache {
  private readonly reports = new Map<ModelId, CachedReport>();

  /**
   * The report for exactly this handle, or `undefined`.
   *
   * Returns nothing rather than something close: a stale report is worse than no
   * report, because a caller that receives one has no way to tell.
   */
  public get(handle: ModelHandle): TopologyReport | undefined {
    const cached = this.reports.get(handle.modelId);
    if (cached?.revision !== handle.revision) return undefined;
    return cached.report;
  }

  public set(handle: ModelHandle, report: TopologyReport): void {
    this.reports.set(handle.modelId, { revision: handle.revision, report });
  }

  /** Drops a model's report. Used when the model itself is released. */
  public release(modelId: ModelId): void {
    this.reports.delete(modelId);
  }

  public releaseAll(): void {
    this.reports.clear();
  }

  public get size(): number {
    return this.reports.size;
  }
}
