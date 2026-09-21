import type { BooleanKind } from '@cadfixer/geometry-runtime';

export interface BooleanOperationRequest {
  readonly kind: 'run';
  readonly operationId: string;
  readonly operation: BooleanKind;
  readonly aPositions: Float32Array;
  readonly aIndices: Uint32Array;
  readonly bPositions: Float32Array;
  readonly bIndices: Uint32Array;
  readonly testCrash?: boolean;
}

export type BooleanOperationPhase =
  'WORKER_READY' | 'WASM_READY' | 'MANIFOLD_ENTER' | 'MANIFOLD_RETURN';

export type BooleanOperationReply =
  | {
      readonly kind: 'phase';
      readonly operationId: string;
      readonly phase: BooleanOperationPhase;
      readonly at: number;
    }
  | {
      readonly kind: 'result';
      readonly operationId: string;
      readonly positions: Float32Array;
      readonly indices: Uint32Array;
    }
  | {
      readonly kind: 'failed';
      readonly operationId: string;
      readonly message: string;
      readonly expected: boolean;
    };
