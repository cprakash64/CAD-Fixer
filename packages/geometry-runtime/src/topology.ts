import type {
  BoundaryKind as EngineBoundaryKind,
  PrintabilityStatus as EnginePrintabilityStatus,
  SelfIntersectionStatus as EngineSelfIntersectionStatus,
  VolumeStatus as EngineVolumeStatus,
} from '@cadfixer/mesh-topology';

/**
 * The report's status VALUES, restated here so the application can compare
 * against them without importing the topology engine.
 *
 * WHY NOT JUST RE-EXPORT THE ENGINE'S CONSTANTS. A value re-export makes
 * `mesh-topology` a runtime dependency of everything that imports this package —
 * including the main-thread bundle, which imports the protocol. The engine
 * belongs in the worker chunk and nowhere else; relying on a bundler to
 * tree-shake it back out is a promise nobody checks. Four small frozen objects
 * cost nothing and keep the boundary provable.
 *
 * The duplication is guarded, not trusted: each constant is checked below
 * against the engine's own type, so a value that drifts fails `tsc` rather than
 * silently comparing false at runtime and showing the wrong label forever. The
 * type import is erased at build time and adds no runtime edge.
 */

export const SelfIntersectionStatus = {
  NotChecked: 'not-checked',
} as const;

export type SelfIntersectionStatus =
  (typeof SelfIntersectionStatus)[keyof typeof SelfIntersectionStatus];

export const PrintabilityStatus = {
  TopologicalDefects: 'topological-defects',
  NotFullyDetermined: 'not-fully-determined',
} as const;

export type PrintabilityStatus = (typeof PrintabilityStatus)[keyof typeof PrintabilityStatus];

export const VolumeStatus = {
  ClosedManifold: 'closed-manifold',
  OpenSurface: 'open-surface',
  NotInterpretable: 'not-interpretable',
} as const;

export type VolumeStatus = (typeof VolumeStatus)[keyof typeof VolumeStatus];

export const BoundaryKind = {
  SimpleLoop: 'simple-loop',
  OpenChain: 'open-chain',
  Branched: 'branched',
} as const;

export type BoundaryKind = (typeof BoundaryKind)[keyof typeof BoundaryKind];

/**
 * Compile-time proof that the restatements above match the engine exactly.
 *
 * Assignability is checked in BOTH directions: one way alone would let this
 * module quietly drop a case the engine can still produce, which is the failure
 * that would actually reach a user — a status the interface has no branch for.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _selfIntersectionMatches: Exactly<SelfIntersectionStatus, EngineSelfIntersectionStatus> =
  true;
const _printabilityMatches: Exactly<PrintabilityStatus, EnginePrintabilityStatus> = true;
const _volumeMatches: Exactly<VolumeStatus, EngineVolumeStatus> = true;
const _boundaryMatches: Exactly<BoundaryKind, EngineBoundaryKind> = true;

// Referenced so the assertions are not dead code the compiler may drop; the
// array is const and never read at runtime.
export const TOPOLOGY_STATUS_CONTRACT_CHECKED = [
  _selfIntersectionMatches,
  _printabilityMatches,
  _volumeMatches,
  _boundaryMatches,
] as const;
