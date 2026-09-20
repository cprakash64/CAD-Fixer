import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, type CancellationToken } from '@cadfixer/shared';
import { documentTriangleCount, type CanonicalMesh } from '@cadfixer/mesh-core';
import { ImportRefusal, refusalOf } from '../import-errors';
import { testReadContext } from '../test-context';
import {
  routeModelEntryIngestion,
  ThreeMfIngestion,
  THREEMF_STREAMING_THRESHOLD_BYTES,
} from './ingestion-route';
import type { DocumentReadResult } from '../document-reader';
import { read3mf, read3mfForQualification, type ThreeMfRouteDecision } from './threemf-reader';
import { DEFAULT_ZIP_LIMITS } from './zip';
import { buildZip, CONTENT_TYPES, modelXml, RELS, TETRAHEDRON_MESH } from './zip-fixtures';

/**
 * STAGE 6E-A3 — AUTOMATIC PER-ENTRY INGESTION ROUTING.
 *
 * A2 shipped a streamed reader switched off because the two paths are not
 * ordered: streaming is dramatically cheaper for a large model part and
 * slightly more expensive for a small one. A3 routes each entry by its DECLARED
 * uncompressed size, which is the only figure known before a byte is
 * decompressed.
 *
 * WHAT THESE TESTS HAVE TO ESTABLISH, and what they deliberately do not:
 *
 *   - The DECISION, exactly, at the boundary. That is a pure function, so it is
 *     tested as one rather than inferred from a 160 MiB fixture.
 *   - The WIRING: that the reader asks the question once per model entry and
 *     honours the answer, including when the answers differ within one package.
 *   - That routing changes NOTHING ELSE — not eligibility, not the package
 *     budget, not the ratio, not a refusal, not a document.
 *
 * THE LARGE FIXTURES ARE STORED, NOT DEFLATED. A stored entry's declared size
 * IS its length, so it costs nothing to build and cannot lie; the entries that
 * lie are deflated, because lying is precisely what a deflated entry can do.
 * Only entries at or above the threshold are built at size, and those STREAM —
 * so no test here holds a threshold-sized entry in a buffer twice.
 */

const THRESHOLD = THREEMF_STREAMING_THRESHOLD_BYTES;

interface RoutedRead {
  readonly routes: readonly ThreeMfRouteDecision[];
  readonly triangles: number;
  readonly parts: number;
}

/** Reads a package under a mode and records every routing decision. */
async function readRouted(
  archive: Uint8Array,
  mode: ThreeMfIngestion,
  cancellation?: CancellationToken,
): Promise<RoutedRead> {
  const routes: ThreeMfRouteDecision[] = [];
  const result = await read3mfForQualification(
    archive,
    testReadContext(cancellation === undefined ? {} : { cancellation }),
    { ingestion: mode },
    {
      onRoute: (decision) => {
        routes.push(decision);
      },
    },
  );
  return {
    routes,
    triangles: documentTriangleCount(result.document),
    parts: result.document.parts.length,
  };
}

/** Every routing decision a read makes, whether or not the read succeeds. */
async function routesOf(
  archive: Uint8Array,
  mode: ThreeMfIngestion,
): Promise<ThreeMfRouteDecision[]> {
  const routes: ThreeMfRouteDecision[] = [];
  await read3mfForQualification(
    archive,
    testReadContext(),
    { ingestion: mode },
    {
      onRoute: (decision) => {
        routes.push(decision);
      },
    },
  ).catch(() => undefined);
  return routes;
}

interface Refusal {
  readonly code: string;
  readonly reason: unknown;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

async function refusalOfRead(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: error.code,
      reason: refusalOf(error),
      message: error.message,
      details: error.details,
    };
  }
  throw new Error('expected a refusal');
}

/**
 * A model part padded with INSIGNIFICANT WHITESPACE to exactly `bytes`.
 *
 * Whitespace between elements is the one filler that is valid XML, costs a
 * single `repeat` to produce, and means the same thing to both scanners — the
 * buffered one skips it looking for `<`, the streamed one never delivers text
 * at all. The padding sits between `</resources>` and `<build>`, inside the
 * document rather than in its prolog, so it is scanned rather than skipped as
 * preamble.
 */
function paddedModel(bytes: number, objectId = 1): string {
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    `<resources><object id="${String(objectId)}" type="model">${TETRAHEDRON_MESH}</object></resources>`;
  const tail = `<build><item objectid="${String(objectId)}"/></build></model>`;
  const padding = bytes - head.length - tail.length;
  if (padding < 0) throw new Error('paddedModel asked for fewer bytes than the model needs');
  return head + ' '.repeat(padding) + tail;
}

/**
 * Deterministic filler that barely compresses.
 *
 * A DECLARATION CANNOT BE MADE ARBITRARILY LARGE: the compression ratio is
 * checked against it at the directory, so an entry whose content deflates to
 * almost nothing cannot claim to hold much. A test that wants the SHORTFALL
 * check rather than the ratio check has to supply content the deflater cannot
 * shrink, which is what this produces.
 */
function filler(length: number): string {
  let seed = 0x6e_a3;
  let out = '';
  while (out.length < length) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    out += seed.toString(36);
  }
  return out.slice(0, length);
}

const PRODUCTION_NS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

/** A production-extension root that places one object out of each named part. */
function productionRoot(children: readonly string[], ownObject: boolean): string {
  const items = children.map((path) => `<item objectid="1" p:path="/${path}"/>`).join('');
  const own = ownObject
    ? `<resources><object id="9" type="model">${TETRAHEDRON_MESH}</object></resources>`
    : '<resources/>';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
    `xmlns:p="${PRODUCTION_NS}" requiredextensions="p">` +
    `${own}<build>${ownObject ? '<item objectid="9"/>' : ''}${items}</build></model>`
  );
}

/* ============================================================ the decision */

describe('6E-A3: the routing decision', () => {
  it('A3-R01/R02/R03: the threshold is inclusive, and the only thing consulted', () => {
    const auto = (bytes: number): string => routeModelEntryIngestion(bytes, ThreeMfIngestion.Auto);

    // A3-R01 — below the threshold is buffered, down to nothing.
    expect(auto(0)).toBe(ThreeMfIngestion.Buffered);
    expect(auto(1)).toBe(ThreeMfIngestion.Buffered);
    expect(auto(THRESHOLD - 1)).toBe(ThreeMfIngestion.Buffered);

    // A3-R02 — EXACTLY the threshold streams. Documented, and asserted here so
    // the boundary cannot drift by one byte unnoticed in either direction.
    expect(auto(THRESHOLD)).toBe(ThreeMfIngestion.Streaming);

    // A3-R03 — above it, up to and past today's eligibility ceiling, streams.
    expect(auto(THRESHOLD + 1)).toBe(ThreeMfIngestion.Streaming);
    expect(auto(DEFAULT_ZIP_LIMITS.maxEntryBytes)).toBe(ThreeMfIngestion.Streaming);
  });

  it('the threshold sits inside today’s eligibility, with room on both sides', () => {
    // A threshold at or above the per-entry ceiling would never route anything;
    // one at zero would stream every relationship-sized part. Neither is a
    // policy, and either would make every ladder in the design document moot.
    expect(THRESHOLD).toBeGreaterThan(0);
    expect(THRESHOLD).toBeLessThan(DEFAULT_ZIP_LIMITS.maxEntryBytes);
  });

  it('a forced mode is honoured whatever the size, so a differential can read both ways', () => {
    for (const bytes of [0, 1, THRESHOLD - 1, THRESHOLD, THRESHOLD + 1, 1 << 30]) {
      expect(routeModelEntryIngestion(bytes, ThreeMfIngestion.Buffered)).toBe(
        ThreeMfIngestion.Buffered,
      );
      expect(routeModelEntryIngestion(bytes, ThreeMfIngestion.Streaming)).toBe(
        ThreeMfIngestion.Streaming,
      );
    }
  });

  it('is a pure function of the declaration: the same size always answers the same way', () => {
    // Nothing about the host may enter the decision, or the same file would
    // import two ways on two machines and a refusal would stop being
    // reproducible. A thousand calls either side of the line, all identical.
    for (let n = 0; n < 1_000; n += 1) {
      expect(routeModelEntryIngestion(THRESHOLD - 1, ThreeMfIngestion.Auto)).toBe(
        ThreeMfIngestion.Buffered,
      );
      expect(routeModelEntryIngestion(THRESHOLD, ThreeMfIngestion.Auto)).toBe(
        ThreeMfIngestion.Streaming,
      );
    }
  });
});

/* ====================================================== the reader's wiring */

describe('6E-A3: the reader routes each model entry by its own declaration', () => {
  it('A3-R06: a small root and a large child take DIFFERENT paths in one package', async () => {
    const child = '3D/Objects/big.model';
    const tiny = '3D/Objects/small.model';
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      { name: '3D/3dmodel.model', method: 8, content: productionRoot([child, tiny], false) },
      { name: child, method: 0, content: paddedModel(THRESHOLD) },
      { name: tiny, method: 8, content: modelXml({ unit: 'millimeter' }) },
    ]);

    const read = await readRouted(archive, ThreeMfIngestion.Auto);
    expect(read.routes.map((route) => [route.entry, route.route])).toEqual([
      ['3D/3dmodel.model', ThreeMfIngestion.Buffered],
      [child, ThreeMfIngestion.Streaming],
      [tiny, ThreeMfIngestion.Buffered],
    ]);
    // THE ROUTING INPUT IS THE DECLARATION, and it is exactly what was written.
    expect(read.routes[1]?.declaredUncompressedBytes).toBe(THRESHOLD);

    // The document is the package's, unaffected by the parts having been read
    // differently: three tetrahedra, one per placement.
    expect(read.parts).toBe(2);
    expect(read.triangles).toBe(8);

    // FORCING EITHER MODE PRODUCES THE SAME DOCUMENT. Routing is a choice about
    // memory, so it may not be observable in what the reader returns.
    const buffered = await readRouted(archive, ThreeMfIngestion.Buffered);
    const streamed = await readRouted(archive, ThreeMfIngestion.Streaming);
    expect(buffered.routes.every((r) => r.route === ThreeMfIngestion.Buffered)).toBe(true);
    expect(streamed.routes.every((r) => r.route === ThreeMfIngestion.Streaming)).toBe(true);
    expect([buffered.parts, buffered.triangles]).toEqual([read.parts, read.triangles]);
    expect([streamed.parts, streamed.triangles]).toEqual([read.parts, read.triangles]);
  }, 120_000);
  it('A3-R07: a large ROOT streams while its small child buffers', async () => {
    /*
     * THE OTHER DIRECTION, AND NOT A SYMMETRY FOR ITS OWN SAKE. The root is the
     * part resolved through the OPC relationship rather than through a
     * production `p:path`, and it is the only part whose `<build>` is walked.
     * A routing decision taken per PACKAGE — or taken from the root and applied
     * to the rest — would pass the previous test and fail this one.
     */
    const child = '3D/Objects/small.model';
    const root = paddedModel(THRESHOLD, 9).replace(
      '<build><item objectid="9"/></build>',
      `<build><item objectid="9"/><item objectid="1" p:path="/${child}"/></build>`,
    );
    const rootWithNs = root.replace(
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"',
      `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="${PRODUCTION_NS}" requiredextensions="p"`,
    );
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      { name: '3D/3dmodel.model', method: 0, content: rootWithNs },
      { name: child, method: 8, content: modelXml({ unit: 'millimeter' }) },
    ]);

    const read = await readRouted(archive, ThreeMfIngestion.Auto);
    expect(read.routes.map((route) => route.route)).toEqual([
      ThreeMfIngestion.Streaming,
      ThreeMfIngestion.Buffered,
    ]);
    expect(read.parts).toBe(2);
    expect(read.triangles).toBe(8);
  }, 120_000);
  it('A3-R08: a child referenced twice is routed once, because it is parsed once', async () => {
    const child = '3D/Objects/big.model';
    const root =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      `xmlns:p="${PRODUCTION_NS}" requiredextensions="p"><resources/><build>` +
      `<item objectid="1" p:path="/${child}"/>` +
      `<item objectid="1" p:path="/${child}" transform="1 0 0 0 1 0 0 0 1 40 0 0"/>` +
      '</build></model>';
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      { name: '3D/3dmodel.model', method: 8, content: root },
      { name: child, method: 0, content: paddedModel(THRESHOLD) },
    ]);

    const read = await readRouted(archive, ThreeMfIngestion.Auto);
    // TWO PLACEMENTS, ONE LOAD, ONE ROUTE. A second route for the same entry
    // would mean the package graph had read it twice — which for a streamed
    // entry is two full decompressions of the largest thing in the archive.
    expect(read.routes.filter((route) => route.entry === child)).toHaveLength(1);
    expect(read.parts).toBe(2);
    expect(read.triangles).toBe(8);
    expect(read.routes.map((route) => route.route)).toEqual([
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
    ]);
  }, 120_000);
});

/* ====================================== eligibility, budgets and the ratio */

describe('6E-A3: routing changes no eligibility and no safety property', () => {
  /**
   * An entry that LIES: it declares `declared` bytes and really holds `content`.
   * Deflated, because a stored entry's declared size is its length — a stored
   * entry whose two sizes disagree is refused as corrupt at the directory, and
   * only a deflated one can carry a declaration the data contradicts.
   */
  const lying = async (declared: number, content: string): Promise<Uint8Array> =>
    buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      {
        name: '3D/3dmodel.model',
        method: 8,
        content,
        declaredUncompressedSize: declared,
      },
    ]);

  it('A3-R04: the eligibility boundary is exactly where it was, under every mode', async () => {
    /*
     * The per-entry ceiling is `>`, not `>=`, and A3 did not touch it. What
     * routing must not do is move it — so the question asked here is not "is
     * 256 MiB allowed", which `zip.test.ts` already settles, but "does the
     * answer depend on the mode". It must not, in either direction.
     *
     * A declaration this far above its real content is refused for the RATIO
     * before an entry is opened, which is the stronger statement and the reason
     * no route is chosen: an ineligible or implausible entry never reaches the
     * decision at all.
     */
    const atLimit = await lying(DEFAULT_ZIP_LIMITS.maxEntryBytes, modelXml({ unit: 'millimeter' }));
    const pastLimit = await lying(
      DEFAULT_ZIP_LIMITS.maxEntryBytes + 1,
      modelXml({ unit: 'millimeter' }),
    );

    const modes = [ThreeMfIngestion.Auto, ThreeMfIngestion.Buffered, ThreeMfIngestion.Streaming];
    const at = [];
    const past = [];
    for (const mode of modes) {
      at.push(await refusalOfRead(() => read3mf(atLimit, testReadContext(), { ingestion: mode })));
      past.push(
        await refusalOfRead(() => read3mf(pastLimit, testReadContext(), { ingestion: mode })),
      );
    }

    // AT the ceiling the entry is ELIGIBLE: it is refused for what it contains,
    // never for its size. One byte past it, the size is the refusal.
    for (const refusal of at) expect(refusal.reason).toBe(ImportRefusal.ZipRatioExceeded);
    for (const refusal of past) {
      expect(refusal.reason).toBe(ImportRefusal.ZipEntryTooLarge);
      expect(refusal.details.limit).toBe(DEFAULT_ZIP_LIMITS.maxEntryBytes);
    }
    // Byte for byte the same refusal in all three modes, on both sides.
    for (const set of [at, past]) {
      for (const refusal of set) {
        expect(refusal.code).toBe(set[0]?.code);
        expect(refusal.message).toBe(set[0]?.message);
        expect(refusal.details).toEqual(set[0]?.details);
      }
    }
    // And a 256 MiB entry, were one real, would be STREAMED.
    expect(routeModelEntryIngestion(DEFAULT_ZIP_LIMITS.maxEntryBytes, ThreeMfIngestion.Auto)).toBe(
      ThreeMfIngestion.Streaming,
    );
  });

  it('A3-R05: one byte past the ceiling is refused BEFORE any route is chosen', async () => {
    const archive = await lying(
      DEFAULT_ZIP_LIMITS.maxEntryBytes + 1,
      modelXml({ unit: 'millimeter' }),
    );
    for (const mode of [
      ThreeMfIngestion.Auto,
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
    ]) {
      const refusal = await refusalOfRead(() =>
        read3mf(archive, testReadContext(), { ingestion: mode }),
      );
      expect(refusal.reason, mode).toBe(ImportRefusal.ZipEntryTooLarge);
      expect(refusal.details.limit, mode).toBe(DEFAULT_ZIP_LIMITS.maxEntryBytes);
      // NOT ROUTED AND NOT OPENED. The directory refuses it, so no path was
      // ever selected — a routing decision on an ineligible entry would mean
      // the ceiling had moved behind the route.
      expect(await routesOf(archive, mode), mode).toEqual([]);
    }
  });

  it('A3-R11: a declaration below the threshold cannot smuggle a larger entry past buffered', async () => {
    /*
     * THE ROUTING ATTACK. The declaration steers the entry onto the buffered
     * path — which allocates exactly what was declared — and the content then
     * tries to be far bigger. The overrun check fires at the first chunk that
     * would cross the declaration, so the allocation is bounded by the LIE and
     * the lie is what refuses the file.
     */
    const big = modelXml({
      unit: 'millimeter',
      resources: `<object id="1" type="model">${TETRAHEDRON_MESH}</object>`,
      build: `<item objectid="1"/>${'<!-- '.padEnd(2_000_000, 'x')} -->`,
    });
    const archive = await lying(1024, big);

    const routes = await routesOf(archive, ThreeMfIngestion.Auto);
    expect(routes.map((route) => route.route)).toEqual([ThreeMfIngestion.Buffered]);

    const refusal = await refusalOfRead(() =>
      read3mf(archive, testReadContext(), { ingestion: ThreeMfIngestion.Auto }),
    );
    expect(refusal.reason).toBe(ImportRefusal.ZipDeclaredSizeOverrun);
    expect(refusal.details.declared).toBe(1024);

    // THE SAME REFUSAL WHICHEVER PATH IS FORCED. The lie is caught by the entry
    // reader, not by the route, so no route can be the one that catches it.
    for (const mode of [ThreeMfIngestion.Buffered, ThreeMfIngestion.Streaming]) {
      const forced = await refusalOfRead(() =>
        read3mf(archive, testReadContext(), { ingestion: mode }),
      );
      expect(forced.reason, mode).toBe(ImportRefusal.ZipDeclaredSizeOverrun);
    }
  });

  it('A3-R11: an upward lie is bounded by the ratio, and refused before any route', async () => {
    /*
     * THE OTHER DIRECTION OF THE ROUTING ATTACK, and the answer is not the one
     * that looks obvious. A declaration cannot be made arbitrarily large to
     * steer an entry onto the streamed path: the compression ratio is checked
     * against the DECLARATION at the directory, so a claim more than 200 times
     * the compressed data is refused before an entry is opened and before a
     * path is chosen. An attacker who wants a declaration above the threshold
     * has to supply about 840 KiB of real compressed data to support it.
     */
    const archive = await lying(THRESHOLD + 4096, modelXml({ unit: 'millimeter' }));
    for (const mode of [
      ThreeMfIngestion.Auto,
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
    ]) {
      const refusal = await refusalOfRead(() =>
        read3mf(archive, testReadContext(), { ingestion: mode }),
      );
      expect(refusal.reason, mode).toBe(ImportRefusal.ZipRatioExceeded);
      expect(await routesOf(archive, mode), mode).toEqual([]);
    }
  });

  it('A3-R11: within the ratio, a short entry is still refused on every path', async () => {
    /*
     * The shortfall check is what catches a lie the ratio admits. Proven at
     * small scale, with content that barely compresses so the declaration stays
     * inside 200:1: the entry is routed — BUFFERED, because the declaration is
     * below the threshold — opened, and refused when the stream ends before the
     * declaration does.
     */
    const archive = await lying(
      100 * 1024,
      modelXml({ unit: 'millimeter', build: `<item objectid="1"/><!--${filler(8_192)}-->` }),
    );
    expect((await routesOf(archive, ThreeMfIngestion.Auto)).map((r) => r.route)).toEqual([
      ThreeMfIngestion.Buffered,
    ]);
    for (const mode of [
      ThreeMfIngestion.Auto,
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
    ]) {
      const refusal = await refusalOfRead(() =>
        read3mf(archive, testReadContext(), { ingestion: mode }),
      );
      expect(refusal.reason, mode).toBe(ImportRefusal.ZipDeclaredSizeShortfall);
      expect(refusal.details.declared, mode).toBe(100 * 1024);
    }
  });

  it('A3-R10: the compression ratio refuses identically under every mode', async () => {
    // 64 MiB of zeros in one model entry: far past 200:1, and far below the
    // routing threshold, so `auto` sends it down the BUFFERED path and it is
    // refused there exactly as the forced modes refuse it.
    const bomb = new Uint8Array(64 * 1024 * 1024);
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      { name: '3D/3dmodel.model', method: 8, content: bomb },
    ]);
    const seen = [];
    for (const mode of [
      ThreeMfIngestion.Auto,
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
    ]) {
      seen.push(
        await refusalOfRead(() => read3mf(archive, testReadContext(), { ingestion: mode })),
      );
    }
    for (const refusal of seen) {
      expect(refusal.reason).toBe(ImportRefusal.ZipRatioExceeded);
      expect(refusal.code).toBe(seen[0]?.code);
      expect(refusal.message).toBe(seen[0]?.message);
    }
    // REFUSED AT THE DIRECTORY, so no entry was opened and no path was chosen.
    // The ratio is a property of the archive's own metadata, which is exactly
    // what routing reads — and the ceiling is applied to it first.
    expect(await routesOf(archive, ThreeMfIngestion.Auto)).toEqual([]);
  });

  it('A3-R09: the package budget is ONE budget across a mixed-mode package', async () => {
    /*
     * A buffered entry charges its bytes once; a streamed one charges its
     * SECURITY pass and not its element pass. Mixing the two must neither
     * double-charge nor under-charge, so the budget a mixed package spends is
     * the sum of its parts' declared sizes and nothing else.
     *
     * Proven by NARROWING the package ceiling to just under that sum: the
     * package must be refused, and refused at the entry that crosses. A budget
     * that reset per part, or that charged a streamed part twice, would land
     * somewhere else.
     */
    const child = '3D/Objects/big.model';
    const tiny = '3D/Objects/small.model';
    const tinyXml = modelXml({ unit: 'millimeter' });
    const rootXml = productionRoot([child, tiny], false);
    const total = rootXml.length + THRESHOLD + tinyXml.length;
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      { name: '3D/3dmodel.model', method: 8, content: rootXml },
      { name: child, method: 0, content: paddedModel(THRESHOLD) },
      { name: tiny, method: 8, content: tinyXml },
    ]);

    // The relationships are charged too, so the exact spend is a little above
    // the model parts' sum; a ceiling at the sum MINUS the smallest part is
    // unambiguously crossed, and a ceiling well above the sum is not.
    const narrow = {
      ...DEFAULT_ZIP_LIMITS,
      maxTotalUncompressedBytes: total - tinyXml.length,
    };
    const refusal = await refusalOfRead(() =>
      read3mf(archive, testReadContext(), {
        ingestion: ThreeMfIngestion.Auto,
        zipLimits: narrow,
      }),
    );
    expect(refusal.reason).toBe(ImportRefusal.ZipTotalTooLarge);

    // And the SAME ceiling refuses under either forced mode, so the spend does
    // not depend on which path the big entry took.
    for (const mode of [ThreeMfIngestion.Buffered, ThreeMfIngestion.Streaming]) {
      const forced = await refusalOfRead(() =>
        read3mf(archive, testReadContext(), { ingestion: mode, zipLimits: narrow }),
      );
      expect(forced.reason, mode).toBe(ImportRefusal.ZipTotalTooLarge);
    }

    // A ceiling above the sum admits it, whichever way the parts were read.
    const wide = { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: total + 64 * 1024 };
    for (const mode of [
      ThreeMfIngestion.Auto,
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
    ]) {
      const result = await read3mf(archive, testReadContext(), {
        ingestion: mode,
        zipLimits: wide,
      });
      expect(documentTriangleCount(result.document), mode).toBe(8);
    }
  }, 120_000);
});

/* ============================================== auto against the oracle */

/**
 * Everything about a document that a reader decides.
 *
 * Compared as ONE string so a difference anywhere fails one assertion with both
 * sides printed: the unit, every part's name, material reference, transform and
 * which mesh resource it uses, every DISTINCT mesh's positions and indices, and
 * the encoding, warnings and compatibility report the import carries.
 */
function documentDigest(result: DocumentReadResult): string {
  const meshes = new Map<CanonicalMesh, number>();
  const parts = result.document.parts.map((part) => {
    // SHARING IS PART OF THE ANSWER, so the index a mesh gets is its order of
    // first appearance: two parts holding the same mesh OBJECT must digest the
    // same resource, and two parts holding equal copies must not.
    if (!meshes.has(part.mesh)) meshes.set(part.mesh, meshes.size);
    return {
      id: part.id,
      name: part.name ?? null,
      materialRef: part.materialRef ?? null,
      transform: [...part.transform],
      meshResource: meshes.get(part.mesh),
    };
  });
  const geometry = [...meshes.keys()].map((mesh) => ({
    positions: [...mesh.positions],
    indices: [...mesh.indices],
  }));
  return JSON.stringify({
    unit: result.document.unit ?? null,
    parts,
    geometry,
    encoding: result.encoding,
    warnings: result.warnings.map((warning) => [warning.code, warning.message]),
    compatibility: result.compatibility,
  });
}

describe('6E-A3: auto produces exactly what buffered produces', () => {
  const bigChild = '3D/Objects/big.model';
  const smallChild = '3D/Objects/small.model';

  /** A package whose parts straddle the threshold, so `auto` really mixes. */
  async function straddlingPackage(bigPart: string): Promise<Uint8Array> {
    return buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      {
        name: '3D/3dmodel.model',
        method: 8,
        content: productionRoot([bigChild, smallChild], false),
      },
      { name: bigChild, method: 0, content: bigPart },
      { name: smallChild, method: 8, content: modelXml({ unit: 'millimeter' }) },
    ]);
  }

  it('A3-R16: the document is identical whether the big part was buffered, streamed or routed', async () => {
    const archive = await straddlingPackage(paddedModel(THRESHOLD));
    const digests = new Map<string, string>();
    for (const mode of [
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
      ThreeMfIngestion.Auto,
    ]) {
      const result = await read3mf(archive, testReadContext(), { ingestion: mode });
      digests.set(mode, documentDigest(result));
    }
    // BUFFERED IS THE ORACLE. v0.2.0's path is what the product produced before
    // this stage, so equality with it is the contract — not equality among the
    // two new ones, which could agree with each other and both be wrong.
    expect(digests.get(ThreeMfIngestion.Auto)).toBe(digests.get(ThreeMfIngestion.Buffered));
    expect(digests.get(ThreeMfIngestion.Streaming)).toBe(digests.get(ThreeMfIngestion.Buffered));

    // And the routing really did differ, or the comparison proved nothing.
    const routes = await routesOf(archive, ThreeMfIngestion.Auto);
    expect(new Set(routes.map((route) => route.route))).toEqual(
      new Set([ThreeMfIngestion.Buffered, ThreeMfIngestion.Streaming]),
    );
  }, 120_000);
  it('A3-R17: an unsupported extension in a ROUTED part refuses identically', async () => {
    /*
     * The declaration sits on the streamed child, not on the root, so the
     * refusal has to come from a part `auto` chose to stream. Every extension
     * but production is still refused, in the root AND in any referenced part —
     * routing did not touch that.
     */
    const declared = paddedModel(THRESHOLD).replace(
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"',
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
        'xmlns:s="http://schemas.microsoft.com/3dmanufacturing/slice/2015/07" requiredextensions="s"',
    );
    const archive = await straddlingPackage(declared);
    const refusals = [];
    for (const mode of [
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
      ThreeMfIngestion.Auto,
    ]) {
      refusals.push(
        await refusalOfRead(() => read3mf(archive, testReadContext(), { ingestion: mode })),
      );
    }
    for (const refusal of refusals) {
      expect(refusal.reason).toBe(ImportRefusal.ThreeMfUnsupportedExtension);
      expect(refusal.code).toBe(refusals[0]?.code);
      expect(refusal.message).toBe(refusals[0]?.message);
      expect(refusal.details).toEqual(refusals[0]?.details);
    }
  }, 120_000);
  it('A3-R18: malformed XML in a ROUTED part refuses identically, and never INTERNAL_FAILURE', async () => {
    const broken = paddedModel(THRESHOLD).replace('</model>', '</mode');
    const archive = await straddlingPackage(broken);
    const refusals = [];
    for (const mode of [
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
      ThreeMfIngestion.Auto,
    ]) {
      refusals.push(
        await refusalOfRead(() => read3mf(archive, testReadContext(), { ingestion: mode })),
      );
    }
    for (const refusal of refusals) {
      expect(refusal.code).not.toBe(AppErrorCode.Internal);
      expect(refusal.code).toBe(refusals[0]?.code);
      expect(refusal.reason).toBe(refusals[0]?.reason);
      expect(refusal.message).toBe(refusals[0]?.message);
    }
  }, 120_000);
  it('A3-R18: an unsafe DOCTYPE in a ROUTED part is refused before any element is read', async () => {
    const hostile = paddedModel(THRESHOLD).replace(
      '<model ',
      '<!DOCTYPE model [<!ENTITY x "y">]><model ',
    );
    const archive = await straddlingPackage(hostile);
    for (const mode of [
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
      ThreeMfIngestion.Auto,
    ]) {
      const refusal = await refusalOfRead(() =>
        read3mf(archive, testReadContext(), { ingestion: mode }),
      );
      expect(refusal.reason, mode).toBe(ImportRefusal.XmlDoctypeRefused);
    }
  }, 120_000);
});

/* ============================================ cancellation, on every route */

/** A token that reports cancelled once it has been polled `after` times. */
function cancelAfterPolls(after: number): CancellationToken {
  let polls = 0;
  return {
    get isCancelled(): boolean {
      polls += 1;
      return polls > after;
    },
    onCancelled(): () => void {
      return (): void => undefined;
    },
  };
}

describe('6E-A3: cancellation is unchanged by the route', () => {
  const bigChild = '3D/Objects/big.model';
  const smallChild = '3D/Objects/small.model';

  async function mixedPackage(): Promise<Uint8Array> {
    return buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      {
        name: '3D/3dmodel.model',
        method: 8,
        content: productionRoot([bigChild, smallChild], false),
      },
      { name: bigChild, method: 0, content: paddedModel(THRESHOLD) },
      { name: smallChild, method: 8, content: modelXml({ unit: 'millimeter' }) },
    ]);
  }

  async function cancelled(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      expect(isAppError(error) ? error.code : error).toBe(AppErrorCode.OperationCancelled);
      return;
    }
    throw new Error('expected a cancellation');
  }

  /** How many times a whole, uncancelled read polls the token. */
  async function pollsFor(archive: Uint8Array, mode: ThreeMfIngestion): Promise<number> {
    let polls = 0;
    const counting: CancellationToken = {
      get isCancelled(): boolean {
        polls += 1;
        return false;
      },
      onCancelled: () => (): void => undefined,
    };
    await read3mf(archive, testReadContext({ cancellation: counting }), { ingestion: mode });
    return polls;
  }

  it('A3-R12/R13/R14: a cancel at any point of any route is observed, and yields no document', async () => {
    /*
     * THE CANCEL POINTS ARE DERIVED, NOT GUESSED. How many times a read polls
     * depends on the mode and on the file — a streamed part polls once per
     * piece, a buffered one every 65,536 elements — so a fixed list of poll
     * counts would silently stop reaching the inside of a read the moment
     * either changed. Counting an uncancelled read first makes the fractions
     * mean the same thing on every path.
     */
    const archive = await mixedPackage();
    for (const mode of [
      ThreeMfIngestion.Buffered,
      ThreeMfIngestion.Streaming,
      ThreeMfIngestion.Auto,
    ]) {
      const total = await pollsFor(archive, mode);
      expect(total, mode).toBeGreaterThan(8);
      for (const at of [0, Math.floor(total / 4), Math.floor(total / 2), total - 1]) {
        await cancelled(() =>
          read3mf(archive, testReadContext({ cancellation: cancelAfterPolls(at) }), {
            ingestion: mode,
          }),
        );
      }
    }
  }, 120_000);
  it('A3-R14: a cancel anywhere in a MIXED package leaves it with no document', async () => {
    /*
     * THE MIXED PACKAGE IS THE POINT. Its parts are read one at a time and in
     * different modes, so a cancel arriving between them has to unwind a
     * streamed read and a buffered one through the same walk. `read3mf` either
     * returns a whole document or throws; there is no partial result.
     */
    const archive = await mixedPackage();
    const total = await pollsFor(archive, ThreeMfIngestion.Auto);
    const step = Math.max(1, Math.floor(total / 8));
    for (let at = 0; at < total; at += step) {
      await cancelled(() =>
        read3mf(archive, testReadContext({ cancellation: cancelAfterPolls(at) }), {
          ingestion: ThreeMfIngestion.Auto,
        }),
      );
    }
  }, 120_000);
});

/* ====================================================== the wiring itself */

describe('6E-A3: the route is wired, not assumed', () => {
  it('a mode that may stream needs a text decoder, and says so rather than falling back', async () => {
    /*
     * A SILENT FALLBACK TO BUFFERED WOULD UNDO THE STAGE. The entries that most
     * need streaming are exactly the ones a fallback would send down the
     * expensive path, and nothing would say so. `auto` therefore refuses the
     * WIRING FAULT up front, as `streaming` already did, rather than at
     * whichever file happened to be first past the threshold.
     */
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      { name: '3D/3dmodel.model', method: 8, content: modelXml({ unit: 'millimeter' }) },
    ]);
    for (const mode of [ThreeMfIngestion.Auto, ThreeMfIngestion.Streaming]) {
      const refusal = await refusalOfRead(() =>
        read3mf(archive, testReadContext({ withTextDecoder: false }), { ingestion: mode }),
      );
      expect(refusal.code, mode).toBe(AppErrorCode.Internal);
    }
    // Buffered needs none and must keep working without one.
    const result = await read3mf(archive, testReadContext({ withTextDecoder: false }), {
      ingestion: ThreeMfIngestion.Buffered,
    });
    expect(documentTriangleCount(result.document)).toBe(4);
  });

  it('`read3mf` with no options is still exactly v0.2.0: buffered, whatever the size', async () => {
    // The default is the oracle every differential is held to. If it ever
    // became `auto`, the suites that compare "the reader" against "the streamed
    // reader" would be comparing streaming against itself.
    const archive = await buildZip([
      { name: '[Content_Types].xml', method: 8, content: CONTENT_TYPES },
      { name: '_rels/.rels', method: 8, content: RELS },
      { name: '3D/3dmodel.model', method: 0, content: paddedModel(THRESHOLD) },
    ]);
    const routes: ThreeMfRouteDecision[] = [];
    await read3mfForQualification(
      archive,
      testReadContext(),
      {},
      {
        onRoute: (decision) => {
          routes.push(decision);
        },
      },
    );
    expect(routes.map((route) => route.route)).toEqual([ThreeMfIngestion.Buffered]);
  }, 120_000);
});
