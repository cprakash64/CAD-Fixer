/**
 * EXPERIMENTAL candidate worker — Stage 3A-3B.
 *
 * RESEARCH ONLY. Never referenced by the application. One candidate per worker,
 * one WASM instance per worker, and the worker is the unit of cancellation:
 * a synchronous WASM call cannot be interrupted from inside the thread running
 * it, so `Worker.terminate()` from the page is the only cancellation that
 * exists. Everything here is arranged so that terminating is safe.
 *
 * IDENTITY ON EVERY MESSAGE. Each reply carries the `sessionId` the worker was
 * created with and the `opId` of the request that produced it. A terminated
 * worker's last message can still be in flight when its replacement starts, and
 * without identity the page could attribute a dead worker's result to a live
 * operation. That is exactly the class of bug that fabricates evidence, so the
 * page drops anything whose identity does not match.
 *
 * THE WORKER NEVER OWNS AUTHORITATIVE GEOMETRY. It receives a copy, and the
 * page keeps the original. Terminating this worker can therefore lose only
 * derived data.
 */

const GLUE = {
  manifold: { path: '/artifacts/manifold/manifold-candidate.js', prefix: 'cf' },
  geogram: { path: '/artifacts/geogram/geogram-candidate.js', prefix: 'cf_g' },
  pmp: { path: '/artifacts/pmp/pmp-candidate.js', prefix: 'cf_p' },
};

const OPERATIONS = {
  manifold: { ingest: 0, merge: 1, selfUnionInvalid: 2 },
  geogram: {
    repairTopology: 0,
    repairDuplicateFacets: 1,
    repairColocate: 2,
    reorient: 3,
    intersectSurface: 4,
  },
  pmp: { ingest: 0, fillHoles: 1, remesh: 2 },
};

let candidateId = null;
let sessionId = null;
let module = null;
let timings = {};

/** WASM linear memory size. The only memory figure the browser actually exposes. */
function heapBytes() {
  return module === null ? 0 : module.HEAPF64.buffer.byteLength;
}

function post(type, opId, payload, transfer = []) {
  self.postMessage({ type, sessionId, opId, candidateId, ...payload }, transfer);
}

async function initialise(id, session) {
  candidateId = id;
  sessionId = session;
  const glue = GLUE[id];
  if (glue === undefined) throw new Error(`unknown candidate ${String(id)}`);

  // The GLUE fetches its own .wasm, relative to its own URL. Deliberate: it
  // keeps this file free of any network API (they are lint errors repo-wide),
  // and it exercises the real browser instantiation path — streaming compile of
  // the byte-identical artifact whose SHA the manifest records — rather than a
  // preloaded buffer that would not prove browser loading works at all.
  const compileStarted = performance.now();
  const factory = (await import(glue.path)).default;
  const importedAt = performance.now();
  module = await factory();
  const readyAt = performance.now();

  timings = {
    glueImportMs: importedAt - compileStarted,
    wasmInstantiateMs: readyAt - importedAt,
    initialHeapBytes: heapBytes(),
  };

  if (id === 'geogram') {
    // initMode 1: imports the `algo` and `sys` argument groups the colocate
    // path reads. Stage 3A-3A proved omitting them is what aborted Geogram.
    module._cf_g_set_init_mode(1);
  }
}

/** Copies one mesh in, calls one function, copies the result out. */
function runOperation(request) {
  const { operation, parameter = 0, positions, triangles } = request;
  const code = OPERATIONS[candidateId]?.[operation];
  if (code === undefined) return { status: 'UNSUPPORTED_OPERATION' };

  const prefix = GLUE[candidateId].prefix;
  const call = module[`_${prefix}_run`];
  const vertexCount = positions.length / 3;
  const triangleCount = triangles.length / 3;

  const heapBeforeIngest = heapBytes();
  const ingestStarted = performance.now();
  const posPtr = module._malloc(positions.byteLength);
  const triPtr = module._malloc(triangles.byteLength);
  module.HEAPF64.set(positions, posPtr / 8);
  module.HEAPU32.set(triangles, triPtr / 4);
  const ingestMs = performance.now() - ingestStarted;
  const heapAfterIngest = heapBytes();

  const kernelStarted = performance.now();
  const status =
    candidateId === 'manifold'
      ? call(code, posPtr, vertexCount, triPtr, triangleCount)
      : call(code, posPtr, vertexCount, triPtr, triangleCount, parameter);
  const kernelMs = performance.now() - kernelStarted;
  const heapAfterOperation = heapBytes();

  const extractStarted = performance.now();
  const outVertices = module[`_${prefix}_vertex_count`]();
  const outTriangles = module[`_${prefix}_triangle_count`]();
  let outPositions;
  let outIndices;
  if (outVertices > 0 && outTriangles > 0) {
    // Copied, never viewed: memory growth detaches the view, and a detached
    // view handed back would be silently empty rather than loudly wrong.
    outPositions = new Float64Array(
      module.HEAPF64.buffer,
      module[`_${prefix}_positions`](),
      outVertices * 3,
    ).slice();
    outIndices = new Uint32Array(
      module.HEAPU32.buffer,
      module[`_${prefix}_triangles`](),
      outTriangles * 3,
    ).slice();
  }
  const extractMs = performance.now() - extractStarted;
  const heapAfterExtract = heapBytes();

  module._free(posPtr);
  module._free(triPtr);

  const extra = {};
  if (candidateId === 'manifold') {
    extra.kernelReportedSuccess = module._cf_kernel_reported_success() === 1;
    extra.volume = module._cf_volume();
    extra.kernelComponents = module._cf_component_count();
  }
  if (candidateId === 'geogram') extra.moebiusFacets = module._cf_g_moebius_facets();
  if (candidateId === 'pmp') {
    extra.filledHoles = module._cf_p_filled_holes();
    extra.unsupportedInput = status === 10;
  }
  module[`_${prefix}_reset`]();

  return {
    status: 'RAN',
    kernelStatus: status,
    ingestMs,
    kernelMs,
    extractMs,
    heapBeforeIngest,
    heapAfterIngest,
    heapAfterOperation,
    heapAfterExtract,
    outputVertices: outVertices,
    outputTriangles: outTriangles,
    outPositions,
    outIndices,
    ...extra,
  };
}

/** Two-solid boolean. Manifold only; no other candidate exposes one. */
function runBoolean(request) {
  const { opType, a, b } = request;
  const heapBeforeIngest = heapBytes();
  const aPos = module._malloc(a.positions.byteLength);
  const aTri = module._malloc(a.triangles.byteLength);
  const bPos = module._malloc(b.positions.byteLength);
  const bTri = module._malloc(b.triangles.byteLength);
  module.HEAPF64.set(a.positions, aPos / 8);
  module.HEAPU32.set(a.triangles, aTri / 4);
  module.HEAPF64.set(b.positions, bPos / 8);
  module.HEAPU32.set(b.triangles, bTri / 4);
  const heapAfterIngest = heapBytes();

  const kernelStarted = performance.now();
  const status = module._cf_boolean(
    opType,
    aPos,
    a.positions.length / 3,
    aTri,
    a.triangles.length / 3,
    bPos,
    b.positions.length / 3,
    bTri,
    b.triangles.length / 3,
  );
  const kernelMs = performance.now() - kernelStarted;
  const heapAfterOperation = heapBytes();

  const outVertices = module._cf_vertex_count();
  const outTriangles = module._cf_triangle_count();
  let outPositions;
  let outIndices;
  if (outVertices > 0 && outTriangles > 0) {
    outPositions = new Float64Array(
      module.HEAPF64.buffer,
      module._cf_positions(),
      outVertices * 3,
    ).slice();
    outIndices = new Uint32Array(
      module.HEAPU32.buffer,
      module._cf_triangles(),
      outTriangles * 3,
    ).slice();
  }
  const heapAfterExtract = heapBytes();

  module._free(aPos);
  module._free(aTri);
  module._free(bPos);
  module._free(bTri);
  const volume = module._cf_volume();
  const kernelComponents = module._cf_component_count();
  module._cf_reset();

  return {
    status: 'RAN',
    kernelStatus: status,
    kernelMs,
    ingestMs: 0,
    extractMs: 0,
    heapBeforeIngest,
    heapAfterIngest,
    heapAfterOperation,
    heapAfterExtract,
    outputVertices: outVertices,
    outputTriangles: outTriangles,
    outPositions,
    outIndices,
    volume,
    kernelComponents,
    kernelReportedSuccess: module._cf_kernel_reported_success() === 1,
  };
}

self.onmessage = async (event) => {
  const request = event.data;
  const opId = request.opId ?? 0;

  try {
    if (request.type === 'init') {
      await initialise(request.candidateId, request.sessionId);
      post('ready', opId, { timings });
      return;
    }

    // Announced BEFORE the synchronous call. Once the kernel is running, this
    // thread cannot send anything until it returns — so the page's only proof
    // that real work started is a message sent just before it.
    post('started', opId, { at: performance.now() });

    const result = request.type === 'boolean' ? runBoolean(request) : runOperation(request);

    const transfer = [];
    if (result.outPositions !== undefined) transfer.push(result.outPositions.buffer);
    if (result.outIndices !== undefined) transfer.push(result.outIndices.buffer);
    post('result', opId, { result }, transfer);
  } catch (cause) {
    // Reported, never swallowed. An abort inside WASM arrives here as a throw,
    // and it is evidence about the candidate.
    post('failed', opId, { message: String(cause).slice(0, 500) });
  }
};
