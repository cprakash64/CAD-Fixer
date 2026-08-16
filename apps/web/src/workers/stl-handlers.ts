import { malformedFile, throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import {
  assertMeshStructure,
  computeBounds,
  computeVertexNormals,
  triangleCount,
  vertexCount,
  validateMeshStructure,
  MeshValidationSeverity,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  readStl,
  registerBuiltInFormats,
  requireWriter,
  MeshFormatId,
  type FormatProgressReporter,
  type ImportBudget,
} from '@cadfixer/file-formats';
import { analyseTopology, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  checkImportPeak,
  estimateImportPeak,
  requestAnalysisWorkspace,
  meshByteLength,
  renderBytesFor,
  ResidentModelStore,
  type MeshValidationSummary,
  type ModelId,
  type OperationHandler,
  type RenderSnapshot,
  type StlExportResult,
  type ModelImportResult,
  type ModelAnalyzeResult,
  type ModelReleaseResult,
} from '@cadfixer/geometry-runtime';

/**
 * Worker-side handlers for the resident model operations.
 *
 * These are adapters, not geometry code. Everything substantive — detection,
 * parsing, limits, writing — lives in `@cadfixer/file-formats` and is tested
 * under plain Node. What happens here is translating the worker protocol's
 * `OperationContext` into the format layer's context, running the validation
 * gate, and managing residency.
 */

registerBuiltInFormats();

/**
 * The authoritative geometry for this worker.
 *
 * Module-scoped because there is one worker and one store. It is exported for
 * tests, which is also the only way to assert residency behaviour without a
 * browser.
 */
export const residentModels = new ResidentModelStore();

/**
 * Returns control to the worker's event loop.
 *
 * A `MessageChannel` round-trip rather than `setTimeout(0)`: browsers clamp
 * nested timeouts to about 4 ms, and a parse that yields once per batch would
 * pay that clamp on every batch — hundreds of milliseconds of pure waiting on a
 * large model. A message task is not clamped.
 *
 * This is what makes cancellation real. The cancel message is queued behind the
 * running handler; yielding is the only thing that lets the worker read it.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * Phase boundaries within a single import, so the progress bar reflects the
 * work actually remaining rather than restarting at each stage.
 */
const PARSE_SHARE = 0.8;
const VALIDATE_SHARE = 0.9;

function progressReporter(
  report: (fraction: number, note?: string) => void,
  from: number,
  to: number,
): FormatProgressReporter {
  return {
    report(fraction: number, note?: string): void {
      const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
      report(from + clamped * (to - from), note);
    },
  };
}

/**
 * Applies caller-supplied limit overrides.
 *
 * Overrides may only LOWER a limit. Raising one over the wire would let a
 * message decide how much memory the worker is allowed to commit, which is
 * exactly the decision the budget exists to take away from untrusted input.
 */
function resolveBudget(overrides: Readonly<Record<string, number>> | undefined): ImportBudget {
  if (overrides === undefined) return DEFAULT_IMPORT_BUDGET;

  const lower = (key: keyof ImportBudget): number => {
    const proposed = overrides[key];
    const current = DEFAULT_IMPORT_BUDGET[key];
    if (proposed === undefined || !Number.isFinite(proposed) || proposed < 0) return current;
    return Math.min(current, proposed);
  };

  // Built field by field rather than by spreading and casting. A cast here
  // would let a renamed or removed budget field pass silently; this way the
  // compiler checks that every limit is accounted for.
  return {
    maxInputBytes: lower('maxInputBytes'),
    maxTriangles: lower('maxTriangles'),
    maxVertices: lower('maxVertices'),
    maxOutputBytes: lower('maxOutputBytes'),
    maxEstimatedPeakBytes: lower('maxEstimatedPeakBytes'),
    maxTokenBytes: lower('maxTokenBytes'),
  };
}

function summarise(mesh: CanonicalMesh): MeshValidationSummary {
  const report = validateMeshStructure(mesh);
  const errors = report.issues.filter(
    (issue) => issue.severity === MeshValidationSeverity.Error,
  ).length;
  return {
    valid: report.valid,
    issueCount: errors,
    warningCount: report.issues.length - errors,
    truncated: report.truncated,
    codes: [...new Set(report.issues.map((issue) => issue.code))],
  };
}

/**
 * Builds the buffers the UI needs to draw, from geometry that stays here.
 *
 * Positions are COPIED rather than transferred: the worker keeps the
 * authoritative array, so handing the original to the main thread would detach
 * it and leave the resident model unusable. That copy is the price of worker-
 * side ownership, and it is accounted for in docs/PERFORMANCE_BASELINE.md.
 *
 * Indices are not sent at all — STL soup indices are 0,1,2,3,… and the GPU
 * assumes exactly that for a non-indexed draw.
 */
function buildRenderSnapshot(mesh: CanonicalMesh): RenderSnapshot {
  return {
    positions: mesh.positions.slice(),
    normals: computeVertexNormals(mesh),
    vertexCount: vertexCount(mesh),
  };
}

export const modelImportHandler: OperationHandler<'model/import'> = async (payload, context) => {
  const source = payload.bytes;
  if (!(source instanceof ArrayBuffer)) {
    throw malformedFile('The import payload did not contain a transferable file buffer.');
  }

  const bytes = new Uint8Array(source);
  const cancellation: CancellationToken = context.cancellation;

  const parsed = await readStl(bytes, {
    cancellation,
    budget: resolveBudget(payload.budget),
    yieldToEventLoop,
    progress: progressReporter(
      (fraction, note) => {
        context.reportProgress(fraction, note);
      },
      0,
      PARSE_SHARE,
    ),
  });

  throwIfCancelled(cancellation);
  context.reportProgress(PARSE_SHARE, 'validating');

  // THE GATE. A parser returning a mesh is not a successful import; passing
  // structural validation is. This throws GEOMETRY_VALIDATION_FAILED otherwise,
  // and nothing is committed.
  assertMeshStructure(parsed.mesh, 'STL import');

  context.reportProgress(VALIDATE_SHARE, 'preparing');

  // SESSION BUDGET. The parser's own budget already cleared the candidate's
  // arrays in isolation; this asks the different question of whether the
  // candidate fits ALONGSIDE what is still resident. During a transactional
  // replacement the outgoing model, the input buffer and the candidate are all
  // live at once, and that is the moment memory is tightest.
  const residentNow = residentModels.stats();
  const peak = estimateImportPeak({
    currentResidentBytes: residentNow.totalBytes,
    currentRenderBytes: renderBytesFor(triangleCount(parsed.mesh)),
    inputBytes: bytes.byteLength,
    candidateTriangles: triangleCount(parsed.mesh),
  });
  const overBudget = checkImportPeak(peak);
  if (overBudget) throw overBudget;

  const bounds = computeBounds(parsed.mesh);
  const render = buildRenderSnapshot(parsed.mesh);

  // TRANSACTIONAL. Nothing above this line touched the store, so a parse
  // failure, a validation failure, a budget rejection, or a cancellation leaves
  // any previously resident model exactly as it was. The commit is the last
  // thing that happens, and only on complete success.
  throwIfCancelled(cancellation);
  const handle = residentModels.commit(parsed.mesh);

  context.reportProgress(1, 'complete');

  const value: ModelImportResult = {
    handle,
    encoding: parsed.encoding,
    unit: parsed.mesh.metadata.unit,
    bounds,
    triangleCount: triangleCount(parsed.mesh),
    vertexCount: vertexCount(parsed.mesh),
    render,
    warnings: parsed.warnings,
    validation: summarise(parsed.mesh),
    residentBytes: meshByteLength(parsed.mesh),
  };

  // Only the render snapshot is transferred. The canonical mesh stays here.
  return {
    value,
    transfer: [render.positions.buffer, render.normals.buffer],
  };
};

export const modelExportHandler: OperationHandler<'model/export'> = async (payload, context) => {
  // Resolving the handle is also the staleness check: an export queued against
  // a model that has since been replaced fails here rather than silently
  // writing out the wrong geometry.
  const resolved = residentModels.resolve(payload.handle);
  if (!isMesh(resolved)) throw resolved;

  // Export must never produce a file from geometry we would refuse to load.
  assertMeshStructure(resolved, 'STL export');
  context.reportProgress(0.02, 'writing');

  const writer = requireWriter(MeshFormatId.Stl);
  const written = await writer.write(resolved, {
    cancellation: context.cancellation,
    budget: DEFAULT_IMPORT_BUDGET,
    encoding: payload.encoding,
    yieldToEventLoop,
    progress: progressReporter(
      (fraction, note) => {
        context.reportProgress(fraction, note);
      },
      0.02,
      1,
    ),
  });

  const value: StlExportResult = {
    bytes: written.bytes.buffer,
    byteLength: written.bytes.byteLength,
    encoding: payload.encoding,
    warnings: written.warnings,
  };

  return { value, transfer: [written.bytes.buffer] };
};

export const modelReleaseHandler: OperationHandler<'model/release'> = (payload) => {
  const released = residentModels.release(payload.modelId as ModelId);
  const value: ModelReleaseResult = { released };
  return Promise.resolve({ value });
};

/** Narrows the store's union return without an assertion. */
function isMesh(value: CanonicalMesh | { code: string }): value is CanonicalMesh {
  return 'positions' in value;
}

export const modelAnalyzeHandler: OperationHandler<'model/analyze'> = async (payload, context) => {
  // Resolving is also the staleness check: an analysis queued against a model
  // that has since been replaced fails here rather than quietly producing a
  // report describing different geometry.
  const resolved = residentModels.resolve(payload.handle);
  if (!isMesh(resolved)) throw resolved;

  const faceCount = triangleCount(resolved);
  const cornerCount = Math.floor(resolved.positions.length / 3);

  // MEMORY PREFLIGHT. Topology scratch runs several times the size of the mesh,
  // so the estimate is checked BEFORE any bulk array is allocated. Refusing
  // with a typed error beats an out-of-memory crash that takes the tab with it.
  const workspaceBytes = estimateTopologyWorkspaceBytes(faceCount, cornerCount);
  const refusal = requestAnalysisWorkspace('model/analyze', workspaceBytes, {
    faceCount,
    cornerCount,
  });
  if (refusal) throw refusal;

  context.reportProgress(0, 'analyzing');

  const result = analyseTopology(resolved, {
    modelId: payload.handle.modelId,
    modelRevision: payload.handle.revision,
    cancellation: context.cancellation,
    ...(payload.sampleLimit === undefined ? {} : { sampleLimit: payload.sampleLimit }),
    onProgress: (progress) => {
      context.reportProgress(progress.fraction, progress.phase);
    },
  });

  // Yield once before returning so a cancel queued during the synchronous
  // analysis is still observed rather than being overtaken by the result.
  await yieldToEventLoop();
  throwIfCancelled(context.cancellation);

  const value: ModelAnalyzeResult = {
    // Echoed so a late report can be matched against the model the application
    // currently holds, and discarded if it has moved on.
    handle: payload.handle,
    report: result.report,
    detail: result.detail,
  };

  return {
    value,
    transfer: [
      result.detail.boundaryEdges.buffer,
      result.detail.nonManifoldEdges.buffer,
      result.detail.windingConflictEdges.buffer,
      result.detail.degenerateFaces.buffer,
      result.detail.sampleVertexIds.buffer,
      result.detail.sampleVertexPositions.buffer,
    ],
  };
};
