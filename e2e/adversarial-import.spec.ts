import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildZip, modelXml, threeMf } from './format-fixtures';
import { binaryStl, binaryStlFrom } from './stl-fixtures';

/**
 * PR-01: hostile and malformed files through the SHIPPED application.
 *
 * The parsers are held to their contracts by ~870 unit tests in
 * packages/file-formats, and the 3MF archive attacks (bombs, traversal,
 * DOCTYPE, cycles, encrypted and corrupt entries) already run end to end in
 * format-import.spec.ts. This sweep asks the product-level question for the
 * rest: whatever the file, does the browser survive, does the refusal arrive
 * in bounded time, is the model the user already had left exactly as it was,
 * and does the next import still work?
 *
 * Every case is imported OVER a loaded 700-triangle model. A case may be
 * accepted (then it must be the model on screen, with finite facts) or refused
 * (then the old model must be untouched and an error entry logged) — which one
 * is recorded, not assumed, because several shapes here are legitimate files.
 * Set PR01_EVIDENCE to a path outside the repository to keep the outcomes.
 */

interface Case {
  readonly name: string;
  readonly bytes: Buffer;
  /** When set, the outcome is asserted, not only recorded. */
  readonly expect?: 'refused' | 'accepted';
}

function stlHeader(count: number, extraBytes = 0): Buffer {
  const out = Buffer.alloc(84 + extraBytes);
  out.writeUInt32LE(count >>> 0, 80);
  return out;
}

function stlWithCoordinates(value: number): Buffer {
  const bytes = binaryStl(4).bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Triangle 0, first vertex x.
  view.setFloat32(84 + 12, value, true);
  return Buffer.from(bytes);
}

const triangle = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 10, 0],
] as const;

const CASES: readonly Case[] = [
  // STL
  { name: 'empty.stl', bytes: Buffer.alloc(0), expect: 'refused' },
  { name: 'ten-bytes.stl', bytes: Buffer.from('0123456789'), expect: 'refused' },
  { name: 'declares-4-billion.stl', bytes: stlHeader(0xffffffff, 50), expect: 'refused' },
  { name: 'declares-20-million-has-1.stl', bytes: stlHeader(20_000_000, 50), expect: 'refused' },
  { name: 'nan-coordinate.stl', bytes: stlWithCoordinates(Number.NaN) },
  { name: 'infinite-coordinate.stl', bytes: stlWithCoordinates(Number.POSITIVE_INFINITY) },
  { name: 'absurd-coordinate.stl', bytes: stlWithCoordinates(3e38) },
  {
    name: 'every-triangle-twice.stl',
    bytes: binaryStlFrom([triangle, triangle, triangle, triangle]),
    expect: 'accepted',
  },
  {
    name: 'ascii-no-endsolid.stl',
    bytes: Buffer.from('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\n'),
    expect: 'refused',
  },
  {
    name: 'ascii-nan.stl',
    bytes: Buffer.from(
      'solid x\nfacet normal 0 0 1\nouter loop\nvertex nan 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n',
    ),
  },
  {
    name: 'random-bytes.stl',
    bytes: Buffer.from(Array.from({ length: 4096 }, (_v, i) => (i * 7919) % 251)),
  },
  // OBJ
  { name: 'empty.obj', bytes: Buffer.alloc(0), expect: 'refused' },
  { name: 'nan-vertex.obj', bytes: Buffer.from('v nan 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n') },
  {
    name: 'zero-index.obj',
    bytes: Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n'),
    expect: 'refused',
  },
  {
    name: 'index-past-end.obj',
    bytes: Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 99999999\n'),
    expect: 'refused',
  },
  {
    name: 'truncated-line.obj',
    bytes: Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1\nf 1 2 3\n'),
    expect: 'refused',
  },
  {
    name: 'hex-coordinate.obj',
    bytes: Buffer.from('v 0x10 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
    expect: 'refused',
  },
  // 3MF
  { name: 'empty.3mf', bytes: Buffer.alloc(0), expect: 'refused' },
  {
    name: 'not-a-zip.3mf',
    bytes: Buffer.from('PK\u0003\u0004 this is not really a zip'),
    expect: 'refused',
  },
  {
    name: 'no-model-part.3mf',
    bytes: buildZip([{ name: '[Content_Types].xml', content: '<Types/>' }]),
    expect: 'refused',
  },
  {
    name: 'unclosed-xml.3mf',
    bytes: threeMf(
      '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>',
    ),
    expect: 'refused',
  },
  {
    name: 'triangle-index-out-of-range.3mf',
    bytes: threeMf(
      modelXml({
        unit: 'millimeter',
        resources:
          '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="7"/></triangles></mesh></object>',
      }),
    ),
    expect: 'refused',
  },
  {
    name: 'nan-vertex.3mf',
    bytes: threeMf(
      modelXml({
        unit: 'millimeter',
        resources:
          '<object id="1" type="model"><mesh><vertices><vertex x="NaN" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>',
      }),
    ),
  },
  {
    name: 'invalid-utf8.3mf',
    bytes: threeMf(
      modelXml({
        unit: 'millimeter',
        resources: `<object id="1" type="model" name="badÿ￾name"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`,
      }),
    ),
  },
  // Names: the bytes decide the format, the name is only displayed.
  { name: '模型 é 🚀 — ünïcödé.stl', bytes: binaryStl(12).bytes, expect: 'accepted' },
  { name: `${'long-name-'.repeat(25)}end.stl`, bytes: binaryStl(12).bytes, expect: 'accepted' },
  { name: 'UPPERCASE.STL', bytes: binaryStl(12).bytes, expect: 'accepted' },
  { name: 'no-extension', bytes: binaryStl(12).bytes },
  { name: '.hidden.stl', bytes: binaryStl(12).bytes, expect: 'accepted' },
  { name: 'part.v2.final.stl', bytes: binaryStl(12).bytes, expect: 'accepted' },
  { name: 'stl-bytes-named.obj', bytes: binaryStl(12).bytes, expect: 'refused' },
];

async function open(page: Page, name: string, bytes: Buffer): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('browse-button').click();
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
}

const errorEntries = (page: Page): Promise<number> =>
  page.locator('[data-testid="status-list"] .status__entry--error').count();

test('hostile and malformed files are refused or imported safely, and nothing already open is harmed', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const outcomes: Record<string, string>[] = [];
  for (const entry of CASES) {
    // A known model under every case.
    await open(page, 'baseline.stl', binaryStl(700).bytes);
    await expect(page.getByTestId('fact-filename')).toHaveText('baseline.stl', { timeout: 30_000 });
    await expect(page.getByTestId('fact-triangles')).toHaveText('700');
    const errorsBefore = await errorEntries(page);

    const started = Date.now();
    await open(page, entry.name, entry.bytes);
    const outcome = await Promise.race([
      expect(page.getByTestId('fact-filename'))
        .toHaveText(entry.name, { timeout: 30_000 })
        .then(() => 'accepted' as const),
      expect
        .poll(() => errorEntries(page), { timeout: 30_000 })
        .toBeGreaterThan(errorsBefore)
        .then(() => 'refused' as const),
    ]);
    const ms = Date.now() - started;
    await expect(page.getByTestId('import-progress')).toHaveCount(0, { timeout: 30_000 });

    let detail: string;
    if (outcome === 'refused') {
      // The user's model is exactly as it was.
      await expect(page.getByTestId('fact-filename')).toHaveText('baseline.stl');
      await expect(page.getByTestId('fact-triangles')).toHaveText('700');
      detail =
        (await page
          .locator('[data-testid="status-list"] .status__entry--error')
          // The activity log is newest first.
          .first()
          .textContent()) ?? '';
      // A refusal is a sentence for a person, never a stack or an internal name.
      expect(detail, entry.name).not.toMatch(/\bat \w+ \(|Error:|undefined|NaN|\[object/);
      expect(detail.length, entry.name).toBeGreaterThan(10);
    } else {
      // Anything accepted is on screen with finite, stated facts.
      const size = (await page.getByTestId('fact-size').textContent()) ?? '';
      expect(size, entry.name).not.toMatch(/NaN|Infinity/);
      await expect(page.getByTestId('viewport-error')).toHaveCount(0);
      detail = `size ${size}`;
    }
    if (entry.expect !== undefined) expect(outcome, entry.name).toBe(entry.expect);
    expect(ms, `${entry.name} settled in ${String(ms)} ms`).toBeLessThan(20_000);
    outcomes.push({ name: entry.name, outcome, ms: String(ms), detail: detail.slice(0, 200) });
  }

  // After every hostile file, the application still imports and draws.
  await open(page, 'after.stl', binaryStl(900).bytes);
  await expect(page.getByTestId('fact-triangles')).toHaveText('900', { timeout: 30_000 });
  await expect(page.getByTestId('viewport-error')).toHaveCount(0);

  const evidence = process.env.PR01_EVIDENCE;
  if (evidence !== undefined) writeFileSync(evidence, JSON.stringify(outcomes, null, 1));
  expect(pageErrors).toEqual([]);
});
