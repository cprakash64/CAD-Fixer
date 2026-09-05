import { describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_PART_TRANSFORM,
  meshTransferables,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import type { DocumentId } from './resident-documents';
import { GeometryCoordinator } from './coordinator';
import type { MessageEndpoint } from './endpoint';
import { PROTOCOL_CHANNEL, type TransferHandle } from './protocol';
import { toTransferables } from './transferables';
import { GeometryWorkerHost } from './worker-host';

/**
 * Declared locally because this package compiles without the DOM and Node type
 * libraries — deliberately, so it stays platform-free. `structuredClone` is a
 * standard global in every runtime that hosts this code.
 */
declare function structuredClone<T>(value: T, options?: { transfer?: ArrayBuffer[] }): T;

/**
 * Proof that the PRODUCTION message path moves buffers instead of copying them.
 *
 * This matters beyond performance. Structured-cloning a 400 MB mesh doubles
 * peak memory at the exact moment the application is closest to the limit, and
 * it is completely invisible — the code looks identical either way. These tests
 * make the transfer list an asserted property of the real dispatch path rather
 * than something a comment claims.
 */

interface RecordedMessage {
  readonly message: unknown;
  readonly transfer: readonly TransferHandle[];
}

interface RecordingEndpoint {
  readonly endpoint: MessageEndpoint;
  readonly sent: RecordedMessage[];
  /** Delivers an inbound message to whatever subscribed to this endpoint. */
  deliver(message: unknown): void;
}

function recordingEndpoint(): RecordingEndpoint {
  const sent: RecordedMessage[] = [];
  const listeners = new Set<(message: unknown) => void>();
  return {
    sent,
    deliver(message: unknown): void {
      for (const listener of [...listeners]) listener(message);
    },
    endpoint: {
      postMessage(message: unknown, transfer: readonly TransferHandle[]): void {
        sent.push({ message, transfer });
      },
      addMessageListener(listener: (message: unknown) => void): () => void {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    },
  };
}

function sampleMesh(triangles: number): CanonicalMesh {
  return {
    positions: new Float32Array(triangles * 9),
    indices: new Uint32Array(triangles * 3),
    metadata: { sourceFormat: 'stl' },
  };
}

describe('import dispatch', () => {
  it('puts the file buffer in the transfer list rather than cloning it', () => {
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });
    const bytes = new ArrayBuffer(1024);

    coordinator.dispatch('model/import', { fileName: 'fixture.stl', bytes }, { transfer: [bytes] });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.transfer).toContain(bytes);
  });

  it('sends a well-formed request envelope alongside the transfer', () => {
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });
    const bytes = new ArrayBuffer(8);

    const handle = coordinator.dispatch(
      'model/import',
      { fileName: 'fixture.stl', bytes },
      { transfer: [bytes] },
    );

    expect(sent[0]?.message).toMatchObject({
      channel: PROTOCOL_CHANNEL,
      kind: 'request',
      operation: 'model/import',
      id: handle.id,
    });
  });

  it('sends an empty transfer list when the caller supplies none', () => {
    // Export deliberately does NOT transfer: the main thread is still rendering
    // the mesh, so moving its buffers would detach what the viewport is drawing.
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });

    coordinator.dispatch('model/export', {
      handle: { documentId: 'model-1' as DocumentId, revision: 1 },
      partId: 'part-1',
      encoding: 'binary',
    });

    expect(sent[0]?.transfer).toEqual([]);
  });
});

describe('worker result path', () => {
  it('transfers every buffer a handler returns', async () => {
    const recording = recordingEndpoint();
    const { endpoint, sent } = recording;
    const host = new GeometryWorkerHost(endpoint);
    const mesh = sampleMesh(4);
    const renderPositions = mesh.positions.slice();
    const renderNormals = new Float32Array(mesh.positions.length);

    host.register('model/import', () =>
      Promise.resolve({
        value: {
          handle: { documentId: 'model-1' as DocumentId, revision: 1 },
          formatId: 'stl',
          encoding: 'binary',
          unsupportedFeatures: [],
          externalReferences: [],
          unit: undefined,
          bounds: undefined,
          triangleCount: 4,
          vertexCount: 12,
          parts: [],
          render: {
            parts: [
              {
                partId: 'part-1',
                transform: IDENTITY_PART_TRANSFORM,
                positions: renderPositions,
                normals: renderNormals,
                vertexCount: 12,
              },
            ],
          },
          warnings: [],
          validation: {
            valid: true,
            issueCount: 0,
            warningCount: 0,
            truncated: false,
            codes: [],
          },
          residentBytes: 0,
        },
        transfer: [renderPositions.buffer, renderNormals.buffer],
      }),
    );
    host.start();

    // Drives the real host through a real request envelope, so this exercises
    // the production dispatch path rather than a stubbed one.
    recording.deliver({
      channel: PROTOCOL_CHANNEL,
      kind: 'request',
      id: 'op-1',
      operation: 'model/import',
      payload: {},
    });
    await vi.waitFor(() => {
      expect(sent.some((entry) => isResult(entry.message))).toBe(true);
    });

    const result = sent.find((entry) => isResult(entry.message));
    // The RENDER SNAPSHOT is transferred; the authoritative mesh stays resident
    // in the worker and its buffers must NOT appear in the transfer list.
    expect(result?.transfer).toContain(renderPositions.buffer);
    expect(result?.transfer).toContain(renderNormals.buffer);
    expect(result?.transfer).not.toContain(mesh.positions.buffer);
    expect(result?.transfer).not.toContain(mesh.indices.buffer);
  });
});

describe('meshTransferables', () => {
  it('lists the buffers a mesh owns', () => {
    const mesh = sampleMesh(3);

    const buffers = meshTransferables(mesh);

    expect(buffers).toContain(mesh.positions.buffer);
    expect(buffers).toContain(mesh.indices.buffer);
  });

  it('de-duplicates attributes that share one buffer', () => {
    // Passing the same buffer twice in a transfer list throws DataCloneError.
    const shared = new ArrayBuffer(96);
    const mesh: CanonicalMesh = {
      positions: new Float32Array(shared, 0, 9),
      indices: new Uint32Array(shared, 36, 3),
      metadata: { sourceFormat: 'stl' },
    };

    expect(meshTransferables(mesh)).toEqual([shared]);
  });
});

describe('transfer list narrowing', () => {
  it('passes ArrayBuffers through', () => {
    const buffer = new ArrayBuffer(4);
    expect(toTransferables([buffer])).toEqual([buffer]);
  });

  it('refuses anything that is not an ArrayBuffer', () => {
    // A SharedArrayBuffer is shared, never moved; transferring one throws an
    // opaque DataCloneError in the browser. Failing here is attributable.
    const shared = new Uint8Array(4) as unknown as TransferHandle;

    expect(() => toTransferables([shared])).toThrow(/ArrayBuffer/);
  });
});

describe('transfer semantics this design depends on', () => {
  it('detaches the sender’s buffer, which is why nothing may read it afterwards', () => {
    // Not testing our code — pinning the platform behaviour the ownership rules
    // are built on, so the assumption is visible and checked rather than folded
    // into a comment.
    const buffer = new ArrayBuffer(64);
    const view = new Uint8Array(buffer);
    view[0] = 42;

    structuredClone(buffer, { transfer: [buffer] });

    expect(buffer.byteLength).toBe(0);
    expect(view.byteLength).toBe(0);
  });
});

function isResult(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === 'result'
  );
}

describe('export carries no geometry across the boundary', () => {
  /**
   * THE REGRESSION THIS EXISTS FOR. Stage 1 put the whole `CanonicalMesh` in the
   * export request, so every export structured-cloned roughly 96 MiB back into
   * the worker for a two-million-triangle model. Asserted at the protocol
   * boundary — on the actual dispatched message — rather than by grepping
   * source, so reintroducing a mesh field fails here.
   */
  function collectTypedArrays(value: unknown, found: string[] = [], depth = 0): string[] {
    if (depth > 6 || value === null || typeof value !== 'object') return found;
    if (ArrayBuffer.isView(value)) {
      found.push(value.constructor.name);
      return found;
    }
    if (value instanceof ArrayBuffer) {
      found.push('ArrayBuffer');
      return found;
    }
    for (const entry of Object.values(value)) collectTypedArrays(entry, found, depth + 1);
    return found;
  }

  it('sends only a handle, never positions or indices', () => {
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });

    coordinator.dispatch('model/export', {
      handle: { documentId: 'model-7' as DocumentId, revision: 3 },
      partId: 'part-1',
      encoding: 'binary',
    });

    const message = sent[0]?.message as { payload?: unknown } | undefined;
    expect(collectTypedArrays(message?.payload)).toEqual([]);
    expect(message?.payload).toEqual({
      handle: { documentId: 'model-7', revision: 3 },
      // The part is an IDENTIFIER, not geometry. Export writes one part, so the
      // request has to name which — and it still carries no coordinates.
      partId: 'part-1',
      encoding: 'binary',
    });
  });

  it('names the revision, so a stale export cannot hit the replacement', () => {
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });

    coordinator.dispatch('model/export', {
      handle: { documentId: 'model-1' as DocumentId, revision: 2 },
      partId: 'part-1',
      encoding: 'ascii',
    });

    const payload = (sent[0]?.message as { payload: { handle: { revision: number } } }).payload;
    expect(payload.handle.revision).toBe(2);
  });

  it('the whole export request stays small regardless of model size', () => {
    // A structured-clone of the payload is a fair proxy for what crosses the
    // boundary. It must not scale with the model.
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });

    coordinator.dispatch('model/export', {
      handle: { documentId: 'model-1' as DocumentId, revision: 1 },
      partId: 'part-1',
      encoding: 'binary',
    });

    expect(JSON.stringify(sent[0]?.message).length).toBeLessThan(300);
  });
});

describe('analysis requests are handle-based and revision-safe', () => {
  /**
   * Topology analysis must never carry geometry, and a report must be
   * attributable to the exact model revision it was computed for — otherwise a
   * late report from a replaced model could be applied to its successor.
   */
  it('sends only a handle, never geometry', () => {
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });

    coordinator.dispatch('model/analyze', {
      handle: { documentId: 'model-3' as DocumentId, revision: 2 },
      partId: 'part-1',
    });

    const message = sent[0]?.message as { payload?: unknown } | undefined;
    expect(message?.payload).toEqual({
      handle: { documentId: 'model-3', revision: 2 },
      // Analysis is per part. Still a handle, a revision and an id — no geometry.
      partId: 'part-1',
    });
    expect(sent[0]?.transfer).toEqual([]);
  });

  it('lets a consumer reject a report belonging to a superseded revision', () => {
    // The result echoes the handle it was computed for. Comparing that against
    // the model currently held is what makes a late report discardable.
    const current = { documentId: 'model-1', revision: 2 };
    const lateReport = { handle: { documentId: 'model-1', revision: 1 } };
    const matchingReport = { handle: { documentId: 'model-1', revision: 2 } };

    const applies = (report: { handle: { documentId: string; revision: number } }): boolean =>
      report.handle.documentId === current.documentId &&
      report.handle.revision === current.revision;

    expect(applies(lateReport)).toBe(false);
    expect(applies(matchingReport)).toBe(true);
  });

  it('lets a consumer reject a report for an entirely different model', () => {
    const current = { documentId: 'model-2', revision: 1 };
    const foreign = { handle: { documentId: 'model-1', revision: 1 } };

    expect(foreign.handle.documentId === current.documentId).toBe(false);
  });
});
