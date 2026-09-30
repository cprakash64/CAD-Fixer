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
