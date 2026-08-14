import type { WorkflowId } from './workflows';
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
  readonly exportState: ExportState;
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
}

/** Bounded so a chatty session cannot grow the log without limit. */
const MAX_STATUS_ENTRIES = 50;

const INITIAL_STATE: WorkspaceState = {
  selectedWorkflow: undefined,
  model: undefined,
  importProgress: { state: ImportState.Idle, fraction: 0 },
  exportState: ExportState.Idle,
  status: [],
  runtime: { selfTest: SelfTestState.Idle, progress: 0 },
  viewportFailure: undefined,
};

export class WorkspaceStore {
  private state: WorkspaceState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private nextStatusId = 1;
  private nextModelRevision = 1;

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

  public setImportProgress(progress: ImportProgressState): void {
    this.update({ importProgress: progress });
  }

  /**
   * Installs a successfully imported model, replacing any previous one.
   *
   * The revision counter is what lets the viewport distinguish "same model,
   * re-render" from "new model, rebuild GPU buffers", without comparing
   * multi-megabyte typed arrays.
   */
  public setModel(model: Omit<LoadedModel, 'revision'>): void {
    const revision = this.nextModelRevision;
    this.nextModelRevision += 1;
    this.update({
      model: { ...model, revision },
      importProgress: { state: ImportState.Ready, fraction: 1 },
    });
  }

  /**
   * Records that an import did not succeed.
   *
   * Deliberately does NOT touch `model`. A failed or cancelled replacement must
   * leave the previously loaded model exactly as it was.
   */
  public failImport(): void {
    this.update({ importProgress: { state: ImportState.Error, fraction: 0 } });
  }

  /** Returns the import indicator to rest without disturbing the model. */
  public resetImportProgress(): void {
    this.update({
      importProgress: {
        state: this.state.model === undefined ? ImportState.Idle : ImportState.Ready,
        fraction: this.state.model === undefined ? 0 : 1,
      },
    });
  }

  public setExportState(exportState: ExportState): void {
    this.update({ exportState });
  }

  private update(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
