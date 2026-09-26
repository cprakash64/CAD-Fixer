import { useCallback, useMemo } from 'react';
import { SelfIntersectionStatus } from '@cadfixer/mesh-self-intersection';
import {
  deriveHealthSummary,
  deriveRepairIssues,
  locateOccurrence,
  OccurrenceSource,
  type HealthSummary,
  type OccurrenceLocation,
  type RepairIssue,
  type RepairIssueId,
} from './repair-issues';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { useHoleFillControls } from './workflow-controllers';
import { analysisKey, HoleFillInventoryState, type WorkspaceState } from './workspace-store';

/**
 * The resolved state of the selected issue — what every surface shows.
 *
 * `occurrence` is the zero-based position in the navigable list, or
 * `undefined` when the issue has nothing to step through. `location` is known
 * only once its data exists: an opening's rim arrives from the worker a moment
 * after the opening is chosen.
 */
export interface ResolvedIssueSelection {
  readonly issue: RepairIssue;
  readonly occurrence: number | undefined;
  readonly location: OccurrenceLocation | undefined;
}

export interface IssueNavigation {
  readonly issues: readonly RepairIssue[];
  readonly summary: HealthSummary;
  readonly selection: ResolvedIssueSelection | undefined;
  readonly select: (issue: RepairIssueId) => void;
  /** Moves by `delta` occurrences, wrapping at either end. */
  readonly step: (delta: number) => void;
  readonly zoom: () => void;
  /** Clears the selection. Diagnostic data is untouched. */
  readonly dismiss: () => void;
}

/**
 * Issue list, health summary and the ONE selection, resolved from the store.
 *
 * Every surface calls this: the Mesh analysis list, the viewport HUD, the
 * inspector and the status bar. Derivation is cheap — counts and a handful of
 * typed-array reads for the one selected occurrence — so there is no second
 * cache to fall out of step.
 */
export function useIssueNavigation(): IssueNavigation {
  const state = useWorkspaceState();
  const store = useWorkspaceStore();
  const holeFill = useHoleFillControls();

  const sources = useMemo(() => currentSources(state), [state]);
  const issues = useMemo(() => deriveRepairIssues(sources.issues), [sources]);
  const summary = useMemo(() => deriveHealthSummary(issues), [issues]);

  const selection = useMemo(
    () => resolveSelection(state, sources, issues),
    [issues, sources, state],
  );

  const { selectOpening } = holeFill;
  const rows = sources.issues.boundaryRows;

  const select = useCallback(
    (id: RepairIssueId): void => {
      store.selectIssue(id, sources.key);
      const issue = issues.find((candidate) => candidate.id === id);
      if (issue?.occurrenceSource === OccurrenceSource.BoundaryLoops) {
        const first = rows?.[0];
        if (first !== undefined) selectOpening(first.boundaryLoopId);
      }
    },
    [issues, rows, selectOpening, sources.key, store],
  );

  const step = useCallback(
    (delta: number): void => {
      if (selection?.occurrence === undefined) return;
      const total = selection.issue.occurrenceCount;
      if (total < 2) return;
      const next = (((selection.occurrence + delta) % total) + total) % total;
      if (selection.issue.occurrenceSource === OccurrenceSource.BoundaryLoops) {
        const row = rows?.[next];
        if (row !== undefined) selectOpening(row.boundaryLoopId);
        return;
      }
      store.setIssueOccurrence(next);
    },
    [rows, selectOpening, selection, store],
  );

  const zoom = useCallback((): void => {
    const location = selection?.location;
    if (location === undefined || sources.key === undefined) return;
    store.requestFrame(sources.key, location.center, location.radius);
  }, [selection?.location, sources.key, store]);

  const dismiss = useCallback((): void => {
    store.selectIssue(undefined, undefined);
  }, [store]);

  return { issues, summary, selection, select, step, zoom, dismiss };
}

interface CurrentSources {
  readonly key: string | undefined;
  readonly issues: Parameters<typeof deriveRepairIssues>[0];
  readonly renderPositions: Float32Array | undefined;
  readonly rim: Float32Array | undefined;
  readonly selectedLoopId: string | undefined;
}

/**
 * Only what belongs to the model and part on screen.
 *
 * THE STALE-REPORT GUARD, applied to every input: a report, a self-intersection
 * result, an openings list and a rim each count only for the revision and part
 * they were computed from.
 */
function currentSources(state: WorkspaceState): CurrentSources {
  const { model, activePartId, analysis, selfIntersection, holeFill } = state;
  const key = analysisKey(model?.handle, activePartId);
  const matches = (
    handle: WorkspaceState['analysis']['handle'],
    partId: string | undefined,
  ): boolean => key !== undefined && analysisKey(handle, partId) === key;

  const analysisCurrent = matches(analysis.handle, analysis.partId);
  const selfCurrent =
    matches(selfIntersection.handle, selfIntersection.partId) &&
    (selfIntersection.report?.status === SelfIntersectionStatus.Checked ||
      selfIntersection.report?.status === SelfIntersectionStatus.Partial);
  const holeFillCurrent =
    matches(holeFill.handle, holeFill.partId) &&
    holeFill.inventory.state === HoleFillInventoryState.Ready;
  const rimCurrent =
    holeFill.rim !== undefined &&
    holeFill.rim.boundaryLoopId === holeFill.selectedLoopId &&
    matches(holeFill.rim.source, holeFill.rim.partId);

  return {
    key,
    issues: {
      report: analysisCurrent ? analysis.report : undefined,
      detail: analysisCurrent ? analysis.detail : undefined,
      selfIntersection: selfCurrent ? selfIntersection.report : undefined,
      boundaryRows: holeFillCurrent ? holeFill.inventory.rows : undefined,
    },
    renderPositions: model?.render.parts.find((part) => part.partId === activePartId)?.positions,
    rim: rimCurrent ? holeFill.rim.positions : undefined,
    selectedLoopId: holeFillCurrent ? holeFill.selectedLoopId : undefined,
  };
}

function resolveSelection(
  state: WorkspaceState,
  sources: CurrentSources,
  issues: readonly RepairIssue[],
): ResolvedIssueSelection | undefined {
  const chosen = state.issueSelection;
  if (chosen === undefined || chosen.key !== sources.key) return undefined;
  const issue = issues.find((candidate) => candidate.id === chosen.issue);
  if (issue === undefined) return undefined;

  let occurrence: number | undefined;
  if (issue.occurrenceCount > 0) {
    if (issue.occurrenceSource === OccurrenceSource.BoundaryLoops) {
      const index =
        sources.issues.boundaryRows?.findIndex(
          (row) => row.boundaryLoopId === sources.selectedLoopId,
        ) ?? -1;
      occurrence = index >= 0 ? index : undefined;
    } else {
      occurrence = Math.min(chosen.occurrence, issue.occurrenceCount - 1);
    }
  }

  const location =
    occurrence === undefined
      ? undefined
      : locateOccurrence(issue, occurrence, {
          detail: sources.issues.detail,
          renderPositions: sources.renderPositions,
          selfIntersection: sources.issues.selfIntersection,
          rim: sources.rim,
        });

  return { issue, occurrence, location };
}
