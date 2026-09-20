import { describe, expect, it } from 'vitest';
import { formatBytes, formatBytesAgainst, isAppError } from '@cadfixer/shared';
import { ImportRefusal, refusalOf } from '../import-errors';
import { testReadContext } from '../test-context';
import {
  routeModelEntryIngestion,
  ThreeMfIngestion,
  THREEMF_STREAMING_THRESHOLD_BYTES,
} from './ingestion-route';
import { MAX_THREEMF_MODEL_ENTRY_BYTES, MAX_THREEMF_PACKAGE_BYTES } from './size-limits';
import { read3mf, read3mfForQualification, type ThreeMfRouteDecision } from './threemf-reader';
import { DEFAULT_ZIP_LIMITS, readZipDirectory } from './zip';
import { buildZip, CONTENT_TYPES, modelXml, RELS } from './zip-fixtures';

/**
 * STAGE 6E-A4 — THE RAISED PER-ENTRY CEILING, AT ITS EDGES.
 *
 * A4 moved the ceiling from 256 MiB to 384 MiB because streaming stopped the
 * entry from being the thing that bounds the peak. What must not move with it:
 * WHERE eligibility is decided (the ZIP directory, before anything is opened),
 * WHAT decides it (the declared size, checked against the ratio and the package
 * budget too), and the fact that a declaration is a claim rather than a fact.
 *
 * THESE USE LIED DECLARATIONS ON PURPOSE. Eligibility is settled at the
 * directory from the declared size alone, so the boundary can be put under oath
 * exactly — at the ceiling, one byte over, one byte under — without building a
 * 384 MiB archive. What a real entry of that size costs is a memory question,
 * measured in `docs/design/STAGE_6E_STREAMING_3MF_IMPORT.md`, not a semantic one.
 */

/** Deterministic filler that barely compresses, so the RATIO never fires first. */
function filler(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let seed = 0x6e_a4;
  for (let at = 0; at < length; at += 1) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    out[at] = (seed >>> 16) & 0xff;
  }
  return out;
}

/**
 * An archive whose model entry DECLARES `declared` bytes while really holding
 * about a hundredth of that — enough compressed data to stay inside 200:1.
 */
async function declaring(declared: number): Promise<Uint8Array> {
  return buildZip([
    { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
    { name: '_rels/.rels', method: 8, content: RELS },
    {
      name: '3D/3dmodel.model',
      method: 8,
      content: filler(Math.ceil(declared / 100)),
      declaredUncompressedSize: declared,
    },
  ]);
}

interface Refusal {
  readonly code: string;
  readonly reason: unknown;
  readonly message: string;
}

async function refusalOfRead(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, reason: refusalOf(error), message: error.message };
  }
  throw new Error('expected a refusal');
}

async function routesOf(archive: Uint8Array): Promise<ThreeMfRouteDecision[]> {
  const routes: ThreeMfRouteDecision[] = [];
  await read3mfForQualification(
    archive,
    testReadContext(),
    { ingestion: ThreeMfIngestion.Auto },
    {
      onRoute: (decision) => {
        routes.push(decision);
      },
    },
  ).catch(() => undefined);
  return routes;
}

describe('6E-A4: the per-entry ceiling, at its edges', () => {
  it('A4-L02: an entry declaring EXACTLY the ceiling is eligible, and is streamed', async () => {
    /*
     * The check is `>`, not `>=`, and A4 did not change that. Eligibility is
     * shown by the entry being OPENED — it is refused afterwards for what it
     * contains, never for its size — and by the route being chosen at all.
     */
    const archive = await declaring(MAX_THREEMF_MODEL_ENTRY_BYTES);
    const entries = readZipDirectory(archive);
    expect(entries.some((entry) => entry.name === '3D/3dmodel.model')).toBe(true);

    const routes = await routesOf(archive);
    expect(routes.map((route) => route.route)).toEqual([ThreeMfIngestion.Streaming]);
    expect(routes[0]?.declaredUncompressedBytes).toBe(MAX_THREEMF_MODEL_ENTRY_BYTES);

    const refusal = await refusalOfRead(() => read3mf(archive, testReadContext()));
    expect(refusal.reason).not.toBe(ImportRefusal.ZipEntryTooLarge);
  });

  it('A4-L03: one byte past the ceiling is refused, before anything is opened', async () => {
    const archive = await declaring(MAX_THREEMF_MODEL_ENTRY_BYTES + 1);
    for (const ingestion of [
      ThreeMfIngestion.Auto,
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
    ]) {
      const refusal = await refusalOfRead(() => read3mf(archive, testReadContext(), { ingestion }));
      expect(refusal.reason, ingestion).toBe(ImportRefusal.ZipEntryTooLarge);
      expect(refusal.code, ingestion).toBe('RESOURCE_LIMIT_EXCEEDED');
    }
    // NOT ROUTED AND NOT OPENED: the directory settles it.
    expect(await routesOf(archive)).toEqual([]);
  });

  it('A4-L03: the refusal names the size and the ceiling, and they cannot read as equal', async () => {
    /*
     * IEC units, both numbers, and DISTINGUISHABLE. A value just past the
     * ceiling rounds to the SAME string as the ceiling, so the sentence used to
     * read "expands to 320 MiB; ... limit is 320 MiB" — true, and indefensible
     * to the person whose file was refused. See `formatBytesAgainst`.
     *
     * DERIVED FROM THE CEILING, so it keeps testing this whatever the ceiling
     * becomes: `justOver` is chosen to round identically under `formatBytes`,
     * and the assertion is that the message distinguishes them anyway.
     */
    const ceiling = formatBytes(MAX_THREEMF_MODEL_ENTRY_BYTES);
    const justOver = MAX_THREEMF_MODEL_ENTRY_BYTES + 51_504;
    expect(formatBytes(justOver), 'the fixture must collide, or this proves nothing').toBe(ceiling);

    const archive = await declaring(justOver);
    const refusal = await refusalOfRead(() => read3mf(archive, testReadContext()));
    expect(refusal.message).toContain(`CAD Fixer's per-entry expansion limit is ${ceiling}`);
    expect(refusal.message).toContain(
      `expands to ${formatBytesAgainst(justOver, MAX_THREEMF_MODEL_ENTRY_BYTES)}`,
    );
    expect(refusal.message).not.toContain(`expands to ${ceiling};`);
  });

  it('A4-L12: the 200:1 ratio is unchanged and still fires before the ceiling', async () => {
    /*
     * RAISING THE CEILING MUST NOT WIDEN WHAT A BOMB MAY CLAIM. An entry
     * declaring the ceiling from almost no compressed data is refused for the
     * RATIO, at the directory, whatever the ceiling happens to be.
     */
    expect(DEFAULT_ZIP_LIMITS.maxCompressionRatio).toBe(200);
    const bomb = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      {
        name: '3D/3dmodel.model',
        method: 8,
        content: filler(1024),
        declaredUncompressedSize: MAX_THREEMF_MODEL_ENTRY_BYTES,
      },
    ]);
    const refusal = await refusalOfRead(() => read3mf(bomb, testReadContext()));
    expect(refusal.reason).toBe(ImportRefusal.ZipRatioExceeded);
    expect(await routesOf(bomb)).toEqual([]);
  });

  it('A4-L11: the package ceiling still binds two entries that are each eligible', async () => {
    /*
     * TWO PARTS AT THE ENTRY CEILING EXCEED THE PACKAGE CEILING, and the
     * package ceiling is what refuses them. This is the relationship A4 left
     * alone: the per-entry number moved, the package total did not, so a
     * package can no longer hold two maximum-sized parts.
     */
    expect(MAX_THREEMF_MODEL_ENTRY_BYTES * 2).toBeGreaterThan(MAX_THREEMF_PACKAGE_BYTES);
    const each = MAX_THREEMF_MODEL_ENTRY_BYTES;
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      {
        name: '3D/3dmodel.model',
        method: 8,
        content: filler(Math.ceil(each / 100)),
        declaredUncompressedSize: each,
      },
      {
        name: '3D/Objects/second.model',
        method: 8,
        content: filler(Math.ceil(each / 100)),
        declaredUncompressedSize: each,
      },
    ]);
    const refusal = await refusalOfRead(() =>
      Promise.resolve(readZipDirectory(archive, DEFAULT_ZIP_LIMITS)),
    );
    expect(refusal.reason).toBe(ImportRefusal.ZipTotalTooLarge);
  });

  it('A4-L13: a declaration cannot lie its way across the ceiling in either direction', async () => {
    /*
     * BOTH DIRECTIONS OF THE ATTACK, now that the declaration decides
     * eligibility AND the route. Declaring UNDER the ceiling and holding more:
     * the overrun check bounds the read by the declaration. Declaring OVER it:
     * refused at the directory, whatever the content would have been.
     */
    const under = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      {
        name: '3D/3dmodel.model',
        method: 8,
        content: modelXml({ unit: 'millimeter' }) + ' '.repeat(200_000),
        declaredUncompressedSize: 4096,
      },
    ]);
    const overrun = await refusalOfRead(() => read3mf(under, testReadContext()));
    expect(overrun.reason).toBe(ImportRefusal.ZipDeclaredSizeOverrun);
    // Routed BUFFERED on its lie, and refused on the same lie.
    expect((await routesOf(under)).map((route) => route.route)).toEqual([
      ThreeMfIngestion.Buffered,
    ]);

    const over = await declaring(MAX_THREEMF_MODEL_ENTRY_BYTES + 1);
    expect((await refusalOfRead(() => read3mf(over, testReadContext()))).reason).toBe(
      ImportRefusal.ZipEntryTooLarge,
    );
  });

  it('the whole band between the routing threshold and the ceiling is streamed', () => {
    // A4 widened the STREAMED band rather than adding a third mode: everything
    // from 128 MiB to 384 MiB inclusive takes the streamed path.
    for (const bytes of [
      THREEMF_STREAMING_THRESHOLD_BYTES,
      256 * 1024 * 1024,
      297 * 1024 * 1024,
      MAX_THREEMF_MODEL_ENTRY_BYTES,
    ]) {
      expect(routeModelEntryIngestion(bytes, ThreeMfIngestion.Auto)).toBe(
        ThreeMfIngestion.Streaming,
      );
    }
  });
});
