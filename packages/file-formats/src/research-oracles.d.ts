/**
 * TYPE SHAPES FOR THE STAGE 4A RESEARCH ORACLES. TEST-ONLY.
 *
 * The reference implementations under `experiments/format-io/` are plain
 * JavaScript, on purpose: they were written to be read in one sitting and run
 * under `node` with no build step. The differential suite compares production
 * against them, and `noImplicitAny` would otherwise make every field of their
 * results an `any` — which is exactly the silent unchecked access this
 * repository bans.
 *
 * DELIBERATELY PARTIAL. Only the fields the differential suite reads are
 * declared. Mirroring the whole research surface would create a second
 * definition to keep in step with a tree that is finished and will not change.
 */

declare module '*/experiments/format-io/obj.mjs' {
  export interface ResearchObjFace {
    readonly indices: readonly number[];
    readonly object?: string;
    readonly group?: string;
    readonly material?: string;
  }

  export interface ResearchObjResult {
    readonly vertexCount: number;
    readonly faceCount: number;
    readonly objects: readonly { readonly name: string }[];
    readonly groups: readonly { readonly name: string }[];
    readonly materials: readonly string[];
    readonly mtllib?: string;
    readonly positions: readonly number[];
    readonly faces: readonly ResearchObjFace[];
    readonly refusals: readonly { readonly code: string; readonly line: number }[];
  }

  export function parseObj(text: string, limits?: unknown): ResearchObjResult;
}

declare module '*/experiments/format-io/threemf.mjs' {
  export interface ResearchThreeMfPart {
    readonly id: string;
    readonly name?: string;
    readonly materialRef?: string;
    readonly transform: readonly number[];
    readonly mesh: { readonly positions: Float32Array; readonly indices: Uint32Array };
  }

  export interface ResearchThreeMfResult {
    readonly unit?: string;
    readonly parts: readonly ResearchThreeMfPart[];
    readonly unsupported: readonly string[];
    readonly objectCount: number;
  }

  export function read3mf(
    bytes: Uint8Array,
    limits?: unknown,
    zipLimits?: unknown,
  ): Promise<ResearchThreeMfResult>;
}
