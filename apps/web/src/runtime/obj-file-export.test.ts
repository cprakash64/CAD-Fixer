import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM, partId } from '@cadfixer/mesh-core';
import { MeshFormatId, exportSnapshotOf, writeObjDocument } from '@cadfixer/file-formats';
import { testWriteContext } from '../../../../packages/file-formats/src/export/test-context';
import { exportObjToFile } from '../workers/obj-file-export';
import { transferableExportChunk } from '../workers/export-chunk';

const snapshot = exportSnapshotOf(
  {
    parts: [
      {
        id: partId('one'),
        name: '🧱'.repeat(200),
        transform: IDENTITY_PART_TRANSFORM,
        mesh: {
          positions: new Float32Array([-0, 1e-30, 2, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
          metadata: { sourceFormat: MeshFormatId.Obj },
        },
      },
    ],
  },
  'file',
  1,
);

describe('direct OBJ stream validation and transferable ownership', () => {
  it('validates all bytes and counts detached buffers across Unicode seams', async () => {
    const received: Uint8Array[] = [];
    const phases: number[] = [];
    const result = await exportObjToFile(
      snapshot,
      (bytes) => {
        const buffer = transferableExportChunk(bytes);
        expect(buffer.byteLength).toBeLessThanOrEqual(512);
        const delivered = structuredClone(buffer, { transfer: [buffer] });
        expect(buffer.byteLength).toBe(0);
        received.push(new Uint8Array(delivered));
        return Promise.resolve();
      },
      (fraction) => {
        phases.push(fraction);
      },
      () => Promise.resolve(),
      512,
    );
    const output = new Uint8Array(received.reduce((sum, bytes) => sum + bytes.byteLength, 0));
    let at = 0;
    for (const bytes of received) {
      output.set(bytes, at);
      at += bytes.byteLength;
    }
    expect(output).toEqual((await writeObjDocument(snapshot, testWriteContext())).bytes);
    expect(result.outputBytes).toBe(output.byteLength);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
  });
  it('bounds transferred outstanding bytes while a slow sink blocks each ACK', async () => {
    const large = {
      ...snapshot,
      meshes: snapshot.meshes.map((mesh) => ({
        ...mesh,
        indices: new Uint32Array(Array.from({ length: 120_000 }, (_, i) => i % 3)),
      })),
    };
    const chunkBytes = 256 * 1024;
    let writes = 0;
    let outstanding = 0;
    let maximum = 0;
    let total = 0;
    let release: (() => void) | undefined;
    const state = { complete: false };
    const run = exportObjToFile(
      large,
      async (bytes) => {
        const buffer = transferableExportChunk(bytes);
        const delivered = structuredClone(buffer, { transfer: [buffer] });
        expect(buffer.byteLength).toBe(0);
        writes += 1;
        outstanding += delivered.byteLength;
        maximum = Math.max(maximum, outstanding);
        expect(outstanding).toBeLessThanOrEqual(chunkBytes);
        total += delivered.byteLength;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        outstanding -= delivered.byteLength;
      },
      () => undefined,
      () => Promise.resolve(),
      chunkBytes,
    ).then((metadata) => {
      state.complete = true;
      return metadata;
    });
    while (!state.complete) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const count = writes;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(writes).toBe(count);
      const ack = release;
      release = undefined;
      ack?.();
    }
    const metadata = await run;
    expect(writes).toBeGreaterThan(1);
    expect(total).toBeGreaterThan(chunkBytes);
    expect(metadata.outputBytes).toBe(total);
    expect(maximum).toBeLessThanOrEqual(chunkBytes);
    expect(outstanding).toBe(0);
  });
  it('rejects a malformed serialized coordinate and never reports an artifact', async () => {
    const bad = {
      ...snapshot,
      meshes: snapshot.meshes.map((mesh) => ({
        ...mesh,
        positions: new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]),
      })),
    };
    const notes: string[] = [];
    await expect(
      exportObjToFile(
        bad,
        () => Promise.resolve(),
        (_fraction, note) => {
          notes.push(note);
        },
        () => Promise.resolve(),
        512,
      ),
    ).rejects.toThrow();
    expect(notes).not.toContain('saving');
  });
});
