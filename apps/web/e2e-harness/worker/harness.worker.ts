import {
  createSelfTestHandler,
  GeometryWorkerHost,
  toTransferables,
  type MessageEndpoint,
  type OperationHandler,
} from '@cadfixer/geometry-runtime';
import { malformedFile } from '@cadfixer/shared';
import { EMPTY_COMPATIBILITY } from '@cadfixer/file-formats';
import { assertGeometryDocument, distinctMeshes } from '@cadfixer/mesh-core';
import {
  commitImportedDocument,
  modelAnalyzeHandler,
  modelExportHandler,
  modelReleaseHandler,
  residentDocuments,
} from '../../src/workers/stl-handlers';
import { modelSendForDiagnosticHandler } from '../../src/workers/self-intersection-handlers';
import {
  holeFillDiscardHandler,
  holeFillListLoopsHandler,
  holeFillSendForFillHandler,
} from '../../src/workers/hole-fill-handlers';
import {
  holeFillBoundaryPreviewHandler,
  holeFillCommitHandler,
  holeFillPatchPreviewHandler,
} from '../../src/workers/hole-fill-workflow-handlers';
import { documentSendForExportHandler } from '../../src/workers/export-handlers';
import {
  repairCommitHandler,
  repairCreateCandidateHandler,
  repairDiscardHandler,
  repairPlanHandler,
  repairUndoHandler,
} from '../../src/workers/repair-handlers';
import { buildHarnessDocument, isHarnessFixtureId } from '../fixtures';

/**
 * THE END-TO-END HARNESS WORKER. Never shipped.
 *
 * It is the production geometry worker with ONE handler swapped: `model/import`
 * builds a synthetic multi-part document instead of parsing STL. Every other
 * operation — analysis, self-intersection, all five repair operations, export,
 * release — is the production handler, imported directly, unmodified.
 *
 * WHY SWAP IMPORT RATHER THAN ADD AN OPERATION. Adding a synthetic-document
 * operation to the production `OperationMap` would put a permanent route into
 * authoritative geometry in the shipped protocol, registered or not. Swapping a
 * handler in a worker entry that no production module imports puts it nowhere at
 * all: `apps/web/src/workers/geometry.worker.ts` still registers the real STL
 * importer, and the production build never reaches this file.
 *
 * WHAT THE PAYLOAD CARRIES, precisely. A fixture IDENTIFIER — the ASCII text
 * `two-independent-parts`, and nothing else. Not geometry, not coordinates, not
 * a serialisation format. There is no encoder, no schema and no reader for
 * anything else, and the production importer would refuse the same bytes as a
 * malformed STL. This is a switch, not a file format.
 */

const workerScope: DedicatedWorkerGlobalScope = self;

const endpoint: MessageEndpoint = {
  postMessage(message, transfer) {
    workerScope.postMessage(message, toTransferables(transfer));
  },
  addMessageListener(listener) {
    const handler = (event: MessageEvent): void => {
      listener(event.data);
    };
    workerScope.addEventListener('message', handler);
    return () => {
      workerScope.removeEventListener('message', handler);
    };
  },
};

/**
 * Builds the named fixture and commits it through the PRODUCTION transaction.
 *
 * `commitImportedDocument` is the same function the STL importer calls: the
 * document gate, the session memory budget, the render snapshot, the part
 * descriptors and the resident commit are all production code. Nothing about
 * how a document becomes authoritative is reimplemented here — if it were, this
 * harness would be evidence about the harness.
 */
const harnessImportHandler: OperationHandler<'model/import'> = (payload, context) => {
  const source = payload.bytes;
  if (!(source instanceof ArrayBuffer)) {
    throw malformedFile('The harness import payload did not contain a transferable buffer.');
  }

  const requested = new TextDecoder().decode(new Uint8Array(source)).trim();
  if (!isHarnessFixtureId(requested)) {
    // Refused with a reason, exactly as an unrecognised file would be. A harness
    // that silently substituted a default fixture would let a typo in a spec
    // pass as evidence about a document nobody asked for.
    throw malformedFile(`Unknown harness fixture: ${requested}`, { requested });
  }

  const document = buildHarnessDocument(requested);

  /*
   * THE MESH GATE, which `commitImportedDocument` deliberately does not repeat.
   * The STL path validates meshes while parsing; a synthetic document has no
   * parser, so it validates them here. Skipping it would make the harness able
   * to commit geometry the product would refuse.
   */
  assertGeometryDocument(document, `harness fixture ${requested}`, { validateMeshes: true });

  context.reportProgress(0.5, 'building fixture');

  return Promise.resolve(
    commitImportedDocument(
      {
        document,
        operation: `harness fixture ${requested}`,
        // Honest: nothing was decoded, so no format was identified and no
        // encoding was detected.
        formatId: 'harness',
        encoding: 'synthetic',
        // The fixture id is all that crossed; the geometry was built in here.
        inputBytes: source.byteLength,
        warnings: [],
        compatibility: EMPTY_COMPATIBILITY,
      },
      context,
    ),
  );
};

const host = new GeometryWorkerHost(endpoint);

host.register('model/import', harnessImportHandler);
host.register('model/export', modelExportHandler);
host.register('model/release', modelReleaseHandler);
host.register('model/analyze', modelAnalyzeHandler);
host.register('model/send-for-diagnostic', modelSendForDiagnosticHandler);
host.register('holefill/list-loops', holeFillListLoopsHandler);
host.register('holefill/send-for-fill', holeFillSendForFillHandler);
host.register('holefill/discard', holeFillDiscardHandler);
host.register('holefill/boundary-preview', holeFillBoundaryPreviewHandler);
host.register('holefill/patch-preview', holeFillPatchPreviewHandler);
host.register('holefill/commit', holeFillCommitHandler);
host.register('document/send-for-export', documentSendForExportHandler);

host.register('repair/plan', repairPlanHandler);
host.register('repair/create-candidate', repairCreateCandidateHandler);
host.register('repair/commit', repairCommitHandler);
host.register('repair/discard', repairDiscardHandler);
host.register('repair/undo', repairUndoHandler);

host.register(
  'runtime/self-test',
  createSelfTestHandler({
    yieldToEventLoop: () =>
      new Promise<void>((resolve) => {
        workerScope.setTimeout(resolve, 0);
      }),
  }),
);

host.start();

/**
 * WORKER-SIDE BYTE OBSERVATION, outside the protocol.
 *
 * A test has to prove authoritative coordinates were not rewritten by a
 * placement or a repair, and the only honest way is to compare the bytes where
 * they live. Transferring canonical arrays to the page to compare them there
 * would make the page an owner of authoritative geometry — the exact inversion
 * ADR 0008 forbids — so the comparison happens here and only a digest and a
 * length cross back.
 *
 * A SEPARATE MESSAGE CHANNEL, not a protocol operation: it is addressed by its
 * own `kind` and is invisible to `GeometryWorkerHost`, so nothing about the
 * production protocol grows a debugging surface.
 */
interface DigestRequest {
  readonly kind: 'harness/digest';
  readonly documentId: string;
  readonly revision: number;
}

function isDigestRequest(value: unknown): value is DigestRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'harness/digest'
  );
}

/** FNV-1a over the raw bytes. Not a security primitive: an equality witness. */
function digestBytes(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

workerScope.addEventListener('message', (event: MessageEvent) => {
  if (!isDigestRequest(event.data)) return;

  const document = residentDocuments.resolve({
    documentId: event.data.documentId as never,
    revision: event.data.revision,
  });
  if (!('parts' in document)) {
    workerScope.postMessage({ kind: 'harness/digest-result', ok: false, parts: [] });
    return;
  }

  const meshIndex = new Map(distinctMeshes(document).map((mesh, index) => [mesh, index]));
  workerScope.postMessage({
    kind: 'harness/digest-result',
    ok: true,
    distinctMeshes: meshIndex.size,
    parts: document.parts.map((part) => ({
      partId: part.id,
      meshResourceIndex: meshIndex.get(part.mesh) ?? -1,
      transform: [...part.transform],
      positionBytes: part.mesh.positions.byteLength,
      indexBytes: part.mesh.indices.byteLength,
      positionDigest: digestBytes(part.mesh.positions),
      indexDigest: digestBytes(part.mesh.indices),
    })),
  });
});
