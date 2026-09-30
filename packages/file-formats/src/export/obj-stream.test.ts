import { describe, expect, it } from 'vitest';
import { CancellationSource, uncancellable } from '@cadfixer/shared';
import { IDENTITY_PART_TRANSFORM, partId, type GeometryDocument } from '@cadfixer/mesh-core';
import { MeshFormatId } from '../formats';
import { exportSnapshotOf } from './export-contract';
import { createChunkTextWriter } from './stream-sink';
import { objNeedsFileSink } from './obj-routing';
import { serializeObjDocument, writeObjDocument } from './obj-writer';
import { validateObjRecordStream } from './obj-stream-validation';
import { testWriteContext, testExportReadContext, encodeUtf8 } from './test-context';

const mesh = {
  positions: new Float32Array([-0, 1e-30, 3, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 2, 0, 1]),
  groups: [{ name: 'café 🧱', materialRef: 'paint', indexOffset: 0, indexCount: 3 }],
  metadata: { sourceFormat: MeshFormatId.Obj },
};
const document: GeometryDocument = {
  parts: [
    { id: partId('a'), name: 'one', mesh, transform: IDENTITY_PART_TRANSFORM },
    { id: partId('b'), name: 'two', mesh, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, -8, 10] },
  ],
};
const snapshot = exportSnapshotOf(document, 'test', 2);
async function* pieces(text: string, width: number): AsyncIterable<string> {
  for (let at = 0; at < text.length; at += width)
    yield await Promise.resolve(text.slice(at, at + width));
}

describe('bounded OBJ storage and production-record validation', () => {
  it.each([64, 256, 1024, 4096])('preserves exact bytes at %i-byte boundaries', async (size) => {
    const chunks: Uint8Array[] = [];
    const writer = createChunkTextWriter(
      {
        write: (bytes): Promise<void> => {
          chunks.push(bytes.slice());
          return Promise.resolve();
        },
      },
      encodeUtf8,
      1_000_000,
      uncancellable,
      size,
    );
    await serializeObjDocument(snapshot, testWriteContext(), writer);
    await writer.finish();
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(size);
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe(
      new TextDecoder().decode((await writeObjDocument(snapshot, testWriteContext())).bytes),
    );
    // Character boundaries, including CRLF and UTF-16 surrogate seams, are invisible.
    await validateObjRecordStream(snapshot, pieces(text, 1), testExportReadContext());
  });
  it('checks every coordinate, corner, name, group and final count independently', async () => {
    const text = new TextDecoder().decode(
      (await writeObjDocument(snapshot, testWriteContext())).bytes,
    );
    for (const broken of [
      text.replace('v -0', 'v 4'),
      text.replace('f 1 2 3', 'f 1 3 2'),
      text.replace('o one', 'o wrong'),
      text.replace('g café', 'g wrong'),
      text.replace('usemtl paint', 'usemtl other'),
      text.slice(0, text.lastIndexOf('f ')),
    ]) {
      await expect(
        validateObjRecordStream(snapshot, pieces(broken, 13), testExportReadContext()),
      ).rejects.toThrow();
    }
  });
  it('preserves adjacent equal group boundaries rather than merging them', async () => {
    const grouped = {
      ...mesh,
      groups: [
        { name: 'same', indexOffset: 0, indexCount: 3 },
        { name: 'same', indexOffset: 3, indexCount: 3 },
      ],
    };
    const expected = exportSnapshotOf(
      { parts: [{ id: partId('groups'), mesh: grouped, transform: IDENTITY_PART_TRANSFORM }] },
      'groups',
      1,
    );
    const text = new TextDecoder().decode(
      (await writeObjDocument(expected, testWriteContext())).bytes,
    );
    await validateObjRecordStream(expected, pieces(text, 19), testExportReadContext());
    const last = text.lastIndexOf('g same\n');
    await expect(
      validateObjRecordStream(
        expected,
        pieces(text.slice(0, last) + text.slice(last + 7), 19),
        testExportReadContext(),
      ),
    ).rejects.toThrow();
  });
  it('applies backpressure and rejects reuse while the sink is blocked', async () => {
    let release: (() => void) | undefined;
    let writes = 0;
    const writer = createChunkTextWriter(
      {
        write: (): Promise<void> => {
          writes += 1;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      },
      encodeUtf8,
      1000,
      uncancellable,
      64,
    );
    await writer.write('x'.repeat(64));
    const blocked = writer.write('second');
    expect(writes).toBe(1);
    expect(() => writer.write('third')).toThrow();
    release?.();
    await blocked;
    expect(writes).toBe(1);
  });
  it('propagates disk errors and cancellation without another write', async () => {
    const cancellation = new CancellationSource();
    let writes = 0;
    const writer = createChunkTextWriter(
      {
        write: (): Promise<void> => {
          writes += 1;
          cancellation.cancel();
          return Promise.resolve();
        },
      },
      encodeUtf8,
      1000,
      cancellation.token,
      64,
    );
    await writer.write('x'.repeat(64));
    await expect(writer.write('next')).rejects.toThrow();
    expect(writes).toBe(1);
    const broken = createChunkTextWriter(
      {
        write: (): Promise<void> => Promise.reject(new Error('disk full')),
      },
      encodeUtf8,
      1000,
      uncancellable,
      64,
    );
    await broken.write('v 0 0 0\n');
    await expect(broken.finish()).rejects.toThrow('disk full');
  });
  it('keeps the existing output ceiling authoritative, including Unicode bytes', async () => {
    const writer = createChunkTextWriter(
      { write: (): Promise<void> => Promise.resolve() },
      encodeUtf8,
      2,
      uncancellable,
      64,
    );
    await writer.write('🧱');
    await expect(writer.finish()).rejects.toThrow();
  });
  it('routes 10k/100k soups to memory and 250k+ to file storage', () => {
    for (const triangles of [10_000, 100_000, 250_000, 500_000, 1_000_000, 1_988_877]) {
      expect(
        objNeedsFileSink([{ vertexCount: triangles * 3, triangleCount: triangles, groupCount: 0 }]),
      ).toBe(triangles > 100_000);
    }
  });
});
