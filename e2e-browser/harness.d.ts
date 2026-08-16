/**
 * Type surface of the experimental browser harness, as seen from Playwright.
 *
 * The harness itself is plain JS served to the browser (deliberately — it must
 * not go through a bundler, because Emscripten's ES6 glue does not survive
 * one). This declaration is what lets the specs call it under
 * `noImplicitAny` without an `any` in sight.
 *
 * Deliberately loose in one place: an operation `request` is a discriminated
 * bag whose shape differs per candidate and per operation, and typing it
 * precisely here would duplicate the worker's own dispatch table and drift from
 * it. It is `Record<string, unknown>`, not `any`, so nothing is silently
 * unchecked.
 */
export {};

interface HarnessEnvironment {
  readonly userAgent: string;
  readonly crossOriginIsolated: boolean;
  readonly hasSharedArrayBuffer: boolean;
  readonly hardwareConcurrency: number;
  readonly origin: string;
}

interface StaleMessage {
  readonly sessionId: number;
  readonly opId: number;
  readonly type: string;
  readonly reason: string;
}

interface OpenResult {
  readonly ok: boolean;
  readonly sessionId: number;
  readonly phase?: string;
  readonly message?: string;
  readonly workerCreateMs?: number;
  readonly glueImportMs?: number;
  readonly wasmInstantiateMs?: number;
  readonly initialHeapBytes?: number;
  readonly initTotalMs?: number;
}

declare global {
  interface Window {
    readonly cfHarness: {
      environment(): HarnessEnvironment;
      buildMesh(
        name: string,
        spec: Record<string, unknown>,
      ): Promise<{
        name: string;
        buildMs: number;
        vertices: number;
        triangles: number;
        bytes: number;
      }>;
      sphereForBytes(targetBytes: number): Promise<{
        segments: number;
        rings: number;
        vertexCount: number;
        triangleCount: number;
        bytes: number;
      } | null>;
      releaseMeshes(): boolean;
      runOnMesh(
        sessionId: number,
        meshName: string,
        request: Record<string, unknown>,
        options?: { returnGeometry?: boolean },
      ): Promise<Record<string, unknown>>;
      booleanOnMeshes(
        sessionId: number,
        leftName: string,
        rightName: string,
        opType: number,
      ): Promise<Record<string, unknown>>;
      setAuthoritative(
        positions: number[] | Float64Array,
        triangles: number[] | Uint32Array,
      ): {
        positions: string;
        triangles: string;
        positionBytes: number;
        triangleBytes: number;
        detached: boolean;
      } | null;
      authoritativeDigest(): {
        positions: string;
        triangles: string;
        positionBytes: number;
        triangleBytes: number;
        detached: boolean;
      } | null;
      staleMessages(): StaleMessage[];
      open(candidateId: string): Promise<OpenResult>;
      run(
        sessionId: number,
        request: Record<string, unknown>,
        options?: { returnGeometry?: boolean },
      ): Promise<Record<string, unknown>>;
      beginLongOperation(
        sessionId: number,
        request: Record<string, unknown>,
      ): Promise<{ ok: boolean; opId?: number; startedAtMs?: number; phase?: string }>;
      stillRunning(sessionId: number): boolean;
      mainThreadResponsive(): Promise<number>;
      terminate(sessionId: number): {
        ok: boolean;
        terminateCallMs?: number;
        pendingAtTerminate?: number;
        phase?: string;
      };
      observeTermination(
        sessionId: number,
        quietMs: number,
      ): Promise<{ observedMs: number; lateMessages: number }>;
      close(sessionId: number): boolean;
    };
  }
}
