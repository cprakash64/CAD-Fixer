import { internalError, throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import { triangleCount, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseBoundary, analyseComponents, estimateComponentBytes } from './components';
import {
  buildDirectedEdges,
  estimateEdgeBytes,
  groupEdges,
  type DirectedEdges,
  type EdgeGroups,
} from './edges';
import { analyseDegeneracy, analyseDuplicates, estimateFaceAnalysisBytes } from './faces';
import {
  estimateVertexIdentityBytes,
  recoverVertexIdentity,
  type CoordinateIdentity,
} from './identity';
import {
  analyseEdges,
  analyseVertexManifoldness,
  buildVertexIncidence,
  EdgeClass,
  estimateManifoldBytes,
} from './manifold';
import {
  computeArea,
  computeSignedVolume,
  estimateMetricBytes,
  eulerCharacteristic,
  VolumeStatus,
} from './metrics';
import { peakOf, stage } from './memory';
import {
  PrintabilityStatus,
  SelfIntersectionStatus,
  TOPOLOGY_REPORT_VERSION,
  type BoundaryComponentSummary,
  type ComponentSummary,
  type TopologyDetail,
  type TopologyReport,
  type TopologyResult,
} from './report';

/**
 * READ-ONLY topology analysis.
 *
 * NOTHING HERE MUTATES THE MESH. No welding, no reordering, no dropping, no
 * flipping, no index rewriting. Every structure built is derived and local; the
 * canonical positions and indices are only ever read. A regression test asserts
 * both buffers are byte-identical afterwards.
 *
 * PHASE WEIGHTS reflect measured cost, not equal slices — canonicalisation and
 * edge grouping dominate, and pretending otherwise would make the progress bar
 * lie about what is left.
 */

const PHASES = [
  { name: 'canonicalizing vertices', weight: 0.22 },
  { name: 'building edges', weight: 0.14 },
  { name: 'grouping edges', weight: 0.2 },
  { name: 'analyzing edge incidence', weight: 0.08 },
  { name: 'analyzing vertex fans', weight: 0.14 },
  { name: 'finding components', weight: 0.06 },
  { name: 'analyzing boundaries', weight: 0.04 },
  { name: 'checking faces', weight: 0.06 },
  { name: 'measuring geometry', weight: 0.05 },
  { name: 'preparing report', weight: 0.01 },
] as const;

export interface TopologyProgress {
  readonly phase: string;
  /** 0..1 across the whole analysis. Monotonic. */
  readonly fraction: number;
}

export interface TopologyAnalysisOptions {
  readonly modelId: string;
  readonly modelRevision: number;
  readonly cancellation: CancellationToken;
  onProgress?(progress: TopologyProgress): void;
  /** Upper bound on retained detail samples per category. */
  readonly sampleLimit?: number;
  readonly identity?: CoordinateIdentity;
  /** Bounds the number of per-component summaries returned. */
  readonly componentSummaryLimit?: number;
  /** Injected so tests can force cancellation at a chosen phase. */
  onPhaseStart?(phase: string): void;
}

export const DEFAULT_SAMPLE_LIMIT = 50_000;
const DEFAULT_COMPONENT_SUMMARY_LIMIT = 1_000;

/**
 * Bytes the analysis will have live AT ONE TIME for a mesh of this size.
 *
 * This is a peak model, not a sum of stage totals — see `memory.ts`. Each stage
 * declares what it retains for the rest of the run and what it releases on
 * return, and the peak is the full retained live set plus the largest single
 * transient. Getting this wrong in the other direction is what a preflight
 * exists to prevent: an estimate that only counted the biggest individual stage
 * would clear an allocation the process cannot actually hold, because the edge
 * arrays are still resident when the fan analysis allocates on top of them.
 *
 * Worst-case shape is assumed throughout: every corner a distinct vertex, and
 * every face its own component. Overflow-safe — non-finite or negative counts
 * return infinity rather than a number that would compare below any limit.
 */
export function estimateTopologyWorkspaceBytes(faceCount: number, cornerCount: number): number {
  if (!Number.isFinite(faceCount) || !Number.isFinite(cornerCount)) {
    return Number.POSITIVE_INFINITY;
  }
  if (faceCount < 0 || cornerCount < 0) return Number.POSITIVE_INFINITY;

  const vertexCount = cornerCount;
  const componentCount = faceCount;

  const total = peakOf([
    estimateVertexIdentityBytes(cornerCount),
    // `faceVertices`, built in this function and read by every later stage.
    stage(faceCount * 3 * 4, 0),
    estimateEdgeBytes(faceCount),
    estimateManifoldBytes(faceCount, vertexCount),
    estimateComponentBytes(faceCount, vertexCount),
    estimateFaceAnalysisBytes(faceCount),
    estimateMetricBytes(componentCount),
    // Per-component counters, the face-by-component CSR, and the stamp array
    // that counts each component's distinct vertices.
    stage(0, componentCount * 4 * 9 + faceCount * 4 + vertexCount * 4),
  ]);

  return Number.isFinite(total) ? total : Number.POSITIVE_INFINITY;
}

/**
 * Bytes the bounded detail payload can reach.
 *
 * Independent of mesh size by construction — that is the point of bounding it —
 * so it is reported separately rather than scaled with the workspace.
 */
export function estimateDetailBytes(sampleLimit: number): number {
  if (!Number.isFinite(sampleLimit) || sampleLimit < 0) return Number.POSITIVE_INFINITY;
  // Three edge categories, two vertex ids each, collected first as JS numbers
  // (8 bytes) and then copied into a Uint32Array (4). Degenerate face indices
  // likewise. Sampled vertices: at most 6 per edge category, id plus position.
  const edgeSamples = 3 * sampleLimit * 2 * (8 + 4);
  const faceSamples = sampleLimit * (8 + 4);
  const vertexSamples = 3 * sampleLimit * 2 * (4 + 12);
  return edgeSamples + faceSamples + vertexSamples;
}

export function analyseTopology(
  mesh: CanonicalMesh,
  options: TopologyAnalysisOptions,
): TopologyResult {
  const startedAt = Date.now();
  const cancellation = options.cancellation;
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const componentLimit = options.componentSummaryLimit ?? DEFAULT_COMPONENT_SUMMARY_LIMIT;

  const faceCount = triangleCount(mesh);
  const cornerCount = Math.floor(mesh.positions.length / 3);

  const bound = (fraction: number): number => Math.min(1, Math.max(0, fraction));

  // Weighted, monotonic progress. `base` is the fraction already completed.
  let phaseIndex = 0;
  let base = 0;
  const beginPhase = (): { report: (withinPhase: number) => void; name: string } => {
    const phase = PHASES[phaseIndex] ?? PHASES[PHASES.length - 1];
    const name = phase?.name ?? 'analyzing';
    const weight = phase?.weight ?? 0;
    const startBase = base;
    phaseIndex += 1;
    base = startBase + weight;
    options.onPhaseStart?.(name);
    throwIfCancelled(cancellation);
    options.onProgress?.({ phase: name, fraction: bound(startBase) });
    return {
      name,
      report: (withinPhase: number): void => {
        throwIfCancelled(cancellation);
        const clamped = Math.min(1, Math.max(0, withinPhase));
        // Bounded at the emit site. The phase weights sum to 1 in decimal but
        // accumulate a little above it in binary floating point, which would
        // otherwise let progress report 1.0000000000000002 — out of contract,
        // and the kind of thing a progress bar renders as a visible overshoot.
        options.onProgress?.({ phase: name, fraction: bound(startBase + clamped * weight) });
      },
    };
  };

  /* ---- 1. exact vertex identity ---- */
  const identityPhase = beginPhase();
  const identity = recoverVertexIdentity(mesh, {
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    onBatch: (done) => {
      identityPhase.report(cornerCount === 0 ? 1 : done / cornerCount);
    },
  });

  // Face → topological vertices. Derived; canonical indices are untouched.
  const faceVertices = new Uint32Array(faceCount * 3);
  for (let f = 0; f < faceCount; f += 1) {
    const base3 = f * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const sourceCorner = mesh.indices[base3 + corner] ?? 0;
      faceVertices[base3 + corner] = identity.cornerToVertex[sourceCorner] ?? 0;
    }
  }

  /* ---- 2. edges ---- */
  const edgePhase = beginPhase();
  const edges: DirectedEdges = buildDirectedEdges(faceVertices, faceCount, (done) => {
    edgePhase.report(faceCount === 0 ? 1 : done / faceCount);
  });

  const groupPhase = beginPhase();
  let sortSteps = 0;
  const groups: EdgeGroups = groupEdges(edges, () => {
    sortSteps += 1;
    groupPhase.report(Math.min(1, sortSteps / 5));
  });

  /* ---- 3. edge classification and winding ---- */
  const incidencePhase = beginPhase();
  const edgeAnalysis = analyseEdges(edges, groups, (done) => {
    incidencePhase.report(groups.uniqueEdgeCount === 0 ? 1 : done / groups.uniqueEdgeCount);
  });

  /* ---- 4. vertex fans ---- */
  const fanPhase = beginPhase();
  const incidence = buildVertexIncidence(faceVertices, faceCount, identity.vertexCount);
  const vertexAnalysis = analyseVertexManifoldness(
    edges,
    groups,
    edgeAnalysis,
    incidence,
    identity.vertexCount,
    (done) => {
      fanPhase.report(groups.uniqueEdgeCount === 0 ? 1 : done / groups.uniqueEdgeCount);
    },
  );

  /* ---- 5. components ---- */
  const componentPhase = beginPhase();
  const components = analyseComponents(edges, groups, faceCount, (done) => {
    componentPhase.report(faceCount === 0 ? 1 : done / faceCount);
  });

  /* ---- 6. boundary ---- */
  const boundaryPhase = beginPhase();
  const boundary = analyseBoundary(
    edges,
    groups,
    edgeAnalysis,
    identity.vertexCount,
    componentLimit,
    (done) => {
      boundaryPhase.report(groups.uniqueEdgeCount === 0 ? 1 : done / groups.uniqueEdgeCount);
    },
  );

  /* ---- 7. degenerate and duplicate faces ---- */
  const facePhase = beginPhase();
  const degeneracy = analyseDegeneracy(
    faceVertices,
    faceCount,
    mesh.positions,
    identity.vertexRepresentativeCorner,
    sampleLimit,
    (done) => {
      facePhase.report(faceCount === 0 ? 1 : (done / faceCount) * 0.5);
    },
  );
  const duplicates = analyseDuplicates(faceVertices, faceCount, (done) => {
    facePhase.report(faceCount === 0 ? 1 : 0.5 + (done / faceCount) * 0.5);
  });

  /* ---- 8. geometry ---- */
  const metricPhase = beginPhase();
  const area = computeArea(
    faceVertices,
    faceCount,
    mesh.positions,
    identity.vertexRepresentativeCorner,
    components.faceComponent,
    components.componentCount,
    (done) => {
      metricPhase.report(faceCount === 0 ? 1 : (done / faceCount) * 0.5);
    },
  );
  const volume = computeSignedVolume(
    faceVertices,
    faceCount,
    mesh.positions,
    identity.vertexRepresentativeCorner,
    components.faceComponent,
    components.componentCount,
    (done) => {
      metricPhase.report(faceCount === 0 ? 1 : 0.5 + (done / faceCount) * 0.5);
    },
  );

  /* ---- 9. assemble ---- */
  const reportPhase = beginPhase();

  const perComponent = accumulatePerComponent(
    edges,
    groups,
    edgeAnalysis,
    vertexAnalysis.nonManifoldVertex,
    components,
    faceVertices,
    faceCount,
    identity.vertexCount,
  );

  const componentSummaries: ComponentSummary[] = [];
  const summaryCount = Math.min(components.componentCount, componentLimit);
  for (let c = 0; c < summaryCount; c += 1) {
    const faces = perComponent.faceCount[c] ?? 0;
    const vertices = perComponent.topologicalVertexCount[c] ?? 0;
    const edgeTotal = perComponent.edgeCount[c] ?? 0;
    const boundaryEdges = perComponent.boundaryEdgeCount[c] ?? 0;
    const nonManifoldEdges = perComponent.nonManifoldEdgeCount[c] ?? 0;
    const nonManifoldVertices = perComponent.nonManifoldVertexCount[c] ?? 0;
    const conflicts = perComponent.windingConflictCount[c] ?? 0;

    const closed = boundaryEdges === 0;
    const manifold = nonManifoldEdges === 0 && nonManifoldVertices === 0;
    const consistent = conflicts === 0;
    componentSummaries.push({
      componentId: c,
      faceCount: faces,
      topologicalVertexCount: vertices,
      edgeCount: edgeTotal,
      boundaryEdgeCount: boundaryEdges,
      nonManifoldEdgeCount: nonManifoldEdges,
      nonManifoldVertexCount: nonManifoldVertices,
      windingConflictCount: conflicts,
      eulerCharacteristic: eulerCharacteristic(vertices, edgeTotal, faces),
      surfaceArea: area.perComponent[c] ?? 0,
      signedVolume: volume.perComponent[c] ?? 0,
      volumeStatus: !closed
        ? VolumeStatus.OpenSurface
        : manifold && consistent
          ? VolumeStatus.ClosedManifold
          : VolumeStatus.NotInterpretable,
    });
  }

  const detail = buildDetail(
    edges,
    groups,
    edgeAnalysis,
    degeneracy.sampleFaces,
    degeneracy.sampleTruncated,
    mesh.positions,
    identity.vertexRepresentativeCorner,
    identity.vertexCount,
    sampleLimit,
  );

  const isEdgeManifold = edgeAnalysis.nonManifoldEdgeCount === 0;
  const isVertexManifold = vertexAnalysis.nonManifoldVertexCount === 0;
  const isWindingConsistent = edgeAnalysis.windingConflictCount === 0;
  const isBoundaryFree = edgeAnalysis.boundaryEdgeCount === 0;

  const hasDefect =
    !isEdgeManifold ||
    !isVertexManifold ||
    !isWindingConsistent ||
    !isBoundaryFree ||
    degeneracy.repeatedPositionCount > 0 ||
    degeneracy.zeroAreaCount > 0 ||
    duplicates.sameOrientationCount > 0 ||
    duplicates.reversedOrientationCount > 0;

  const report: TopologyReport = {
    schemaVersion: TOPOLOGY_REPORT_VERSION,
    modelId: options.modelId,
    modelRevision: options.modelRevision,
    identityMode: identity.mode,

    sourceFaceCount: faceCount,
    sourceCornerCount: cornerCount,
    topologicalVertexCount: identity.vertexCount,

    uniqueEdgeCount: groups.uniqueEdgeCount,
    boundaryEdgeCount: edgeAnalysis.boundaryEdgeCount,
    ordinaryEdgeCount: edgeAnalysis.ordinaryEdgeCount,
    nonManifoldEdgeCount: edgeAnalysis.nonManifoldEdgeCount,
    nonManifoldVertexCount: vertexAnalysis.nonManifoldVertexCount,
    windingConflictEdgeCount: edgeAnalysis.windingConflictCount,

    repeatedPositionFaceCount: degeneracy.repeatedPositionCount,
    zeroAreaFaceCount: degeneracy.zeroAreaCount,
    sameOrientationDuplicateCount: duplicates.sameOrientationCount,
    reversedOrientationDuplicateCount: duplicates.reversedOrientationCount,

    componentCount: components.componentCount,
    components: componentSummaries,
    componentsTruncated: components.componentCount > summaryCount,

    simpleBoundaryLoopCount: boundary.simpleLoopCount,
    openBoundaryChainCount: boundary.openChainCount,
    branchedBoundaryCount: boundary.branchedCount,
    boundaryComponents: boundary.components.map((component): BoundaryComponentSummary => ({
      kind: component.kind,
      edgeCount: component.edgeCount,
      vertexCount: component.vertexCount,
    })),
    boundaryComponentsTruncated: boundary.componentsTruncated,

    totalSurfaceArea: area.total,
    totalSignedVolume: volume.totalSigned,

    isEdgeManifold,
    isVertexManifold,
    isWindingConsistent,
    isBoundaryFree,

    // Stage 2 does not test triangle intersections, and does not infer the
    // answer from topology. A closed manifold surface can still pass through
    // itself.
    selfIntersectionStatus: SelfIntersectionStatus.NotChecked,
    printabilityStatus: hasDefect
      ? PrintabilityStatus.TopologicalDefects
      : PrintabilityStatus.NotFullyDetermined,

    analysisMilliseconds: Date.now() - startedAt,
  };

  reportPhase.report(1);
  throwIfCancelled(cancellation);

  return { report, detail };
}

/**
 * Per-component counters in parallel typed arrays.
 *
 * NOT an array of objects. A mesh of disconnected triangles has one component
 * per face, so a pathological two-million-triangle input would otherwise
 * allocate two million small objects purely to count them — exactly the
 * explosion the bulk-memory rule exists to prevent. Only the BOUNDED summaries
 * returned in the report become objects.
 */
interface ComponentStats {
  readonly faceCount: Uint32Array;
  readonly topologicalVertexCount: Uint32Array;
  readonly edgeCount: Uint32Array;
  readonly boundaryEdgeCount: Uint32Array;
  readonly nonManifoldEdgeCount: Uint32Array;
  readonly nonManifoldVertexCount: Uint32Array;
  readonly windingConflictCount: Uint32Array;
}

function accumulatePerComponent(
  edges: DirectedEdges,
  groups: EdgeGroups,
  edgeAnalysis: ReturnType<typeof analyseEdges>,
  nonManifoldVertex: Uint8Array,
  components: ReturnType<typeof analyseComponents>,
  faceVertices: Uint32Array,
  faceCount: number,
  vertexCount: number,
): ComponentStats {
  const count = components.componentCount;
  const stats: ComponentStats = {
    faceCount: new Uint32Array(count),
    topologicalVertexCount: new Uint32Array(count),
    edgeCount: new Uint32Array(count),
    boundaryEdgeCount: new Uint32Array(count),
    nonManifoldEdgeCount: new Uint32Array(count),
    nonManifoldVertexCount: new Uint32Array(count),
    windingConflictCount: new Uint32Array(count),
  };

  const bump = (array: Uint32Array, index: number): void => {
    array[index] = (array[index] ?? 0) + 1;
  };

  for (let f = 0; f < faceCount; f += 1) {
    bump(stats.faceCount, components.faceComponent[f] ?? 0);
  }

  // A COMPONENT'S VERTEX SET IS THE SET OF VERTICES ITS OWN FACES REFERENCE.
  //
  // There is no owner component and no exclusive assignment. When two
  // face-connected components touch at a point — a bow-tie apex, two shells
  // meeting at one corner — that single global vertex is genuinely a member of
  // BOTH local vertex sets, and each component's χ = V − E + F is only correct
  // if it counts it. The consequence is that per-component vertex counts do NOT
  // sum to the global count, and must not be made to: the global count stays
  // deduplicated, the local sets legitimately overlap.
  //
  // An earlier version assigned each vertex to its lowest-numbered component to
  // force the sums to add up. That produced a wrong Euler characteristic for
  // every component that lost a shared vertex.
  //
  // Counting distinct vertices per component without a Set: faces are grouped by
  // component into a CSR index, then each component is walked in turn with a
  // stamp array recording the component a vertex was last counted for. Because
  // one component is finished before the next begins, "stamp equals current
  // component" is an exact already-counted test.
  const componentStart = new Uint32Array(count + 1);
  for (let f = 0; f < faceCount; f += 1) {
    const slot = (components.faceComponent[f] ?? 0) + 1;
    componentStart[slot] = (componentStart[slot] ?? 0) + 1;
  }
  for (let c = 0; c < count; c += 1) {
    componentStart[c + 1] = (componentStart[c + 1] ?? 0) + (componentStart[c] ?? 0);
  }
  const cursor = Uint32Array.from(componentStart.subarray(0, count));
  const facesByComponent = new Uint32Array(faceCount);
  for (let f = 0; f < faceCount; f += 1) {
    const component = components.faceComponent[f] ?? 0;
    const slot = cursor[component] ?? 0;
    facesByComponent[slot] = f;
    cursor[component] = slot + 1;
  }

  // -1 rather than 0, so component 0 is not mistaken for "already stamped".
  const stamp = new Int32Array(vertexCount).fill(-1);
  for (let c = 0; c < count; c += 1) {
    const from = componentStart[c] ?? 0;
    const to = componentStart[c + 1] ?? 0;
    for (let i = from; i < to; i += 1) {
      const face = facesByComponent[i] ?? 0;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = faceVertices[face * 3 + corner] ?? 0;
        if (stamp[vertex] === c) continue;
        stamp[vertex] = c;
        bump(stats.topologicalVertexCount, c);
        // A vertex is reported non-manifold in every component whose faces
        // touch it — see the note on `nonManifoldVertexCount` in report.ts.
        if (nonManifoldVertex[vertex] === 1) bump(stats.nonManifoldVertexCount, c);
      }
    }
  }

  for (let g = 0; g < groups.uniqueEdgeCount; g += 1) {
    const start = groups.groupStart[g] ?? 0;
    const face = edges.face[groups.order[start] ?? 0] ?? 0;
    const component = components.faceComponent[face] ?? 0;
    bump(stats.edgeCount, component);
    const cls = edgeAnalysis.edgeClass[g];
    if (cls === EdgeClass.Boundary) bump(stats.boundaryEdgeCount, component);
    else if (cls === EdgeClass.NonManifold) bump(stats.nonManifoldEdgeCount, component);
    if (edgeAnalysis.windingConflict[g] === 1) bump(stats.windingConflictCount, component);
  }

  return stats;
}

/**
 * Collects bounded, deterministic samples.
 *
 * Selection is "first N in ascending edge/face index", which is stable across
 * runs and independent of any hash ordering. Exact counts already live in the
 * report; these exist only so the viewport can draw something representative.
 */
function buildDetail(
  edges: DirectedEdges,
  groups: EdgeGroups,
  edgeAnalysis: ReturnType<typeof analyseEdges>,
  degenerateFaces: Uint32Array,
  degenerateTruncated: boolean,
  positions: ArrayLike<number>,
  representative: Uint32Array,
  vertexCount: number,
  sampleLimit: number,
): TopologyDetail {
  const boundary: number[] = [];
  const nonManifold: number[] = [];
  const winding: number[] = [];
  let boundaryTruncated = false;
  let nonManifoldTruncated = false;
  let windingTruncated = false;

  for (let g = 0; g < groups.uniqueEdgeCount; g += 1) {
    const directed = groups.order[groups.groupStart[g] ?? 0] ?? 0;
    const low = edges.low[directed] ?? 0;
    const high = edges.high[directed] ?? 0;
    const cls = edgeAnalysis.edgeClass[g];

    if (cls === EdgeClass.Boundary) {
      if (boundary.length < sampleLimit * 2) boundary.push(low, high);
      else boundaryTruncated = true;
    } else if (cls === EdgeClass.NonManifold) {
      if (nonManifold.length < sampleLimit * 2) nonManifold.push(low, high);
      else nonManifoldTruncated = true;
    }

    if (edgeAnalysis.windingConflict[g] === 1) {
      if (winding.length < sampleLimit * 2) winding.push(low, high);
      else windingTruncated = true;
    }
  }

  // Positions for the vertices the samples actually name, so an overlay can
  // resolve a sampled edge without touching the canonical mesh — and so a clean
  // mesh, which names none, carries no position payload at all.
  //
  // The referenced set is marked in a transient byte per vertex rather than
  // collected into a Set, then read out in ascending id order: deterministic,
  // and the OUTPUT is bounded by the sample limit rather than by mesh size.
  // Float32 because this is render data — the selected WebGL vertex-attribute
  // representation.
  const referenced = new Uint8Array(vertexCount);
  const mark = (id: number): void => {
    if (id < vertexCount) referenced[id] = 1;
  };
  for (const id of boundary) mark(id);
  for (const id of nonManifold) mark(id);
  for (const id of winding) mark(id);

  let referencedCount = 0;
  for (const flag of referenced) referencedCount += flag;

  const sampleVertexIds = new Uint32Array(referencedCount);
  const sampleVertexPositions = new Float32Array(referencedCount * 3);
  let write = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    if (referenced[v] !== 1) continue;
    const base = (representative[v] ?? 0) * 3;
    sampleVertexIds[write] = v;
    sampleVertexPositions[write * 3] = positions[base] ?? 0;
    sampleVertexPositions[write * 3 + 1] = positions[base + 1] ?? 0;
    sampleVertexPositions[write * 3 + 2] = positions[base + 2] ?? 0;
    write += 1;
  }

  return {
    boundaryEdges: Uint32Array.from(boundary),
    boundaryEdgesTruncated: boundaryTruncated,
    nonManifoldEdges: Uint32Array.from(nonManifold),
    nonManifoldEdgesTruncated: nonManifoldTruncated,
    windingConflictEdges: Uint32Array.from(winding),
    windingConflictEdgesTruncated: windingTruncated,
    degenerateFaces,
    degenerateFacesTruncated: degenerateTruncated,
    sampleVertexIds,
    sampleVertexPositions,
    sampleLimit,
  };
}

/** Guards a mesh the analysis cannot meaningfully process. */
export function assertAnalysable(mesh: CanonicalMesh): void {
  if (mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0) {
    throw internalError('Topology analysis received a structurally invalid mesh.', {
      details: { positionLength: mesh.positions.length, indexLength: mesh.indices.length },
    });
  }
}
