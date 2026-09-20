import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { read3mf, ThreeMfIngestion } from '../packages/file-formats/src/threemf/threemf-reader';
import { testReadContext } from '../packages/file-formats/src/test-context';
import {
  buildZip,
  CONTENT_TYPES,
  RELS,
  TETRAHEDRON_MESH,
} from '../packages/file-formats/src/threemf/zip-fixtures';

/**
 * STAGE 6E-A2, FINDING R1 — THE DECODED MODEL PART MUST NOT OUTLIVE THE IMPORT.
 *
 * Stage 6E-A1 found the buffered reader keeping the whole decoded XML of the
 * last imported model part reachable after the import returned: V8 represents a
 * substring of 13 or more characters as a view of its parent, and two things
 * kept such a view alive —
 *
 *   1. the engine's regular-expression last-match state, holding the subject of
 *      the last successful match (an attribute list, a slice of the document)
 *      until any other match succeeds anywhere in the worker;
 *   2. a document string kept from an attribute — an object name of 13 or more
 *      characters is enough.
 *
 * These tests MEASURE THE HEAP rather than trusting a description of V8's string
 * representation. Each builds a model part of about 24 MiB whose geometry is a
 * tetrahedron, so anything near the part's size still reachable after a full
 * collection is the part itself. Before the fix both measured the whole part:
 * ~24 MiB one-byte, twice that when the text held a character above U+00FF.
 *
 * WHY IN `scripts/`. `@cadfixer/file-formats` compiles without Node types on
 * purpose; a heap measurement needs `node:v8` and `node:vm`, which the tooling
 * project has.
 */

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

function heapUsed(): number {
  collect();
  collect();
  return process.memoryUsage().heapUsed;
}

const MIB = 1024 * 1024;
const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/** ~24 MiB of text-heavy XML around one tetrahedron, with a LONG object name. */
function largeModel(extra: string): string {
  const filler: string[] = [];
  let seed = 0x6e2a;
  for (let n = 0; n < 200_000; n += 1) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    filler.push(
      `<metadata name="note${String(n)}">${seed.toString(36)} ${extra} ${(seed >>> 3).toString(36)}</metadata>`,
      `<!-- ${seed.toString(16)} padding padding padding padding padding padding -->`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="${CORE}">${filler.join('')}` +
    `<resources><object id="1" type="model" name="A deliberately long object name ${extra}">` +
    `${TETRAHEDRON_MESH}</object></resources><build><item objectid="1"/></build></model>`
  );
}

async function packageOf(model: string): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
    { name: '_rels/.rels', content: RELS, method: 8 },
    { name: '3D/3dmodel.model', content: model, method: 8 },
  ]);
}

/**
 * EVERY MODE, INCLUDING THE ONE THE PRODUCT REGISTERS — Stage 6E-A3, A3-R20.
 *
 * `auto` routes by size, and these parts are ~24 MiB, so `auto` resolves to the
 * BUFFERED path here. That is exactly why it belongs in the list: the buffered
 * path is the one the retention fix guards, it is the path the product still
 * takes for everything below the threshold, and a regression in it would
 * otherwise only be visible through a mode the product no longer uses.
 */
const MODES = [
  ThreeMfIngestion.Buffered,
  ThreeMfIngestion.Streaming,
  ThreeMfIngestion.Auto,
] as const;

describe('R1: no decoded model part is retained after an import', () => {
  for (const ingestion of MODES) {
    for (const [label, extra] of [
      ['ASCII', 'plain'],
      ['with CJK text', '模型'],
    ] as const) {
      it(`${ingestion}, ${label}: nothing near the part's size survives, document kept or dropped`, async () => {
        const model = largeModel(extra);
        expect(model.length).toBeGreaterThan(20 * MIB);
        const bytes = await packageOf(model);

        const before = heapUsed();
        // Held through an object so the test can DROP it: the resident store
        // holds a document by reference, and releases it the same way.
        const held: { result?: Awaited<ReturnType<typeof read3mf>> } = {
          result: await read3mf(bytes, testReadContext(), { ingestion }),
        };
        // The document is still held here, as the resident store holds it: a
        // kept object name must not keep the part alive.
        const withDocument = heapUsed() - before;
        expect(held.result?.document.parts[0]?.name).toContain('long object name');

        delete held.result;
        // Dropped: nothing — in particular no engine match state — may hold it.
        const withoutDocument = heapUsed() - before;

        expect(withDocument / MIB, 'retained with the document held').toBeLessThan(4);
        expect(withoutDocument / MIB, 'retained after the document is dropped').toBeLessThan(4);
      });
    }
  }

  for (const ingestion of MODES) {
    it(`${ingestion}: a REFUSED import leaves nothing of the part behind`, async () => {
      // Malformed at the very end, so the whole part is scanned — and matched
      // against — before the refusal.
      const bytes = await packageOf(`${largeModel('plain')}<broken`);
      const before = heapUsed();
      await expect(read3mf(bytes, testReadContext(), { ingestion })).rejects.toThrow(
        /malformed XML/,
      );
      expect((heapUsed() - before) / MIB, 'retained after the refusal').toBeLessThan(4);
    });
  }
});
