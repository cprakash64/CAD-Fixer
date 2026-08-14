import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_MATRIX4, meshTransferables, type CanonicalMesh } from '@cadfixer/mesh-core';
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
    metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
  };
}

describe('import dispatch', () => {
  it('puts the file buffer in the transfer list rather than cloning it', () => {
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });
    const bytes = new ArrayBuffer(1024);

    coordinator.dispatch('stl/import', { bytes }, { transfer: [bytes] });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.transfer).toContain(bytes);
  });

  it('sends a well-formed request envelope alongside the transfer', () => {
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });
    const bytes = new ArrayBuffer(8);

    const handle = coordinator.dispatch('stl/import', { bytes }, { transfer: [bytes] });

    expect(sent[0]?.message).toMatchObject({
      channel: PROTOCOL_CHANNEL,
      kind: 'request',
      operation: 'stl/import',
      id: handle.id,
    });
  });

  it('sends an empty transfer list when the caller supplies none', () => {
    // Export deliberately does NOT transfer: the main thread is still rendering
    // the mesh, so moving its buffers would detach what the viewport is drawing.
    const { endpoint, sent } = recordingEndpoint();
    const coordinator = new GeometryCoordinator(endpoint, { onDiagnostic: vi.fn() });

    coordinator.dispatch('stl/export', { mesh: sampleMesh(2), encoding: 'binary' });

    expect(sent[0]?.transfer).toEqual([]);
  });
});

describe('worker result path', () => {
  it('transfers every buffer a handler returns', async () => {
    const recording = recordingEndpoint();
    const { endpoint, sent } = recording;
    const host = new GeometryWorkerHost(endpoint);
    const mesh = sampleMesh(4);
    const renderNormals = new Float32Array(mesh.positions.length);

    host.register('stl/import', () =>
      Promise.resolve({
        value: {
          mesh,
          encoding: 'binary',
          bounds: undefined,
          triangleCount: 4,
          vertexCount: 12,
          renderNormals,
          warnings: [],
          validation: {
            valid: true,
            issueCount: 0,
            warningCount: 0,
            truncated: false,
            codes: [],
          },
        },
        transfer: [...meshTransferables(mesh), renderNormals.buffer],
      }),
    );
    host.start();

    // Drives the real host through a real request envelope, so this exercises
    // the production dispatch path rather than a stubbed one.
    recording.deliver({
      channel: PROTOCOL_CHANNEL,
      kind: 'request',
      id: 'op-1',
      operation: 'stl/import',
      payload: {},
    });
    await vi.waitFor(() => {
      expect(sent.some((entry) => isResult(entry.message))).toBe(true);
    });

    const result = sent.find((entry) => isResult(entry.message));
    expect(result?.transfer).toContain(mesh.positions.buffer);
    expect(result?.transfer).toContain(mesh.indices.buffer);
    expect(result?.transfer).toContain(renderNormals.buffer);
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
      metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
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
