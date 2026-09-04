import type { BoundaryKind } from './components';
import type { VolumeStatus } from './metrics';

/**
 * THE TOPOLOGY REPORT CONTRACT.
 *
 * Versioned, because this crosses the worker boundary and will be persisted in
 * a session before long. A consumer must be able to tell which shape it has.
 *
 * WORDING IS PART OF THE CONTRACT. Stage 2 checks topology and nothing else, so
 * the report never says "valid", "printable", or "watertight". It reports what
 * it measured, and it carries explicit NOT-CHECKED states for the things it did
 * not measure, so a consumer cannot mistake silence for a pass.
 *
 * Counts are always EXACT. Detail samples are bounded — see `TopologyDetail` —
 * so a pathological mesh with two million bad edges produces two million in the
 * count and at most `sampleLimit` in the sample, with a flag saying so.
 */

export const TOPOLOGY_REPORT_VERSION = 1;

/** Stage 2 does not implement triangle/triangle intersection testing. */
export const SelfIntersectionStatus = {
  NotChecked: 'not-checked',
} as const;

export type SelfIntersectionStatus =
  (typeof SelfIntersectionStatus)[keyof typeof SelfIntersectionStatus];

/**
 * Printability is never `true` in Stage 2.
 *
 * A topologically clean mesh can still self-intersect and can still have walls
 * thinner than a nozzle. Both are unchecked, so the honest answer is that the
 * question is not fully determined — regardless of how good the topology looks.
 */
export const PrintabilityStatus = {
  /** Topology checks found defects, so it is definitely not ready. */
  TopologicalDefects: 'topological-defects',
  /** Topology is clean, but self-intersection and thickness are unchecked. */
  NotFullyDetermined: 'not-fully-determined',
} as const;

export type PrintabilityStatus = (typeof PrintabilityStatus)[keyof typeof PrintabilityStatus];

/**
 * One face-connected component, described in ITS OWN terms.
 *
 * COMPONENT-LOCAL SETS MAY OVERLAP. Two components that touch only at a vertex
 * — a bow-tie apex, two shells meeting at one corner — both genuinely contain
 * that vertex. It is one vertex globally and a member of two local vertex sets.
 *
 * Therefore `sum(component.topologicalVertexCount)` is NOT expected to equal the
 * report's global `topologicalVertexCount`, and nothing here forces it to. The
 * global count stays deduplicated; the local counts describe their components
 * truthfully. Making them additive would require handing a shared vertex to one
 * component and denying it to the other, which yields a wrong χ for both.
 *
 * There is no "owner component" concept, internally or in the contract.
 */
export interface ComponentSummary {
  readonly componentId: number;
  /** Faces whose component id is this one. Sums to the global face count. */
  readonly faceCount: number;
  /**
   * Unique topological vertices referenced by this component's faces.
   *
   * May overlap another component's set at a point of contact; see above.
   */
  readonly topologicalVertexCount: number;
  /**
   * Unique recovered edges belonging to this component.
   *
   * Does not overlap: sharing an edge is exactly what merges two components, so
   * every edge belongs to precisely one. Sums to the global edge count.
   */
  readonly edgeCount: number;
  readonly boundaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  /**
   * Non-manifold vertices among this component's own vertices.
   *
   * A vertex whose fans span two components is counted in BOTH, because the
   * singularity is a real property of each — a user inspecting either component
   * needs to see it. Like the vertex count, this is not additive.
   */
  readonly nonManifoldVertexCount: number;
  readonly windingConflictCount: number;
  /**
   * χ = V − E + F, computed from this component's own V, E and F.
   *
   * V is the local vertex set above, including any shared point of contact.
   */
  readonly eulerCharacteristic: number;
  readonly surfaceArea: number;
  readonly signedVolume: number;
  readonly volumeStatus: VolumeStatus;
}

export interface BoundaryComponentSummary {
  readonly kind: BoundaryKind;
  readonly edgeCount: number;
  readonly vertexCount: number;
}

/**
 * Bounded, deterministic samples for later visualisation.
 *
 * Exact counts live in the report; these are representative subsets chosen in
 * ascending index order so the same mesh always yields the same sample. Kept as
 * typed arrays so they transfer cheaply and never become millions of objects.
 *
 * Stage 2C-1 produces these; the viewport overlays that consume them are
 * Stage 2C-2.
 */
export interface TopologyDetail {
  /** Vertex-id pairs, two entries per edge. */
  readonly boundaryEdges: Uint32Array;
  readonly boundaryEdgesTruncated: boolean;
  readonly nonManifoldEdges: Uint32Array;
  readonly nonManifoldEdgesTruncated: boolean;
  readonly windingConflictEdges: Uint32Array;
  readonly windingConflictEdgesTruncated: boolean;
  /** Face indices. */
  readonly degenerateFaces: Uint32Array;
  readonly degenerateFacesTruncated: boolean;
  /**
   * Ascending, unique vertex ids actually referenced by the sampled edges.
   *
   * This is the lookup key, NOT every vertex in the mesh. An earlier version
   * shipped one position per topological vertex, which for a two-million
   * triangle model is a ~72 MB transfer on every analysis — unbounded output
   * attached to a bounded sample.
   */
  readonly sampleVertexIds: Uint32Array;
  /** Positions aligned with `sampleVertexIds`, three floats per entry. */
  readonly sampleVertexPositions: Float32Array;
  readonly sampleLimit: number;
}

export interface TopologyReport {
  readonly schemaVersion: number;
  readonly documentId: string;
  readonly documentRevision: number;
  /**
   * The part this report describes.
   *
   * ANALYSIS IS PER PART. A document's parts are separate meshes; running one
   * analysis over all of them would report connectivity between things the file
   * declared separate, and two clean parts that happen to touch would acquire
   * shared edges neither of them has. Naming the part here is what lets a
   * consumer refuse a report that arrived for a part it is no longer showing.
   */
  readonly partId: string;
  /** e.g. `exact-stored-coordinate`. The report states its own identity rules. */
  readonly identityMode: string;

  readonly sourceFaceCount: number;
  readonly sourceCornerCount: number;
  /**
   * Globally unique recovered vertices — deduplicated across the whole mesh.
   *
   * Component-local vertex sets may overlap this one at points of contact, so
   * the per-component counts can sum to MORE than this. That is expected; this
   * number never absorbs the overlap. See `ComponentSummary`.
   */
  readonly topologicalVertexCount: number;

  readonly uniqueEdgeCount: number;
  readonly boundaryEdgeCount: number;
  readonly ordinaryEdgeCount: number;
  readonly nonManifoldEdgeCount: number;
  readonly nonManifoldVertexCount: number;
  readonly windingConflictEdgeCount: number;

  readonly repeatedPositionFaceCount: number;
  readonly zeroAreaFaceCount: number;
  readonly sameOrientationDuplicateCount: number;
  readonly reversedOrientationDuplicateCount: number;

  readonly componentCount: number;
  readonly components: readonly ComponentSummary[];
  readonly componentsTruncated: boolean;

  readonly simpleBoundaryLoopCount: number;
  readonly openBoundaryChainCount: number;
  readonly branchedBoundaryCount: number;
  /** Bounded summary list; the three counts above are exact. */
  readonly boundaryComponents: readonly BoundaryComponentSummary[];
  readonly boundaryComponentsTruncated: boolean;

  readonly totalSurfaceArea: number;
  readonly totalSignedVolume: number;

  /** True only when no topological defect of any kind was found. */
  readonly isEdgeManifold: boolean;
  readonly isVertexManifold: boolean;
  readonly isWindingConsistent: boolean;
  readonly isBoundaryFree: boolean;

  readonly selfIntersectionStatus: SelfIntersectionStatus;
  readonly printabilityStatus: PrintabilityStatus;

  readonly analysisMilliseconds: number;
}

export interface TopologyResult {
  readonly report: TopologyReport;
  readonly detail: TopologyDetail;
}
