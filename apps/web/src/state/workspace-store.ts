import type { WorkflowId } from './workflows';

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

export interface WorkspaceState {
  /** `undefined` means no workflow is open. No workflow can be opened in Stage 0. */
  readonly selectedWorkflow: WorkflowId | undefined;
  /**
   * Always `false` in Stage 0. Nothing can load a model yet, and the viewport
   * reads this rather than inferring emptiness from a mesh that never arrives.
   */
  readonly hasModel: boolean;
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
  hasModel: false,
  status: [],
  runtime: { selfTest: SelfTestState.Idle, progress: 0 },
  viewportFailure: undefined,
};

export class WorkspaceStore {
  private state: WorkspaceState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private nextStatusId = 1;

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

  private update(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
