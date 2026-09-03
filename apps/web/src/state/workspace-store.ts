import type {
  ConservativeRepairPlan,
  MeshBounds,
  ModelHandle,
  RenderSnapshot,
  RepairCandidateHandle,
  RepairChangeCounts,
  RepairChangeSamples,
  RepairOperation,
  RepairValidation,
  TopologyDetail,
  TopologyReport,
} from '@cadfixer/geometry-runtime';
import type { WorkflowId } from './workflows';
import {
  SelfIntersectionBand,
  SelfIntersectionPhase,
  bandForFaceCount,
  type SelfIntersectionReport,
  type SelfIntersectionStatus,
} from '@cadfixer/mesh-self-intersection';
import type { LoadedModel } from './model';

/**
 * Application/workspace state.
 *
 * Deliberately framework-free: a plain observable with an immutable snapshot,
 * consumed by React through `useSyncExternalStore`. Keeping it independent of
 * React means the state layer can be unit-tested without a DOM, and that the
 * eventual document model (loaded mesh, undo stack, operation history) does not
 * become entangled with component lifecycles.
 *
 * No third-party state library is used. The surface is small enough that a
 * dependency would not earn its place — see docs/DEPENDENCIES.md.
 */

export const StatusSeverity = {
  Info: 'info',
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const;

export type StatusSeverity = (typeof StatusSeverity)[keyof typeof StatusSeverity];

export interface StatusEntry {
  readonly id: number;
  readonly severity: StatusSeverity;
  readonly message: string;
  readonly at: number;
}

export const SelfTestState = {
  Idle: 'idle',
  Running: 'running',
  Passed: 'passed',
  Failed: 'failed',
} as const;

export type SelfTestState = (typeof SelfTestState)[keyof typeof SelfTestState];

export interface RuntimeState {
  readonly selfTest: SelfTestState;
  /** 0..1, meaningful only while `selfTest` is `running`. */
  readonly progress: number;
  readonly detail?: string;
}

export const ImportState = {
  Idle: 'idle',
  Screening: 'screening',
  Reading: 'reading',
  Parsing: 'parsing',
  Validating: 'validating',
  Ready: 'ready',
  Error: 'error',
} as const;

export type ImportState = (typeof ImportState)[keyof typeof ImportState];

declare const importTokenBrand: unique symbol;

/**
 * Identifies one import attempt. Branded so a plain number cannot be passed
 * where a token is required.
 */
export type ImportToken = number & { readonly [importTokenBrand]: true };

export interface ImportProgressState {
  readonly state: ImportState;
  /** 0..1 across the whole import. */
  readonly fraction: number;
  /** Name of the file currently being imported, for the progress label. */
  readonly fileName?: string;
  readonly note?: string;
}

export const ExportState = {
  Idle: 'idle',
  Working: 'working',
} as const;

export type ExportState = (typeof ExportState)[keyof typeof ExportState];

declare const exportTokenBrand: unique symbol;

/** Identifies one export attempt, for the same reason imports have tokens. */
export type ExportToken = number & { readonly [exportTokenBrand]: true };

export interface ExportProgressState {
  readonly state: ExportState;
  /** 0..1, meaningful only while `state` is `working`. */
  readonly fraction: number;
  readonly encoding?: string;
}

export const AnalysisState = {
  /** No model is loaded, so there is nothing to analyse. */
  Unavailable: 'unavailable',
  /** A model is loaded and analysis has not run for it yet. */
  Idle: 'idle',
  Analyzing: 'analyzing',
  Ready: 'ready',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type AnalysisState = (typeof AnalysisState)[keyof typeof AnalysisState];

declare const analysisTokenBrand: unique symbol;

/** Identifies one analysis attempt, for the same reason imports have tokens. */
export type AnalysisToken = number & { readonly [analysisTokenBrand]: true };

export interface AnalysisFailure {
  readonly message: string;
  readonly code: string;
  /**
   * Whether offering "try again" makes sense.
   *
   * A resource-limit refusal will refuse identically next time, so a retry
   * button there would be a button that does nothing. A cancelled or
   * transiently-failed analysis is worth retrying.
   */
  readonly retryable: boolean;
}

/**
 * Topology analysis, always bound to the model handle it describes.
 *
 * `handle` is the load-bearing field. Analysis is asynchronous and a user can
 * import a second file while the first is still being analysed, so "which model
 * is this report about?" cannot be answered by timing. Every write is checked
 * against the model currently loaded, and a report for revision M0 is discarded
 * rather than shown beside M1's geometry.
 */
export interface AnalysisSnapshot {
  readonly state: AnalysisState;
  /** The model this state describes. `undefined` only when unavailable. */
  readonly handle: ModelHandle | undefined;
  /** 0..1, meaningful only while `state` is `analyzing`. */
  readonly fraction: number;
  /** Already translated for display by the analysis service. */
  readonly phase: string | undefined;
  /**
   * The last COMPLETE report for `handle`.
   *
   * Deliberately survives the start of a re-analysis: a user who re-runs
   * analysis should keep seeing the previous answer until a new one exists,
   * rather than watching the panel empty itself. Cleared when the model changes.
   */
  readonly report: TopologyReport | undefined;
  readonly detail: TopologyDetail | undefined;
  readonly error: AnalysisFailure | undefined;
  readonly durationMs: number | undefined;
}

/* ------------------------------------------------ self-intersection slice -- */

declare const selfIntersectionTokenBrand: unique symbol;
export type SelfIntersectionToken = number & {
  readonly [selfIntersectionTokenBrand]: true;
};

/**
 * The self-intersection slice.
 *
 * PHASE AND STATUS ARE SEPARATE FIELDS, and that separation is the point. A
 * `SelfIntersectionStatus` describes how a check ENDED; a phase describes
 * whether one is running at all. Folding "never asked" or "in progress" into
 * the status enum is precisely how an interface ends up implying a verdict it
 * does not have — five of the six statuses carry a zero intersection count.
 *
 * The band is stored rather than recomputed at render time so the panel and the
 * scheduler cannot disagree about which policy applies to the current model.
 */
export interface SelfIntersectionSnapshot {
  readonly phase: SelfIntersectionPhase;
  readonly band: SelfIntersectionBand;
  /** The model this state describes. `undefined` when nothing is loaded. */
  readonly handle: ModelHandle | undefined;
  /** Faces examined so far, reported by the worker. Scalar only. */
  readonly faceCount: number | undefined;
  /**
   * The last terminal report for `handle`.
   *
   * Cleared the moment the model changes: a "None found" belonging to the
   * previous revision must never sit beside new geometry.
   */
  readonly report: SelfIntersectionReport | undefined;
  readonly error: string | undefined;
  /** True once an automatic check has been scheduled for this exact handle. */
  readonly autoScheduled: boolean;
}

const EMPTY_SELF_INTERSECTION: SelfIntersectionSnapshot = {
  phase: SelfIntersectionPhase.Idle,
  band: SelfIntersectionBand.AutoEligible,
  handle: undefined,
  faceCount: undefined,
  report: undefined,
  error: undefined,
  autoScheduled: false,
};

const EMPTY_ANALYSIS: AnalysisSnapshot = {
  state: AnalysisState.Unavailable,
  handle: undefined,
  fraction: 0,
  phase: undefined,
  report: undefined,
  detail: undefined,
  error: undefined,
  durationMs: undefined,
};

/**
 * Which diagnostic overlays the viewport should draw.
 *
 * View state, but held in the workspace store rather than in a component
 * because two separate subtrees need it: the Mesh Health panel owns the
 * toggles and the viewport owns the GPU buffers. Threading it through props
 * would couple the panel to the viewport's position in the tree.
 *
 * All default to off. Drawing 50,000 boundary edges over a model the instant it
 * loads would bury the geometry the user actually wants to look at.
 */
export interface OverlayVisibility {
  readonly boundaryEdges: boolean;
  readonly nonManifoldEdges: boolean;
  readonly windingConflictEdges: boolean;
  readonly degenerateFaces: boolean;
}

export type OverlayId = keyof OverlayVisibility;

const OVERLAYS_HIDDEN: OverlayVisibility = {
  boundaryEdges: false,
  nonManifoldEdges: false,
  windingConflictEdges: false,
  degenerateFaces: false,
};

/* ------------------------------------------------ conservative repair -- */

export const RepairPlanState = {
  /** No model, or no applicable topology report to plan from. */
  Unavailable: 'unavailable',
  Planning: 'planning',
  Ready: 'ready',
  Failed: 'failed',
} as const;

export type RepairPlanState = (typeof RepairPlanState)[keyof typeof RepairPlanState];

export const RepairCandidateState = {
  Idle: 'idle',
  Building: 'building',
  /**
   * Cancel has been signalled; the worker has not yet acknowledged unwinding.
   *
   * A REAL STATE, not a cosmetic one. The shared flag is set immediately, but
   * the worker is still inside a batch and still owns partially-built scratch
   * memory. Showing "Cancelled" at this point would claim the work had stopped
   * while it demonstrably had not, and would invite a retry that races the
   * operation still unwinding. See Stage 3B-1C.
   */
  Cancelling: 'cancelling',
  /** Built AND accepted by validation. The only state that may be applied. */
  Ready: 'ready',
  Failed: 'failed',
  /** The worker acknowledged: nothing was published, nothing is resident. */
  Cancelled: 'cancelled',
} as const;

export type RepairCandidateState = (typeof RepairCandidateState)[keyof typeof RepairCandidateState];

export const RepairCommitState = {
  Idle: 'idle',
  Applying: 'applying',
  Undoing: 'undoing',
} as const;

export type RepairCommitState = (typeof RepairCommitState)[keyof typeof RepairCommitState];

/**
 * Which geometry the viewport is showing while a candidate exists.
 *
 * A VIEW SETTING AND NOTHING MORE. `After` never makes the candidate
 * authoritative — the model the worker holds is unchanged until commit — and the
 * interface says so on screen whenever this is `After`.
 */
export const RepairPreviewMode = {
  Before: 'before',
  After: 'after',
} as const;

export type RepairPreviewMode = (typeof RepairPreviewMode)[keyof typeof RepairPreviewMode];

export interface RepairFailure {
  readonly message: string;
  readonly code: string;
  /** Whether returning to the selection and trying again could plausibly help. */
  readonly retryable: boolean;
}

declare const repairTokenBrand: unique symbol;

/**
 * Identifies one repair attempt — plan or candidate.
 *
 * Same reason imports and analyses have tokens: two attempts can be in flight
 * when a user changes their selection mid-plan, and results can arrive in either
 * order. Without an identity per attempt, a superseded plan would overwrite a
 * newer one and the checkboxes would stop matching the plan beside them.
 */
export type RepairToken = number & { readonly [repairTokenBrand]: true };

/**
 * A validated candidate, as the workspace holds it.
 *
 * WHAT IS DELIBERATELY ABSENT: the candidate's `CanonicalMesh`. It stays
 * worker-resident exactly as the authoritative model's does. `render` is a
 * display-only snapshot, and `candidate` is a handle the UI can name but cannot
 * export — `RepairCandidateHandle` is a distinct type from `ModelHandle`, so the
 * compiler refuses to let a candidate reach an operation that takes a model.
 */
export interface RepairPreview {
  readonly candidate: RepairCandidateHandle;
  readonly source: ModelHandle;
  readonly planHash: string;
  readonly validation: RepairValidation;
  readonly counts: RepairChangeCounts;
  readonly samples: RepairChangeSamples;
  readonly render: RenderSnapshot | undefined;
  readonly bounds: MeshBounds | undefined;
  readonly inverseBytes: number;
}

/** A repair that has actually been applied, and what it takes to reverse it. */
export interface AppliedRepair {
  readonly recordId: string;
  /** The revision the repair produced. */
  readonly handle: ModelHandle;
  readonly parentRevision: number;
  readonly appliedOperations: readonly RepairOperation[];
  readonly counts: RepairChangeCounts;
  readonly undoable: boolean;
}

/**
 * Which change overlays the viewport should draw over a preview.
 *
 * SEPARATE FROM `OverlayVisibility`, which describes diagnostics of the loaded
 * model. These describe a proposal, they are bounded by the engine's sample cap
 * rather than by mesh size, and they default ON: a user who asked to preview a
 * repair asked to see what it changes. Diagnostics default off for the opposite
 * reason — fifty thousand boundary edges would bury the model.
 */
export interface ChangeOverlayVisibility {
  readonly removedDuplicates: boolean;
  readonly removedRepeatedPosition: boolean;
  readonly removedZeroArea: boolean;
  readonly flippedFaces: boolean;
}

export type ChangeOverlayId = keyof ChangeOverlayVisibility;

const CHANGE_OVERLAYS_SHOWN: ChangeOverlayVisibility = {
  removedDuplicates: true,
  removedRepeatedPosition: true,
  removedZeroArea: true,
  flippedFaces: true,
};

export interface RepairSnapshot {
  /** The model the plan and candidate belong to. Checked on every write. */
  readonly handle: ModelHandle | undefined;
  readonly planState: RepairPlanState;
  readonly plan: ConservativeRepairPlan | undefined;
  readonly planError: RepairFailure | undefined;
  /** Operations the user has selected. Never wider than what the plan allows. */
  readonly selection: readonly RepairOperation[];
  readonly candidateState: RepairCandidateState;
  readonly candidate: RepairPreview | undefined;
  readonly candidateError: RepairFailure | undefined;
  /** 0..1, meaningful while planning, building, applying or undoing. */
  readonly fraction: number;
  readonly phase: string | undefined;
  readonly previewMode: RepairPreviewMode;
  readonly changeOverlays: ChangeOverlayVisibility;
  readonly commitState: RepairCommitState;
  readonly commitError: RepairFailure | undefined;
  /** The most recent applied repair for the loaded model, if any. */
  readonly lastApplied: AppliedRepair | undefined;
}

/**
 * The default operation selection.
 *
 * ALL FOUR, because all four are conservative by construction: each is decidable
 * exactly from the stored coordinates, each refuses itself when it cannot be
 * safe, and none of them can run without appearing in the plan the user sees
 * first. Selecting them by default is not "repair everything" — the plan still
 * refuses whatever it must, and nothing runs until Preview is pressed.
 * See docs/repair/REPAIR_POLICY.md.
 */
export const DEFAULT_REPAIR_SELECTION: readonly RepairOperation[] = Object.freeze([
  'remove-duplicate-faces',
  'remove-repeated-position-faces',
  'remove-zero-area-faces',
  'unify-winding',
]);

const EMPTY_REPAIR: RepairSnapshot = {
  handle: undefined,
  planState: RepairPlanState.Unavailable,
  plan: undefined,
  planError: undefined,
  selection: DEFAULT_REPAIR_SELECTION,
  candidateState: RepairCandidateState.Idle,
  candidate: undefined,
  candidateError: undefined,
  fraction: 0,
  phase: undefined,
  previewMode: RepairPreviewMode.Before,
  changeOverlays: CHANGE_OVERLAYS_SHOWN,
  commitState: RepairCommitState.Idle,
  commitError: undefined,
  lastApplied: undefined,
};

export interface WorkspaceState {
  /** `undefined` means no workflow is open. No workflow can be opened yet. */
  readonly selectedWorkflow: WorkflowId | undefined;
  /**
   * The currently loaded model, or `undefined` when the workspace is empty.
   *
   * Replaced only by a SUCCESSFUL import. A failed or cancelled import leaves
   * whatever was already loaded untouched — losing the user's model because the
   * next file turned out to be broken would be its own kind of data loss.
   */
  readonly model: LoadedModel | undefined;
  readonly importProgress: ImportProgressState;
  readonly exportProgress: ExportProgressState;
  /** Topology diagnostics for `model`, or the unavailable state when empty. */
  readonly analysis: AnalysisSnapshot;
  readonly selfIntersection: SelfIntersectionSnapshot;
  /** Conservative repair for `model`, or the unavailable state when empty. */
  readonly repair: RepairSnapshot;
  readonly overlays: OverlayVisibility;
  readonly status: readonly StatusEntry[];
  readonly runtime: RuntimeState;
  /**
   * Set when the 3D viewport could not start or lost its context.
   *
   * Held here rather than in component state because it is workspace status,
   * not view-local UI state: the shell may surface it in more than one place,
   * and it must survive the viewport component remounting.
   */
  readonly viewportFailure: string | undefined;
  /**
   * Set when the geometry worker died, taking every resident model with it.
   *
   * POLICY A — the model is CLEARED, not left on screen. The worker held the
   * only copy of the authoritative geometry, so keeping a render snapshot
   * visible would show something no operation could act on: export would fail,
   * diagnostics would fail, and the picture would imply a working session that
   * does not exist. Showing nothing and saying why is less misleading.
   */
  readonly geometrySessionLost: string | undefined;
}

/** Bounded so a chatty session cannot grow the log without limit. */
const MAX_STATUS_ENTRIES = 50;

const INITIAL_STATE: WorkspaceState = {
  selectedWorkflow: undefined,
  model: undefined,
  importProgress: { state: ImportState.Idle, fraction: 0 },
  exportProgress: { state: ExportState.Idle, fraction: 0 },
  analysis: EMPTY_ANALYSIS,
  selfIntersection: EMPTY_SELF_INTERSECTION,
  repair: EMPTY_REPAIR,
  overlays: OVERLAYS_HIDDEN,
  status: [],
  runtime: { selfTest: SelfTestState.Idle, progress: 0 },
  viewportFailure: undefined,
  geometrySessionLost: undefined,
};

export class WorkspaceStore {
  private state: WorkspaceState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private nextStatusId = 1;
  private nextModelRevision = 1;
  private nextImportToken = 1;
  private currentImportToken: ImportToken | undefined;
  private nextExportToken = 1;
  private currentExportToken: ExportToken | undefined;
  private nextAnalysisToken = 1;
  private currentAnalysisToken: AnalysisToken | undefined;
  private nextRepairToken = 1;
  private currentRepairToken: RepairToken | undefined;

  public getSnapshot = (): WorkspaceState => this.state;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public selectWorkflow(workflow: WorkflowId | undefined): void {
    this.update({ selectedWorkflow: workflow });
  }

  public pushStatus(severity: StatusSeverity, message: string): void {
    const entry: StatusEntry = {
      id: this.nextStatusId,
      severity,
      message,
      at: Date.now(),
    };
    this.nextStatusId += 1;
    const status = [entry, ...this.state.status].slice(0, MAX_STATUS_ENTRIES);
    this.update({ status });
  }

  public clearStatus(): void {
    this.update({ status: [] });
  }

  public setRuntime(runtime: RuntimeState): void {
    this.update({ runtime });
  }

  public setViewportFailure(message: string | undefined): void {
    if (this.state.viewportFailure === message) return;
    this.update({ viewportFailure: message });
  }

  /**
   * Claims the import slot and returns the token that identifies this attempt.
   *
   * WHY A TOKEN. Two imports can be in flight at once — the user drops a second
   * file while the first is still parsing — and the results can arrive in
   * either order. A small file started second can easily finish before a large
   * file started first. Without an identity per attempt, the late result of a
   * superseded import would overwrite the newer model, and the user would be
   * looking at geometry that does not match the filename beside it.
   *
   * A boolean "importing" flag cannot express this: by the time the stale
   * result arrives the flag is true again, for a different import. The token is
   * monotonic, so "is this still the current attempt?" is answerable without
   * any reference to timing.
   */
  public beginImport(fileName: string): ImportToken {
    const token = this.nextImportToken as ImportToken;
    this.nextImportToken += 1;
    this.currentImportToken = token;
    this.update({
      importProgress: { state: ImportState.Screening, fraction: 0, fileName },
    });
    return token;
  }

  /** True while `token` is the most recently started import. */
  public isCurrentImport(token: ImportToken): boolean {
    return this.currentImportToken === token;
  }

  /** Progress from a superseded import is discarded rather than displayed. */
  public reportImportProgress(token: ImportToken, progress: ImportProgressState): void {
    if (!this.isCurrentImport(token)) return;
    this.update({ importProgress: progress });
  }

  /**
   * Installs a model, but only if `token` is still the current import.
   *
   * Returns whether the model was installed, so the caller can tell a genuine
   * commit from a discarded stale result.
   */
  public commitImport(token: ImportToken, model: Omit<LoadedModel, 'revision'>): boolean {
    if (!this.isCurrentImport(token)) return false;
    this.currentImportToken = undefined;

    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;

    // A new model invalidates the previous model's diagnostics completely. The
    // in-flight analysis token is dropped so a report for the model being
    // replaced cannot install itself against the replacement, and the report
    // itself goes rather than lingering beside different geometry.
    this.currentAnalysisToken = undefined;
    // And it invalidates the previous model's repair entirely: a plan, a
    // candidate, a preview and an undo record all name geometry the user has
    // just replaced. The candidate's worker-side release is the caller's
    // responsibility — see `useConservativeRepair`.
    this.currentRepairToken = undefined;
    // And any in-flight self-intersection check: its answer describes the model
    // being replaced, so it must not land on the replacement.
    this.currentSelfIntersectionToken = undefined;

    this.update({
      model: { ...model, revision },
      importProgress: { state: ImportState.Ready, fraction: 1 },
      analysis: {
        ...EMPTY_ANALYSIS,
        state: AnalysisState.Idle,
        handle: model.handle,
      },
      repair: { ...EMPTY_REPAIR, handle: model.handle },
      /*
       * The new model's size decides its own policy. A small model becomes
       * eligible for an automatic check; a large one is refused before anything
       * is allocated. Nothing is carried over from the previous model.
       */
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: model.handle,
        band: bandForFaceCount(model.triangleCount),
      },
      // A successful import means a live worker, so any previous loss notice is
      // stale and must go.
      geometrySessionLost: undefined,
    });
    return true;
  }

  /* ------------------------------------------- conservative repair -- */

  /**
   * Claims the repair slot for `handle` and returns the token for this attempt.
   *
   * One token stream covers planning AND candidate creation, because they are
   * one user-visible operation with two phases. A candidate built for a plan the
   * user has since changed must not install itself, and a single monotonic token
   * answers that without any reference to timing.
   */
  public beginRepairPlan(handle: ModelHandle, selection: readonly RepairOperation[]): RepairToken {
    const token = this.nextRepairToken as RepairToken;
    this.nextRepairToken += 1;
    this.currentRepairToken = token;

    const repair = this.state.repair;
    this.update({
      repair: {
        ...repair,
        handle,
        planState: RepairPlanState.Planning,
        planError: undefined,
        selection,
        fraction: 0,
        phase: undefined,
        // A new plan invalidates any candidate built from the previous one. The
        // handle is kept in `candidate` until the caller releases it, so this
        // clears the state rather than the worker's memory.
        candidateState: RepairCandidateState.Idle,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
      },
    });
    return token;
  }

  /* ------------------------------------------ self-intersection slice -- */

  private nextSelfIntersectionToken = 1;
  private currentSelfIntersectionToken: SelfIntersectionToken | undefined;

  public isCurrentSelfIntersection(token: SelfIntersectionToken): boolean {
    return this.currentSelfIntersectionToken === token;
  }

  /**
   * Re-derives the slice for a newly authoritative model.
   *
   * CALLED ON EVERY REVISION CHANGE — import, replacement, repair apply, undo.
   * The previous report is DROPPED rather than carried forward: it describes
   * geometry that no longer exists, and leaving a "None found" on screen beside
   * a model it was never computed for is the single most damaging thing this
   * slice could do.
   */
  public resetSelfIntersectionFor(handle: ModelHandle | undefined, faceCount: number): void {
    this.currentSelfIntersectionToken = undefined;
    this.update({
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle,
        band:
          handle === undefined ? SelfIntersectionBand.AutoEligible : bandForFaceCount(faceCount),
      },
    });
  }

  /**
   * Claims the slice for a new check. Returns `undefined` when the model's size
   * band forbids running one at all.
   */
  public beginSelfIntersection(
    handle: ModelHandle,
    auto: boolean,
  ): SelfIntersectionToken | undefined {
    const current = this.state.selfIntersection;
    if (!sameHandle(current.handle, handle)) return undefined;
    if (current.band === SelfIntersectionBand.SizeLimit) return undefined;
    if (auto && current.autoScheduled) return undefined;

    const token = this.nextSelfIntersectionToken as SelfIntersectionToken;
    this.nextSelfIntersectionToken += 1;
    this.currentSelfIntersectionToken = token;
    this.update({
      selfIntersection: {
        ...current,
        phase: SelfIntersectionPhase.Scheduled,
        report: undefined,
        error: undefined,
        faceCount: undefined,
        autoScheduled: current.autoScheduled || auto,
      },
    });
    return token;
  }

  public reportSelfIntersectionStarted(token: SelfIntersectionToken, faceCount: number): void {
    if (!this.isCurrentSelfIntersection(token)) return;
    this.update({
      selfIntersection: {
        ...this.state.selfIntersection,
        phase: SelfIntersectionPhase.Running,
        faceCount,
      },
    });
  }

  public beginSelfIntersectionCancellation(token: SelfIntersectionToken): boolean {
    if (!this.isCurrentSelfIntersection(token)) return false;
    if (
      this.state.selfIntersection.phase !== SelfIntersectionPhase.Running &&
      this.state.selfIntersection.phase !== SelfIntersectionPhase.Scheduled
    ) {
      return false;
    }
    this.update({
      selfIntersection: {
        ...this.state.selfIntersection,
        phase: SelfIntersectionPhase.Cancelling,
      },
    });
    return true;
  }

  /**
   * Publishes a terminal report.
   *
   * GUARDED TWICE, by token AND by handle. A diagnostic that was in flight when
   * the model changed must not land on the replacement: its answer describes
   * different geometry, and by the time it arrives nothing else distinguishes
   * the two.
   */
  public completeSelfIntersection(
    token: SelfIntersectionToken,
    report: SelfIntersectionReport,
  ): boolean {
    if (!this.isCurrentSelfIntersection(token)) return false;
    const current = this.state.selfIntersection;
    if (current.handle === undefined) return false;
    if (
      current.handle.modelId !== report.modelId ||
      current.handle.revision !== report.modelRevision
    ) {
      return false;
    }
    this.currentSelfIntersectionToken = undefined;
    this.update({
      selfIntersection: {
        ...current,
        phase: SelfIntersectionPhase.Complete,
        report,
        error: undefined,
      },
    });
    return true;
  }

  /** Publishes a terminal status that carries no report — cancellation, failure. */
  public failSelfIntersection(
    token: SelfIntersectionToken,
    status: SelfIntersectionStatus,
    message: string,
  ): boolean {
    if (!this.isCurrentSelfIntersection(token)) return false;
    const current = this.state.selfIntersection;
    if (current.handle === undefined) return false;
    this.currentSelfIntersectionToken = undefined;
    this.update({
      selfIntersection: {
        ...current,
        phase: SelfIntersectionPhase.Complete,
        report: {
          schemaVersion: 1,
          status,
          modelId: current.handle.modelId,
          modelRevision: current.handle.revision,
          faceCount: current.faceCount ?? 0,
          intersectingPairCount: 0,
          affectedFaceCount: 0,
          categories: {
            properCrossing: 0,
            coplanarOverlap: 0,
            nonAdjacentPointTouch: 0,
            nonAdjacentEdgeTouch: 0,
            adjacentOverlapBeyondShared: 0,
            duplicateTopologyDefect: 0,
            legitimateShared: 0,
          },
          skippedDegenerateFaceCount: 0,
          skippedPairCount: 0,
          unclassifiedPairCount: 0,
          candidatePairCount: 0,
          testedPairCount: 0,
          samples: new Uint32Array(0),
          samplePairCount: 0,
          samplesTruncated: false,
          engine: { name: 'geogram', version: 'v1.10.0', commit: 'c8529bb' },
        },
        error: message,
      },
    });
    return true;
  }

  public isCurrentRepair(token: RepairToken): boolean {
    return this.currentRepairToken === token;
  }

  public reportRepairProgress(token: RepairToken, fraction: number, phase: string): void {
    if (!this.isCurrentRepair(token)) return;
    const repair = this.state.repair;
    // Coalesced at the source, exactly as analysis progress is: a worker phase
    // can emit many updates per second and re-rendering for a fraction that
    // rounds to the same displayed percent is work nobody sees.
    if (
      repair.phase === phase &&
      Math.round(repair.fraction * 100) === Math.round(fraction * 100)
    ) {
      return;
    }
    this.update({ repair: { ...repair, fraction, phase } });
  }

  /**
   * Installs a plan, but only for the model that is actually loaded.
   *
   * TWO GATES, as everywhere else in this store. The token rejects a superseded
   * attempt; the handle comparison rejects a plan whose model is no longer
   * current even if the token somehow survived.
   */
  public commitRepairPlan(
    token: RepairToken,
    handle: ModelHandle,
    plan: ConservativeRepairPlan,
  ): boolean {
    if (!this.isCurrentRepair(token)) return false;
    if (!sameHandle(this.state.model?.handle, handle)) return false;

    this.update({
      repair: {
        ...this.state.repair,
        handle,
        planState: RepairPlanState.Ready,
        plan,
        planError: undefined,
        fraction: 1,
        phase: undefined,
      },
    });
    return true;
  }

  public failRepairPlan(token: RepairToken, error: RepairFailure): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.currentRepairToken = undefined;
    this.update({
      repair: {
        ...this.state.repair,
        planState: RepairPlanState.Failed,
        planError: error,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Records that no plan can be produced yet.
   *
   * Distinct from a failure: there is nothing wrong, the prerequisite simply is
   * not there. Repair needs a topology report for the CURRENT revision, and
   * while analysis is running, cancelled or failed there is nothing honest to
   * plan from.
   */
  public setRepairUnavailable(handle: ModelHandle | undefined): void {
    this.currentRepairToken = undefined;
    this.update({
      repair: {
        ...EMPTY_REPAIR,
        handle,
        selection: this.state.repair.selection,
        lastApplied: this.state.repair.lastApplied,
      },
    });
  }

  /**
   * Changes which operations the user wants attempted.
   *
   * The plan is marked stale rather than edited: which operations are applicable
   * depends on which others run first — duplicates are removed before winding is
   * solved — so a selection change requires the engine to decide again. Editing
   * the existing plan in place would show the user a plan that does not match
   * what a repair would do.
   */
  public setRepairSelection(selection: readonly RepairOperation[]): void {
    const repair = this.state.repair;
    this.currentRepairToken = undefined;
    this.update({
      repair: {
        ...repair,
        selection: [...selection],
        // THE PLAN IS KEPT ON SCREEN while the new one computes, for the same
        // reason a re-run of analysis keeps the previous report: blanking the
        // decision list on every checkbox click makes the panel lose its place,
        // and it takes the focused control out of the document underneath a
        // keyboard user. `planState` says it is being recomputed, and the
        // Preview button is withheld until the new plan lands — so nothing can
        // be built from decisions that no longer match the selection.
        planState: RepairPlanState.Planning,
        planError: undefined,
        candidateState: RepairCandidateState.Idle,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
  }

  /**
   * Claims a fresh token for building a candidate, keeping the plan on screen.
   *
   * Separate from `beginRepairPlan` because previewing does NOT re-plan: the
   * user is asking for the plan they can already see to be built. Reusing the
   * planning entry point would blank the decision list and then restore it,
   * which reads as the panel losing its place.
   *
   * Returns `undefined` when there is no plan to build, so a stray click cannot
   * start a candidate for nothing.
   */
  public beginRepairPreview(): RepairToken | undefined {
    const repair = this.state.repair;
    if (repair.planState !== RepairPlanState.Ready || repair.plan === undefined) return undefined;
    if (repair.plan.noOp) return undefined;

    const token = this.nextRepairToken as RepairToken;
    this.nextRepairToken += 1;
    this.currentRepairToken = token;
    return token;
  }

  public beginRepairCandidate(token: RepairToken): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Building,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Installs a validated candidate.
   *
   * Only an ACCEPTED candidate reaches here — the service refuses anything else —
   * and the handle is still re-checked, because a candidate for a model that has
   * been replaced describes geometry the user is no longer looking at.
   *
   * The preview opens on AFTER: the user pressed Preview to see the proposal,
   * and the label above the viewport says it is not applied.
   */
  public commitRepairCandidate(token: RepairToken, preview: RepairPreview): boolean {
    if (!this.isCurrentRepair(token)) return false;
    if (!sameHandle(this.state.model?.handle, preview.source)) return false;

    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Ready,
        candidate: preview,
        candidateError: undefined,
        previewMode:
          preview.render === undefined ? RepairPreviewMode.Before : RepairPreviewMode.After,
        changeOverlays: CHANGE_OVERLAYS_SHOWN,
        fraction: 1,
        phase: undefined,
      },
    });
    return true;
  }

  public failRepairCandidate(token: RepairToken, error: RepairFailure): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Failed,
        candidate: undefined,
        candidateError: error,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Records that cancellation has been SIGNALLED but not yet acknowledged.
   *
   * Returns false when there is nothing running to cancel, so a stray click
   * cannot put the panel into a transitional state it can never leave.
   */
  public beginRepairCancellation(token: RepairToken): boolean {
    if (!this.isCurrentRepair(token)) return false;
    const repair = this.state.repair;
    if (repair.candidateState !== RepairCandidateState.Building) return false;
    this.update({
      repair: { ...repair, candidateState: RepairCandidateState.Cancelling },
    });
    return true;
  }

  public cancelRepairCandidate(token: RepairToken): boolean {
    if (!this.isCurrentRepair(token)) return false;
    this.update({
      repair: {
        ...this.state.repair,
        candidateState: RepairCandidateState.Cancelled,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Drops the candidate from the interface and returns what was dropped.
   *
   * The handle comes back so the caller can release the worker's copy. The store
   * cannot do that itself — it holds no client and dispatches nothing — and
   * forgetting a candidate without releasing it would leave a mesh the size of
   * the model resident for the rest of the session.
   */
  public clearRepairCandidate(): RepairCandidateHandle | undefined {
    const repair = this.state.repair;
    const dropped = repair.candidate?.candidate;
    if (repair.candidate === undefined && repair.candidateState === RepairCandidateState.Idle) {
      return undefined;
    }
    this.update({
      repair: {
        ...repair,
        candidateState: RepairCandidateState.Idle,
        candidate: undefined,
        candidateError: undefined,
        previewMode: RepairPreviewMode.Before,
        fraction: 0,
        phase: undefined,
      },
    });
    return dropped;
  }

  public setRepairPreviewMode(mode: RepairPreviewMode): void {
    const repair = this.state.repair;
    if (repair.previewMode === mode) return;
    // Showing the proposed result requires a proposed result to show.
    if (mode === RepairPreviewMode.After && repair.candidate?.render === undefined) return;
    this.update({ repair: { ...repair, previewMode: mode } });
  }

  public setChangeOverlayVisible(overlay: ChangeOverlayId, visible: boolean): void {
    const repair = this.state.repair;
    if (repair.changeOverlays[overlay] === visible) return;
    this.update({
      repair: { ...repair, changeOverlays: { ...repair.changeOverlays, [overlay]: visible } },
    });
  }

  /**
   * Claims the commit slot.
   *
   * Returns false when a commit or an undo is already running, which is the
   * guard that makes a double-click harmless: the second click finds the slot
   * taken and dispatches nothing. The worker refuses a second commit too — this
   * is the first of two independent defences, not the only one.
   */
  public beginRepairCommit(): boolean {
    const repair = this.state.repair;
    if (repair.commitState !== RepairCommitState.Idle) return false;
    if (repair.candidateState !== RepairCandidateState.Ready || repair.candidate === undefined) {
      return false;
    }
    this.update({
      repair: {
        ...repair,
        commitState: RepairCommitState.Applying,
        commitError: undefined,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  /**
   * Progress for a commit or an undo.
   *
   * Not tokened, because `commitState` already admits exactly one at a time —
   * there is no second attempt to tell it apart from. An update that arrives
   * when neither is running belongs to an operation that has already finished
   * and is dropped.
   */
  public reportRepairCommitProgress(fraction: number, phase: string): void {
    const repair = this.state.repair;
    if (repair.commitState === RepairCommitState.Idle) return;
    if (
      repair.phase === phase &&
      Math.round(repair.fraction * 100) === Math.round(fraction * 100)
    ) {
      return;
    }
    this.update({ repair: { ...repair, fraction, phase } });
  }

  public failRepairCommit(error: RepairFailure): void {
    this.update({
      repair: {
        ...this.state.repair,
        commitState: RepairCommitState.Idle,
        commitError: error,
        fraction: 0,
        phase: undefined,
      },
    });
  }

  /**
   * Installs a committed repair as the loaded model.
   *
   * THE MODEL IS REPLACED, not annotated. What the viewport draws, what export
   * resolves, and what Mesh Health describes all follow from `model`, so a
   * commit that updated anything less than this would leave one of them
   * describing the previous revision. The source file facts are carried forward:
   * the user's file did not change, its geometry did.
   *
   * Analysis is reset to `Idle` for the NEW handle, which is what makes
   * diagnostics re-run automatically against the repaired geometry.
   */
  public applyRepairResult(result: {
    readonly handle: ModelHandle;
    readonly parentRevision: number;
    readonly recordId: string;
    readonly appliedOperations: readonly RepairOperation[];
    readonly counts: RepairChangeCounts;
    readonly undoable: boolean;
    readonly render: RenderSnapshot;
    readonly bounds: MeshBounds | undefined;
    readonly triangleCount: number;
    readonly vertexCount: number;
    readonly residentBytes: number;
  }): boolean {
    const model = this.state.model;
    if (model === undefined) return false;
    if (model.handle.modelId !== result.handle.modelId) return false;

    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;

    this.update({
      model: {
        ...model,
        handle: result.handle,
        render: result.render,
        bounds: result.bounds,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        residentBytes: result.residentBytes,
        revision,
      },
      analysis: { ...EMPTY_ANALYSIS, state: AnalysisState.Idle, handle: result.handle },
      /*
       * A NEW REVISION GETS A NEW VERDICT, OR NONE AT ALL.
       *
       * The previous report described geometry that no longer exists. Carrying
       * it forward — even for the instant before a fresh check starts — would
       * put "None found" beside a model nothing has examined. The band is
       * re-derived too, because a repair can move a model across a policy
       * boundary.
       */
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: result.handle,
        band: bandForFaceCount(result.triangleCount),
      },
      overlays: OVERLAYS_HIDDEN,
      repair: {
        ...EMPTY_REPAIR,
        handle: result.handle,
        selection: this.state.repair.selection,
        lastApplied: {
          recordId: result.recordId,
          handle: result.handle,
          parentRevision: result.parentRevision,
          appliedOperations: result.appliedOperations,
          counts: result.counts,
          undoable: result.undoable,
        },
      },
    });
    return true;
  }

  /** Claims the undo slot. False when a commit or undo is already running. */
  public beginRepairUndo(): boolean {
    const repair = this.state.repair;
    if (repair.commitState !== RepairCommitState.Idle) return false;
    if (repair.lastApplied?.undoable !== true) return false;
    this.update({
      repair: {
        ...repair,
        commitState: RepairCommitState.Undoing,
        commitError: undefined,
        fraction: 0,
        phase: undefined,
      },
    });
    return true;
  }

  public failRepairUndo(error: RepairFailure): void {
    this.update({
      repair: {
        ...this.state.repair,
        commitState: RepairCommitState.Idle,
        commitError: error,
        fraction: 0,
        phase: undefined,
      },
    });
  }

  /**
   * Installs restored geometry as the loaded model.
   *
   * A NEW REVISION, not a rewind. The undo produced fresh authoritative geometry
   * in the worker at a higher revision number, and the interface follows it —
   * see ADR 0011. `lastApplied` is cleared because the repair it described has
   * been reversed and can no longer be reversed again.
   */
  public applyUndoResult(result: {
    readonly handle: ModelHandle;
    readonly render: RenderSnapshot;
    readonly bounds: MeshBounds | undefined;
    readonly triangleCount: number;
    readonly vertexCount: number;
    readonly residentBytes: number;
  }): boolean {
    const model = this.state.model;
    if (model === undefined) return false;
    if (model.handle.modelId !== result.handle.modelId) return false;

    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;

    this.update({
      model: {
        ...model,
        handle: result.handle,
        render: result.render,
        bounds: result.bounds,
        triangleCount: result.triangleCount,
        vertexCount: result.vertexCount,
        residentBytes: result.residentBytes,
        revision,
      },
      analysis: { ...EMPTY_ANALYSIS, state: AnalysisState.Idle, handle: result.handle },
      /*
       * A NEW REVISION GETS A NEW VERDICT, OR NONE AT ALL.
       *
       * The previous report described geometry that no longer exists. Carrying
       * it forward — even for the instant before a fresh check starts — would
       * put "None found" beside a model nothing has examined. The band is
       * re-derived too, because a repair can move a model across a policy
       * boundary.
       */
      selfIntersection: {
        ...EMPTY_SELF_INTERSECTION,
        handle: result.handle,
        band: bandForFaceCount(result.triangleCount),
      },
      overlays: OVERLAYS_HIDDEN,
      repair: { ...EMPTY_REPAIR, handle: result.handle, selection: this.state.repair.selection },
    });
    return true;
  }

  /**
   * Claims the analysis slot for `handle`.
   *
   * The previous report is deliberately KEPT while the new analysis runs. A
   * re-analysis of the same model should not blank the panel the user is
   * reading; if the new run is cancelled or fails, what was already known is
   * still true and still shown.
   */
  public beginAnalysis(handle: ModelHandle): AnalysisToken {
    const token = this.nextAnalysisToken as AnalysisToken;
    this.nextAnalysisToken += 1;
    this.currentAnalysisToken = token;

    const previous = this.state.analysis;
    this.update({
      analysis: {
        ...previous,
        state: AnalysisState.Analyzing,
        handle,
        fraction: 0,
        phase: undefined,
        error: undefined,
        // Report and detail intentionally carried forward.
        report: sameHandle(previous.handle, handle) ? previous.report : undefined,
        detail: sameHandle(previous.handle, handle) ? previous.detail : undefined,
      },
    });
    return token;
  }

  public isCurrentAnalysis(token: AnalysisToken): boolean {
    return this.currentAnalysisToken === token;
  }

  public setOverlayVisible(overlay: OverlayId, visible: boolean): void {
    if (this.state.overlays[overlay] === visible) return;
    this.update({ overlays: { ...this.state.overlays, [overlay]: visible } });
  }

  public reportAnalysisProgress(token: AnalysisToken, fraction: number, phase: string): void {
    if (!this.isCurrentAnalysis(token)) return;
    const analysis = this.state.analysis;
    // Coalesced at the source: a worker phase can emit many updates per second,
    // and re-rendering for a fraction that rounds to the same displayed percent
    // is work nobody sees. Phase changes always pass through.
    if (
      analysis.phase === phase &&
      Math.round(analysis.fraction * 100) === Math.round(fraction * 100)
    ) {
      return;
    }
    this.update({ analysis: { ...analysis, state: AnalysisState.Analyzing, fraction, phase } });
  }

  /**
   * Installs a report, but only for the model that is actually loaded.
   *
   * TWO GATES, not one. The token rejects a superseded analysis; the handle
   * comparison rejects a report whose model is no longer current even if the
   * token somehow survived. Either alone would leave a path for M0's topology
   * to be displayed beside M1's geometry.
   */
  public commitAnalysis(
    token: AnalysisToken,
    handle: ModelHandle,
    report: TopologyReport,
    detail: TopologyDetail,
    durationMs: number,
  ): boolean {
    if (!this.isCurrentAnalysis(token)) return false;
    if (!sameHandle(this.state.model?.handle, handle)) return false;
    this.currentAnalysisToken = undefined;

    this.update({
      analysis: {
        state: AnalysisState.Ready,
        handle,
        fraction: 1,
        phase: undefined,
        report,
        detail,
        error: undefined,
        durationMs,
      },
    });
    return true;
  }

  /**
   * Records that analysis did not produce a report.
   *
   * Does NOT touch `model`: a failed analysis leaves the imported geometry fully
   * usable. Losing a successfully imported model because diagnostics ran out of
   * memory would be a worse outcome than having no diagnostics.
   */
  public failAnalysis(token: AnalysisToken, error: AnalysisFailure): boolean {
    if (!this.isCurrentAnalysis(token)) return false;
    this.currentAnalysisToken = undefined;

    const analysis = this.state.analysis;
    this.update({
      analysis: { ...analysis, state: AnalysisState.Failed, fraction: 0, phase: undefined, error },
    });
    return true;
  }

  /**
   * Records a cancelled analysis.
   *
   * Falls back to `ready` when a complete earlier report for the same model is
   * still held — cancelling a re-run should not discard the answer the user
   * already had. A partial report is never installed by any path.
   */
  public cancelAnalysis(token: AnalysisToken): boolean {
    if (!this.isCurrentAnalysis(token)) return false;
    this.currentAnalysisToken = undefined;

    const analysis = this.state.analysis;
    const hasEarlierReport = analysis.report !== undefined;
    this.update({
      analysis: {
        ...analysis,
        state: hasEarlierReport ? AnalysisState.Ready : AnalysisState.Cancelled,
        fraction: hasEarlierReport ? 1 : 0,
        phase: undefined,
        error: undefined,
      },
    });
    return true;
  }

  /**
   * Records that an import did not succeed.
   *
   * Deliberately does NOT touch `model`. A failed or cancelled replacement must
   * leave whatever was already loaded exactly as it was — losing the user's
   * model because the next file turned out to be broken would be its own kind
   * of data loss. A stale failure is ignored entirely, so a superseded import
   * cannot put the interface into an error state that belongs to nothing.
   */
  public failImport(token: ImportToken): boolean {
    if (!this.isCurrentImport(token)) return false;
    this.currentImportToken = undefined;
    this.update({
      importProgress: {
        state: this.state.model === undefined ? ImportState.Error : ImportState.Ready,
        fraction: this.state.model === undefined ? 0 : 1,
      },
    });
    return true;
  }

  /**
   * Claims the export slot.
   *
   * Tokened for the same reason imports are: a second export started while the
   * first is still writing would otherwise have its progress bar driven by
   * whichever operation reported last. Progress from a superseded export is
   * discarded rather than displayed.
   */
  /**
   * Records total loss of worker-side geometry and discards the model.
   *
   * POLICY A. The worker held the ONLY copy of the authoritative mesh, so there
   * is nothing left to operate on. Nothing is reconstructed from the render
   * snapshot — pixels are not geometry — and leaving the picture on screen would
   * imply a working session that no longer exists: export would fail, and so
   * would every future diagnostic. Showing nothing and saying why is the less
   * misleading of the two options.
   *
   * In-flight tokens are cleared so a late reply from the dead worker cannot
   * install anything afterwards.
   */
  public loseGeometrySession(reason: string): void {
    this.currentImportToken = undefined;
    this.currentExportToken = undefined;
    this.currentAnalysisToken = undefined;
    this.currentRepairToken = undefined;
    this.update({
      model: undefined,
      geometrySessionLost: reason,
      importProgress: { state: ImportState.Idle, fraction: 0 },
      exportProgress: { state: ExportState.Idle, fraction: 0 },
      // The report described geometry that no longer exists. Keeping it on
      // screen would describe a model the user cannot export, overlay, or act
      // on — the same reason the model itself is cleared.
      analysis: EMPTY_ANALYSIS,
      selfIntersection: EMPTY_SELF_INTERSECTION,
      // And so did the repair. A candidate, a preview and an undo record all
      // named worker-resident geometry that died with the worker; leaving an
      // Apply button pointing at a dead candidate would be worse than showing
      // nothing, because pressing it could only fail.
      repair: EMPTY_REPAIR,
      overlays: OVERLAYS_HIDDEN,
    });
  }

  public beginExport(encoding: string): ExportToken {
    const token = this.nextExportToken as ExportToken;
    this.nextExportToken += 1;
    this.currentExportToken = token;
    this.update({ exportProgress: { state: ExportState.Working, fraction: 0, encoding } });
    return token;
  }

  public isCurrentExport(token: ExportToken): boolean {
    return this.currentExportToken === token;
  }

  public reportExportProgress(token: ExportToken, fraction: number, encoding: string): void {
    if (!this.isCurrentExport(token)) return;
    this.update({ exportProgress: { state: ExportState.Working, fraction, encoding } });
  }

  /** Ends the export, whether it succeeded, failed, or was cancelled. */
  public finishExport(token: ExportToken): boolean {
    if (!this.isCurrentExport(token)) return false;
    this.currentExportToken = undefined;
    this.update({ exportProgress: { state: ExportState.Idle, fraction: 0 } });
    return true;
  }

  private update(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Handle equality: same model AND same revision.
 *
 * Comparing only `modelId` would accept a report computed before the model was
 * replaced in place, which is exactly what the revision exists to catch.
 */
function sameHandle(left: ModelHandle | undefined, right: ModelHandle | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.modelId === right.modelId && left.revision === right.revision;
}
