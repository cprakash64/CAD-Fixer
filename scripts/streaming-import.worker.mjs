/**
 * STAGE 6E — THE WORKER HALF OF THE STREAMING MEMORY QUALIFICATION.
 *
 * NOT PART OF THE APPLICATION AND NEVER BUNDLED INTO IT. `streaming-import
 * .qualify.mjs` bundles this file with Vite into a temporary directory and
 * serves it to a Chromium page of its own, so the measurement runs the REAL
 * reader in a REAL dedicated worker inside a REAL renderer process without
 * adding a single route to the shipped build.
 *
 * It runs the 3MF reader in one of three modes on the bytes it is sent:
 *   buffered-onewrite  v0.2.0's shape: buffered ingestion, and an inflater that
 *                      writes the whole compressed entry in ONE call — kept so
 *                      finding R3 can be measured before and after on the SAME
 *                      reader code;
 *   buffered           Stage 6E-A2's product path: buffered ingestion through
 *                      the production sliced inflater;
 *   stream             Stage 6E-A2's streamed ingestion, the same inflater;
 * then the worker-side steps an import performs before commit — mesh and
 * document gates, the geometry gate, and the non-indexed render expansion —
 * keeping the result resident, as the worker would. Streamed runs report the
 * duration of each pass through the qualification hooks.
 */
import {
  read3mfForQualification,
  ThreeMfIngestion,
} from '../packages/file-formats/src/threemf/threemf-reader.ts';
import { DEFAULT_ZIP_LIMITS } from '../packages/file-formats/src/threemf/zip.ts';
import { createStreamScanStats } from '../packages/file-formats/src/threemf/xml-stream.ts';
import { createSlicedInflater } from '../packages/file-formats/src/threemf/inflate.ts';
import { DEFAULT_IMPORT_BUDGET } from '../packages/file-formats/src/budget.ts';
import {
  assertGeometryDocument,
  assertMeshStructure,
  buildDrawableTriangles,
  distinctMeshes,
  documentTriangleCount,
  measureImportGeometry,
} from '../packages/mesh-core/src/index.ts';
import { checkImportGeometry } from '../packages/geometry-runtime/src/index.ts';
import { CancellationSource, isAppError } from '../packages/shared/src/index.ts';

const openDecompressor = () => {
  const stream = new DecompressionStream('deflate-raw');
  return { readable: { getReader: () => stream.readable.getReader() }, writable: stream.writable };
};

/** v0.2.0's inflater: the whole compressed payload in one write. */
async function* inflateOneWrite(compressed) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
  let failure;
  void writer
    .write(payload)
    .then(() => writer.close())
    .catch((error) => {
      failure = error;
    });
  const reader = stream.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
    if (failure !== undefined) throw failure;
  } finally {
    await Promise.allSettled([reader.cancel()]);
  }
}

const channel = new MessageChannel();
const waiting = [];
channel.port1.onmessage = () => waiting.shift()?.();
const yieldToEventLoop = () =>
  new Promise((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });

self.onmessage = async (event) => {
  const { bytes, mode, sliceBytes, entryLimit, cancelAtFraction } = event.data;
  const source = new CancellationSource();
  const stats = createStreamScanStats();
  const passes = {};
  let bytesSeen = 0;
  let cancelledAtBytes = 0;
  let cancelledAt = 0;
  const declaredTotal = event.data.declaredBytes * 2;
  const context = {
    cancellation: source.token,
    budget: DEFAULT_IMPORT_BUDGET,
    progress: { report: () => undefined },
    yieldToEventLoop,
    decodeText: (input) => new TextDecoder('utf-8', { fatal: false }).decode(input),
    createTextDecoder: () => new TextDecoder('utf-8', { fatal: false }),
    inflateRaw:
      mode === 'buffered-onewrite'
        ? inflateOneWrite
        : createSlicedInflater(openDecompressor, sliceBytes),
  };
  const started = performance.now();
  try {
    const result = await read3mfForQualification(
      new Uint8Array(bytes),
      context,
      {
        zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: entryLimit },
        ingestion: mode === 'stream' ? ThreeMfIngestion.Streaming : ThreeMfIngestion.Buffered,
      },
      {
        stats,
        onPass: (pass, phase) => {
          const key = `pass${String(pass)}`;
          passes[key] = passes[key] ?? { ms: 0 };
          if (phase === 'start') passes[key].startedAt = performance.now();
          else passes[key].ms += performance.now() - passes[key].startedAt;
        },
        onBytes: (_pass, length) => {
          bytesSeen += length;
          if (
            cancelAtFraction !== undefined &&
            cancelledAt === 0 &&
            bytesSeen >= declaredTotal * cancelAtFraction
          ) {
            cancelledAtBytes = bytesSeen;
            cancelledAt = performance.now();
            source.cancel();
          }
        },
      },
    );
    const readMs = performance.now() - started;
    const document = result.document;
    const gatesStarted = performance.now();
    for (const mesh of distinctMeshes(document)) assertMeshStructure(mesh, 'qualify');
    assertGeometryDocument(document, 'qualify', { validateMeshes: false });
    const cost = measureImportGeometry(document);
    const gate = checkImportGeometry(cost);
    const gatesMs = performance.now() - gatesStarted;
    const renderStarted = performance.now();
    const render = distinctMeshes(document).map((mesh) => buildDrawableTriangles(mesh));
    const renderMs = performance.now() - renderStarted;
    // Held on the worker global, as the geometry worker holds a resident document.
    self.cadfixerResident = { document, render };
    self.postMessage({
      ok: true,
      parts: document.parts.length,
      triangles: documentTriangleCount(document),
      readMs,
      pass1Ms: passes.pass1?.ms,
      pass2Ms: passes.pass2?.ms,
      gatesMs,
      renderMs,
      totalMs: performance.now() - started,
      geometryMiB: cost.totalBytes / 1048576,
      gate: gate === undefined ? 'admitted' : `refused ${gate.message}`,
      stats,
    });
  } catch (error) {
    const now = performance.now();
    self.postMessage({
      ok: false,
      code: isAppError(error) ? error.code : 'UNTYPED',
      message: String(error?.message ?? error).slice(0, 200),
      totalMs: now - started,
      cancelTailMs: cancelledAt === 0 ? undefined : now - cancelledAt,
      cancelledAtBytes,
      bytesSeen,
      stats,
    });
  }
};
