import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, IDENTITY_MATRIX4 } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { SELF_INTERSECTION_MAX_FACES, MAX_TESTED_PAIRS } from '@cadfixer/mesh-self-intersection';
import type { ModelHandle, OperationContext } from '@cadfixer/geometry-runtime';
import { AppErrorCode, isAppError, operationCancelled, uncancellable } from '@cadfixer/shared';
import { modelSendForDiagnosticHandler } from './self-intersection-handlers';
import { residentModels } from './stl-handlers';

/**
 * THE PRODUCER SIDE, and the two things it must never get wrong.
 *
 * ONE: it must not damage the authoritative geometry. It builds a copy and
 * TRANSFERS that copy, and transfer detaches — so a single wrong argument here
 * would leave the worker holding empty buffers and the model gone. That is
 * checked byte for byte, not by hashing.
 *
 * TWO: it must refuse an above-ceiling model BEFORE allocating the copy. At a
 * million faces the downstream broadphase allocated ~272 MiB during
 * qualification, which is why the ceiling is a preflight gate.
 */

function context(): OperationContext {
  return {
    cancellation: uncancellable,
    interruptible: false,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (uncancellable.isCancelled) throw operationCancelled();
    },
  };
}

/** A grid mesh as a triangle soup, exactly as the STL reader produces one. */
function soup(faces: number): CanonicalMesh {
  const positions = createPositionArray(faces * 9);
  const indices = createIndexArray(faces * 3);
  for (let f = 0; f < faces; f += 1) {
    const x = f % 64;
    const y = Math.floor(f / 64);
    const base = f * 9;
    positions[base] = x;
    positions[base + 1] = y;
    positions[base + 2] = 0;
    positions[base + 3] = x + 1;
    positions[base + 4] = y;
    positions[base + 5] = 0;
    positions[base + 6] = x;
    positions[base + 7] = y + 1;
    positions[base + 8] = 0;
  }
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  return { positions, indices, metadata: { transform: IDENTITY_MATRIX4 } };
}

/** A port that records what it was given without needing a real MessageChannel. */
function recordingPort(): {
  port: { postMessage(message: unknown, transfer?: unknown[]): void; close(): void };
  sent: { message: unknown; transfer: unknown[] }[];
} {
  const sent: { message: unknown; transfer: unknown[] }[] = [];
  return {
    port: {
      postMessage(message: unknown, transfer?: unknown[]): void {
        sent.push({ message, transfer: transfer ?? [] });
      },
      close(): void {
        // Nothing to release in a stub.
      },
    },
    sent,
  };
}

const limits = {
  maxCandidatePairs: 1_000,
  maxTestedPairs: 1_000,
  maxSamples: 10,
};

describe('the authoritative geometry survives byte for byte', () => {
  it('leaves every position and index byte untouched after sending a copy', async () => {
    const mesh = soup(64);
    const handle: ModelHandle = residentModels.commit(mesh);

    // The literal bytes, captured before the handler runs.
    const positionsBefore = new Uint8Array(mesh.positions.buffer.slice(0) as ArrayBuffer);
    const indicesBefore = new Uint8Array(mesh.indices.buffer.slice(0) as ArrayBuffer);
    const positionsLengthBefore = mesh.positions.length;
    const indicesLengthBefore = mesh.indices.length;

    const { port, sent } = recordingPort();
    await modelSendForDiagnosticHandler({ handle, operationId: 'op-1', port, limits }, context());

    const resolved = residentModels.resolve(handle);
    expect(isAppError(resolved)).toBe(false);
    if (isAppError(resolved)) return;

    // Lengths first: a transferred (detached) buffer reports zero.
    expect(resolved.positions.length).toBe(positionsLengthBefore);
    expect(resolved.indices.length).toBe(indicesLengthBefore);

    // Then every byte. A hash would prove difference, not identity.
    const positionsAfter = new Uint8Array(resolved.positions.buffer as ArrayBuffer);
    const indicesAfter = new Uint8Array(resolved.indices.buffer as ArrayBuffer);
    let differing = 0;
    for (let i = 0; i < positionsBefore.length; i += 1) {
      if (positionsBefore[i] !== positionsAfter[i]) differing += 1;
    }
    for (let i = 0; i < indicesBefore.length; i += 1) {
      if (indicesBefore[i] !== indicesAfter[i]) differing += 1;
    }
    expect(differing).toBe(0);

    // And the copy really was sent, with its OWN buffers in the transfer list.
    expect(sent).toHaveLength(1);
    const transfer = sent[0]?.transfer ?? [];
    expect(transfer).toHaveLength(2);
    expect(transfer).not.toContain(resolved.positions.buffer);
    expect(transfer).not.toContain(resolved.indices.buffer);
  });

  it('sends TOPOLOGICAL vertices, not the raw soup', async () => {
    // Exact identity recovery is the precondition that makes the kernel's
    // fixed-capacity symbolic buffer safe, so the copy must be deduplicated.
    const mesh = soup(64);
    const handle: ModelHandle = residentModels.commit(mesh);
    const { port, sent } = recordingPort();

    const outcome = await modelSendForDiagnosticHandler(
      { handle, operationId: 'op-2', port, limits },
      context(),
    );

    expect(outcome.value.faceCount).toBe(64);
    // 64 soup faces carry 192 corners; shared grid vertices collapse below that.
    expect(outcome.value.vertexCount).toBeLessThan(192);
    const message = sent[0]?.message as { positions: Float64Array; triangles: Uint32Array };
    expect(message.positions).toBeInstanceOf(Float64Array);
    expect(message.triangles).toBeInstanceOf(Uint32Array);
    expect(message.positions.length).toBe(outcome.value.vertexCount * 3);
  });
});

describe('the production ceiling is enforced before anything is copied', () => {
  it('refuses an above-ceiling model without sending geometry', async () => {
    const faces = SELF_INTERSECTION_MAX_FACES + 1;
    // Built directly rather than through `soup`, which would allocate the very
    // memory this test exists to prove is never allocated downstream.
    const mesh: CanonicalMesh = {
      positions: createPositionArray(9),
      indices: createIndexArray(faces * 3),
      metadata: { transform: IDENTITY_MATRIX4 },
    };
    const handle: ModelHandle = residentModels.commit(mesh);
    const { port, sent } = recordingPort();

    const cause = await modelSendForDiagnosticHandler(
      { handle, operationId: 'op-3', port, limits },
      context(),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    if (!isAppError(cause)) return;
    expect(cause.code).toBe(AppErrorCode.InvalidState);
    expect(cause.message).toContain('250,000');
    // NOTHING was sent: no copy, no transfer, no allocation downstream.
    expect(sent).toHaveLength(0);
  });
});

describe('caps may only be narrowed', () => {
  it('clamps a request that asks for more work than the production ceiling', async () => {
    const mesh = soup(4);
    const handle: ModelHandle = residentModels.commit(mesh);
    const { port, sent } = recordingPort();

    await modelSendForDiagnosticHandler(
      {
        handle,
        operationId: 'op-4',
        port,
        limits: { maxCandidatePairs: 1e12, maxTestedPairs: 1e12, maxSamples: 1e9 },
      },
      context(),
    );

    const message = sent[0]?.message as { limits: { maxTestedPairs: number } };
    expect(message.limits.maxTestedPairs).toBe(MAX_TESTED_PAIRS);
  });
});
