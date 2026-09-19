/**
 * STAGE 6E-A1 — THE WORKER HALF OF THE STREAMING MEMORY PROTOTYPE.
 *
 * NOT PART OF THE APPLICATION AND NEVER BUNDLED INTO IT. `streaming-import
 * .qualify.mjs` bundles this file with Vite into a temporary directory and
 * serves it to a Chromium page of its own, so the measurement runs the REAL
 * reader in a REAL dedicated worker inside a REAL renderer process — the
 * environment Stage 6D-B3's ~2.1 GiB figure was measured in — without adding a
 * single route to the shipped build.
 *
 * It runs `read3mf` in one of two modes on the bytes it is sent:
 *   whole   today's path: `readZipEntry` + `decodeText` + `scanXml`;
 *   stream  the Stage 6E-A1 prototype: `streamZipEntry` + `scanXmlByteStream`,
 *           fed by a slice-fed inflater;
 * and then the worker-side steps an import performs before commit — mesh and
 * document gates, the Stage 6D-R3 geometry gate, and the non-indexed render
 * expansion — and keeps the result resident, as the worker would.
 */
import { read3mf } from '../packages/file-formats/src/threemf/threemf-reader.ts';
import { DEFAULT_ZIP_LIMITS } from '../packages/file-formats/src/threemf/zip.ts';
import { createStreamScanStats } from '../packages/file-formats/src/threemf/xml-stream.ts';
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

/** Today's inflater: the whole compressed payload in one write. */
async function* inflateWhole(compressed) {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
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
    await reader.cancel().catch(() => undefined);
  }
}

/** The streaming prototype's inflater: bounded input slices under backpressure. */
function inflateSliced(sliceBytes) {
  return async function* (compressed) {
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const pump = (async () => {
      for (let at = 0; at < compressed.byteLength; at += sliceBytes) {
        await writer.write(compressed.slice(at, at + sliceBytes));
      }
      await writer.close();
    })();
    pump.catch(() => undefined);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  };
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
    inflateRaw: inflateWhole,
  };
  const started = performance.now();
  try {
    const result = await read3mf(new Uint8Array(bytes), context, {
      zipLimits: { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: entryLimit },
      ...(mode === 'stream'
        ? {
            ingestion: {
              inflateRaw: inflateSliced(sliceBytes),
              createDecoder: () => new TextDecoder('utf-8', { fatal: false }),
              yieldEveryPieces: 16,
              stats,
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
          }
        : {}),
    });
    const readMs = performance.now() - started;
    const document = result.document;
    for (const mesh of distinctMeshes(document)) assertMeshStructure(mesh, 'qualify');
    assertGeometryDocument(document, 'qualify', { validateMeshes: false });
    const cost = measureImportGeometry(document);
    const gate = checkImportGeometry(cost);
    const render = distinctMeshes(document).map((mesh) => buildDrawableTriangles(mesh));
    // Held on the worker global, as the geometry worker holds a resident document.
    self.cadfixerResident = { document, render };
    self.postMessage({
      ok: true,
      parts: document.parts.length,
      triangles: documentTriangleCount(document),
      readMs,
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
