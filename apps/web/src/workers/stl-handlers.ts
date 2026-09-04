import {
  diagnostic,
  malformedFile,
  throwIfCancelled,
  type CancellationToken,
  type Diagnostic,
} from '@cadfixer/shared';
import {
  assertGeometryDocument,
  assertMeshStructure,
  computeBounds,
  computeVertexNormals,
  distinctMeshes,
  documentTriangleCount,
  documentVertexCount,
  transformBounds,
  triangleCount,
  unionBounds,
  vertexCount,
  validateMeshStructure,
  MeshValidationSeverity,
  type CanonicalMesh,
  type GeometryDocument,
  type MeshBounds,
  type PartId,
} from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  describeFormat,
  identifyFormat,
  registerBuiltInFormats,
  requireReader,
  requireWriter,
  MeshFormatId,
  type FormatProgressReporter,
  type FormatReadContext,
  type ImportBudget,
  type ImportCompatibility,
} from '@cadfixer/file-formats';
import { analyseTopology, estimateTopologyWorkspaceBytes } from '@cadfixer/mesh-topology';
import {
  RepairCandidateStore,
  RepairHistoryStore,
  TopologyReportCache,
} from '@cadfixer/geometry-runtime';
import {
  checkImportPeak,
  documentByteLength,
  estimateImportPeak,
  isDocument,
  isPart,
  requestAnalysisWorkspace,
  renderBytesFor,
  ResidentDocumentStore,
  type DocumentRenderSnapshot,
  type MeshValidationSummary,
  type DocumentId,
  type HandlerOutcome,
  type OperationContext,
  type OperationHandler,
  type PartDescriptor,
  type PartRenderSnapshot,
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
/**
 * Repair candidates live beside the authoritative models, in the same worker.
 *
 * Separate store, separate handle type: a candidate can never be resolved by an
 * operation that takes a `DocumentHandle`, so export and analysis cannot reach
 * proposed geometry by accident.
 */
export const repairCandidates = new RepairCandidateStore();

/**
 * Undo information for repairs that have already been committed.
 *
 * Held in the worker for the same reason the models are: undo restores
 * AUTHORITATIVE geometry, and the main thread holds none. Exactly one repair per
 * model is reversible — see `repair-history.ts` for why a deeper stack was not
 * built here.
 */
export const repairHistory = new RepairHistoryStore();

/**
 * The latest topology report per resident model.
 *
 * Analysis runs automatically on import and repair is planned from its result,
 * so without this the same unchanged mesh was analysed once to diagnose it,
 * again to plan a repair, and a third time to build a candidate. Keyed by
 * revision, so a report is never reused for geometry it does not describe.
 */
export const topologyReports = new TopologyReportCache();

export const residentDocuments = new ResidentDocumentStore();

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
export function yieldToEventLoop(): Promise<void> {
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
export function buildRenderSnapshot(mesh: CanonicalMesh): RenderSnapshot {
  return {
    positions: mesh.positions.slice(),
    normals: computeVertexNormals(mesh),
    vertexCount: vertexCount(mesh),
  };
}

/**
 * Drawable buffers for a whole document, WITH RENDER GEOMETRY SHARED.
 *
 * Buffers are built once per DISTINCT authoritative mesh and then referenced by
 * every part that uses it. Structured clone preserves object identity across
 * `postMessage`, so two parts that share a mesh here arrive on the main thread
 * still sharing one `Float32Array` — which is what lets the viewport give them
 * one `BufferGeometry` and two object transforms. A thousand placements of one
 * component therefore cost one copy of the geometry, not a thousand.
 *
 * The placement travels beside the buffers and is never baked into them. Baking
 * would make each placement a different buffer and destroy the sharing this
 * function exists to preserve.
 */
export function buildDocumentRenderSnapshot(document: GeometryDocument): DocumentRenderSnapshot {
  const byMesh = new Map<CanonicalMesh, RenderSnapshot>();
  const parts: PartRenderSnapshot[] = [];

  for (const part of document.parts) {
    let snapshot = byMesh.get(part.mesh);
    if (snapshot === undefined) {
      snapshot = buildRenderSnapshot(part.mesh);
      byMesh.set(part.mesh, snapshot);
    }
    parts.push({
      partId: part.id,
      transform: part.transform,
      positions: snapshot.positions,
      normals: snapshot.normals,
      vertexCount: snapshot.vertexCount,
    });
  }

  return { parts };
}

/**
 * The buffers of a document snapshot, deduplicated for a transfer list.
 *
 * Passing one buffer twice throws `DataCloneError`, and shared render geometry
 * guarantees duplicates.
 */
export function documentRenderTransferables(snapshot: DocumentRenderSnapshot): ArrayBufferLike[] {
  const buffers = new Set<ArrayBufferLike>();
  for (const part of snapshot.parts) {
    buffers.add(part.positions.buffer);
    buffers.add(part.normals.buffer);
  }
  return [...buffers];
}

/**
 * Scalar metadata about each part, for the main thread.
 *
 * `meshResourceIndex` is assigned by first appearance of the underlying mesh
 * OBJECT, so two parts sharing geometry report the same index. That is the only
 * way the page — or a test — can observe structural sharing without holding the
 * geometry that is shared.
 */
export function describeParts(document: GeometryDocument): readonly PartDescriptor[] {
  const resourceIndex = new Map<CanonicalMesh, number>();
  const localBounds = boundsPerMesh(document);
  const descriptors: PartDescriptor[] = [];

  for (const part of document.parts) {
    let index = resourceIndex.get(part.mesh);
    if (index === undefined) {
      index = resourceIndex.size;
      resourceIndex.set(part.mesh, index);
    }
    descriptors.push({
      partId: part.id,
      ...(part.name === undefined ? {} : { name: part.name }),
      transform: part.transform,
      triangleCount: triangleCount(part.mesh),
      vertexCount: vertexCount(part.mesh),
      bounds: localBounds.get(part.mesh),
      meshResourceIndex: index,
    });
  }

  return descriptors;
}

/**
 * Each DISTINCT mesh's local box, computed once.
 *
 * MEASURED, NOT ASSUMED. `computeBounds` walks every coordinate, so calling it
 * per PART made a 1,000-placement document walk one shared mesh a thousand
 * times: 356 ms of pure repetition in the document benchmark, for an answer
 * that is identical every time. Local bounds belong to the MESH; only the
 * placement differs, and a placement is applied to the box afterwards.
 */
function boundsPerMesh(document: GeometryDocument): Map<CanonicalMesh, MeshBounds | undefined> {
  const bounds = new Map<CanonicalMesh, MeshBounds | undefined>();
  for (const mesh of distinctMeshes(document)) bounds.set(mesh, computeBounds(mesh));
  return bounds;
}

/**
 * The document's world-space extent.
 *
 * Each part's local box is transformed by its placement and the results are
 * unioned, so a document whose parts sit apart frames all of them. Transforming
 * a box means transforming all eight corners — see `transformBounds`.
 */
export function documentBounds(document: GeometryDocument): MeshBounds | undefined {
  const localBounds = boundsPerMesh(document);
  let bounds: MeshBounds | undefined;
  for (const part of document.parts) {
    const local = localBounds.get(part.mesh);
    if (local === undefined) continue;
    bounds = unionBounds(bounds, transformBounds(local, part.transform));
  }
  return bounds;
}

/**
 * The structural validation summary for a document.
 *
 * Reported per DISTINCT mesh and merged, because that is what was actually
 * validated: a shared mesh is one mesh however many parts place it.
 */
function summariseDocument(document: GeometryDocument): MeshValidationSummary {
  let valid = true;
  let issueCount = 0;
  let warningCount = 0;
  let truncated = false;
  const codes = new Set<string>();

  for (const mesh of distinctMeshes(document)) {
    const summary = summarise(mesh);
    valid = valid && summary.valid;
    issueCount += summary.issueCount;
    warningCount += summary.warningCount;
    truncated = truncated || summary.truncated;
    for (const code of summary.codes) codes.add(code);
  }

  return { valid, issueCount, warningCount, truncated, codes: [...codes] };
}

/**
 * Inflates a raw DEFLATE stream, chunk by chunk.
 *
 * SUPPLIED BY THE WORKER because `DecompressionStream` is a platform primitive
 * and `@cadfixer/file-formats` compiles without DOM or Node types — the same
 * reason `yieldToEventLoop` is injected. Chunked rather than whole-buffer so
 * the ZIP reader can abandon a bomb after the first chunk over budget.
 */
async function* inflateRaw(compressed: Uint8Array): AsyncIterable<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  /*
   * COPIED INTO A PLAIN `ArrayBuffer` VIEW. `compressed` is a subarray of the
   * transferred file buffer, whose type is `ArrayBufferLike` — which may be a
   * `SharedArrayBuffer`, and `WritableStream.write` will not accept one. The
   * copy is one entry's compressed bytes, already bounded by the archive caps.
   */
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
  // Written without awaiting so the reader below can consume as it goes; a
  // rejection here surfaces as the reader ending early.
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch(() => undefined);

  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    // Releases the underlying resources whether the consumer finished or threw
    // — a budget refusal exits this loop through the `finally`.
    await reader.cancel().catch(() => undefined);
  }
}

/** The read context every codec receives. One shape, whatever the format. */
function readContext(
  payload: { readonly budget?: Readonly<Record<string, number>> },
  context: OperationContext,
  from: number,
  to: number,
): FormatReadContext {
  return {
    cancellation: context.cancellation,
    budget: resolveBudget(payload.budget),
    yieldToEventLoop,
    decodeText: (input: Uint8Array): string =>
      new TextDecoder('utf-8', { fatal: false }).decode(input),
    inflateRaw,
    progress: progressReporter(
      (fraction, note) => {
        context.reportProgress(fraction, note);
      },
      from,
      to,
    ),
  };
}

/**
 * IMPORT, FOR EVERY FORMAT.
 *
 * The handler identifies the file from its BYTES, dispatches to the registered
 * reader, validates what came back, and commits it. There is no per-format
 * branching after the dispatch line: every reader produces a
 * `GeometryDocument`, and `commitImportedDocument` is the single place one
 * becomes authoritative — so OBJ and 3MF cannot acquire their own residency
 * rules, their own revision semantics, or their own idea of what validation
 * means.
 *
 * TRANSACTIONAL THROUGHOUT. Identification, parsing, mesh validation, document
 * validation and the memory preflight all happen before the store is touched,
 * so a malformed OBJ or a hostile 3MF leaves the previously resident document
 * exactly as it was.
 */
export const modelImportHandler: OperationHandler<'model/import'> = async (payload, context) => {
  const source = payload.bytes;
  if (!(source instanceof ArrayBuffer)) {
    throw malformedFile('The import payload did not contain a transferable file buffer.');
  }

  const bytes = new Uint8Array(source);
  const cancellation: CancellationToken = context.cancellation;

  /*
   * WHAT IS THIS FILE? Answered once, from the bytes, before any parser runs.
   * A name is user-supplied text and is consulted only to break the OBJ/ASCII-
   * STL ambiguity and to refuse a file whose name and contents disagree.
   */
  context.reportProgress(0, 'identifying');
  const identified = identifyFormat(bytes, payload.fileName);
  throwIfCancelled(cancellation);

  const reader = requireReader(identified.formatId);
  const parsed = await reader.read(bytes, readContext(payload, context, 0.02, PARSE_SHARE));

  throwIfCancelled(cancellation);
  context.reportProgress(PARSE_SHARE, 'validating');

  /*
   * THE MESH GATE. A parser returning geometry is not a successful import;
   * passing structural validation is. Run per DISTINCT mesh, so a document with
   * a thousand placements of one component validates one mesh rather than a
   * thousand.
   */
  const operation = `${describeFormat(identified.formatId).label} import`;
  for (const mesh of distinctMeshes(parsed.document)) {
    assertMeshStructure(mesh, operation);
    throwIfCancelled(cancellation);
  }

  return commitImportedDocument(
    {
      document: parsed.document,
      operation,
      formatId: identified.formatId,
      encoding: parsed.encoding,
      inputBytes: bytes.byteLength,
      warnings: parsed.warnings,
      compatibility: parsed.compatibility,
    },
    context,
  );
};

/** What `commitImportedDocument` needs that it cannot derive from the document. */
export interface DocumentCommitInput {
  /** The candidate. Nothing has been committed for it yet. */
  readonly document: GeometryDocument;
  /** Names the caller in validation failures, e.g. `STL import`. */
  readonly operation: string;
  /** Which format was actually read, as identified from the bytes. */
  readonly formatId: string;
  /** As actually detected. Reported, never guessed. */
  readonly encoding: string;
  /**
   * Size of the source buffer, for the session memory preflight.
   *
   * The input, the outgoing document and the candidate are all live at once
   * during a replacement, which is the moment memory is tightest.
   */
  readonly inputBytes: number;
  readonly warnings: readonly Diagnostic[];
  /** What the reader recognised in the source and did not carry across. */
  readonly compatibility: ImportCompatibility;
}

/**
 * THE IMPORT TRANSACTION, from a candidate document to a committed one.
 *
 * EXTRACTED FROM THE STL HANDLER so there is exactly one implementation of the
 * steps that decide whether a document becomes authoritative: the document
 * gate, the session budget, the render snapshot, and the commit. A second
 * producer of documents — the OBJ and 3MF readers of Stage 4A-2B, and the
 * end-to-end harness that constructs synthetic multi-part documents today —
 * must not reimplement any of it, because a second copy is a second place the
 * gate can be forgotten.
 *
 * Everything above this point is format-specific: reading bytes, detecting an
 * encoding, and validating the MESHES. Everything from here down is not.
 */
export function commitImportedDocument(
  input: DocumentCommitInput,
  context: OperationContext,
): HandlerOutcome<ModelImportResult> {
  const { document } = input;

  /*
   * THE SECOND GATE. Structural mesh validity is not document validity: unique
   * part ids, a finite placement, a recognised unit and the document-wide
   * resource ceilings are questions only this can answer. Meshes are not
   * re-walked — the caller validated them moments ago and walking every
   * coordinate twice on import is exactly the kind of cost a large model cannot
   * absorb.
   */
  assertGeometryDocument(document, input.operation, { validateMeshes: false });

  context.reportProgress(VALIDATE_SHARE, 'preparing');

  // SESSION BUDGET. A format's own budget already cleared the candidate's
  // arrays in isolation; this asks the different question of whether the
  // candidate fits ALONGSIDE what is still resident.
  const residentNow = residentDocuments.stats();
  const documentTriangles = documentTriangleCount(document);
  const peak = estimateImportPeak({
    currentResidentBytes: residentNow.totalBytes,
    currentRenderBytes: renderBytesFor(documentTriangles),
    inputBytes: input.inputBytes,
    candidateTriangles: documentTriangles,
  });
  const overBudget = checkImportPeak(peak);
  if (overBudget) throw overBudget;

  const bounds = documentBounds(document);
  const render = buildDocumentRenderSnapshot(document);

  // TRANSACTIONAL. Nothing above this line touched the store, so a parse
  // failure, a validation failure, a budget rejection, or a cancellation leaves
  // any previously resident document exactly as it was.
  throwIfCancelled(context.cancellation);
  const handle = residentDocuments.commit(document);

  context.reportProgress(1, 'complete');

  const value: ModelImportResult = {
    handle,
    formatId: input.formatId,
    encoding: input.encoding,
    unsupportedFeatures: input.compatibility.unsupported,
    unit: document.unit,
    bounds,
    triangleCount: documentTriangles,
    vertexCount: documentVertexCount(document),
    parts: describeParts(document),
    render,
    warnings: input.warnings,
    validation: summariseDocument(document),
    residentBytes: documentByteLength(document),
  };

  // Only the render snapshots are transferred. The canonical document stays here.
  return { value, transfer: documentRenderTransferables(render) };
}

/**
 * Names the parts an STL export will NOT contain.
 *
 * STL has one implicit part and no way to say otherwise, so exporting part A of
 * a three-part document genuinely loses B and C. Returning that as a warning is
 * the difference between a documented loss and a silent one. Whole-document
 * multi-part export waits for Stage 4A-2B, which can state the loss through a
 * conversion report rather than through a note attached to one file.
 */
function describeOmittedParts(document: GeometryDocument, exported: PartId): readonly Diagnostic[] {
  const omitted = document.parts.filter((part) => part.id !== exported);
  if (omitted.length === 0) return [];
  return [
    diagnostic(
      'STL_EXPORT_SINGLE_PART',
      `STL files hold one object, so this file contains only the selected part. ${String(omitted.length)} other ${omitted.length === 1 ? 'part was' : 'parts were'} not written.`,
      { exportedPartId: exported, omittedPartCount: omitted.length },
    ),
  ];
}

export const modelExportHandler: OperationHandler<'model/export'> = async (payload, context) => {
  // Resolving the handle AND the part is also the staleness check: an export
  // queued against a document that has since been replaced, or naming a part
  // that no longer exists, fails here rather than silently writing out the
  // wrong geometry.
  const document = residentDocuments.resolve(payload.handle);
  if (!isDocument(document)) throw document;

  const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
  if (!isPart(part)) throw part;

  // Export must never produce a file from geometry we would refuse to load.
  assertMeshStructure(part.mesh, 'STL export');
  context.reportProgress(0.02, 'writing');

  const writer = requireWriter(MeshFormatId.Stl);
  const written = await writer.write(part.mesh, {
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
    warnings: [...written.warnings, ...describeOmittedParts(document, part.id)],
  };

  return { value, transfer: [written.bytes.buffer] };
};

export const modelReleaseHandler: OperationHandler<'model/release'> = (payload) => {
  const documentId = payload.documentId as DocumentId;
  const released = residentDocuments.release(documentId);
  // The repair history for a released document describes geometry that no
  // longer exists. Retaining its inverse patch would hold bytes for a repair
  // nothing can reverse, and its reports would describe meshes nothing can
  // resolve.
  repairHistory.releaseDocument(documentId);
  topologyReports.release(documentId);
  const value: ModelReleaseResult = { released };
  return Promise.resolve({ value });
};

export const modelAnalyzeHandler: OperationHandler<'model/analyze'> = async (payload, context) => {
  // Resolving is also the staleness check: an analysis queued against a
  // document that has since been replaced — or naming a part that is not in
  // this revision — fails here rather than quietly producing a report
  // describing different geometry.
  const part = residentDocuments.resolvePart(payload.handle, payload.partId as PartId);
  if (!isPart(part)) throw part;

  const mesh = part.mesh;
  const faceCount = triangleCount(mesh);
  const cornerCount = Math.floor(mesh.positions.length / 3);

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

  const result = analyseTopology(mesh, {
    documentId: payload.handle.documentId,
    documentRevision: payload.handle.revision,
    partId: part.id,
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

  // Retained for the repair workflow, which is planned from a report and would
  // otherwise recompute this one immediately. Stored against the handle AND the
  // part, so it is returned only for the geometry it actually describes.
  topologyReports.set(payload.handle, part.id, result.report);

  const value: ModelAnalyzeResult = {
    // Echoed so a late report can be matched against the document and part the
    // application currently shows, and discarded if either has moved on.
    handle: payload.handle,
    partId: part.id,
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
