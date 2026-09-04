import { expect, test, type Page } from '@playwright/test';

/**
 * Stage 4A-1 — browser qualification of format handling. RESEARCH ONLY.
 *
 * The questions here cannot be answered in Node: what a real DOMParser does
 * with a DTD, and whether hostile input can reach the network from a page.
 */

interface FmtApi {
  env(): { crossOriginIsolated: boolean; decompressionStream: string; domParser: string };
  probeXxe(xml: string): { parseError: boolean; text: string; root: string };
  guardedXml(xml: string): {
    refused: boolean;
    reason?: string;
    parseError?: boolean;
    root?: string;
  };
  zipCase(kind: string): Promise<{ accepted: boolean; refusal?: string; entries?: unknown[] }>;
  parseObjText(text: string): { vertexCount: number; faceCount: number; refusals: number };
  objBenchmark(faces: number): { bytes: number; faceCount: number; parseMs: number };
}
declare global {
  interface Window {
    fmt: FmtApi;
  }
}

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#state')).toHaveText('ready');
}

test('the research context has the platform primitives a dependency-free reader needs', async ({
  page,
}) => {
  await ready(page);
  const env = await page.evaluate(() => window.fmt.env());
  expect(env.decompressionStream).toBe('function');
  expect(env.domParser).toBe('function');
});

test('XXE: DOMParser does not resolve external entities, and the guard refuses first', async ({
  page,
}) => {
  await ready(page);

  const xxe = `<?xml version="1.0"?>
<!DOCTYPE model [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<model unit="millimeter">&xxe;</model>`;

  // UNGUARDED, to establish what the engine actually does.
  const probe = await page.evaluate((xml) => window.fmt.probeXxe(xml), xxe);
  // The entity must not have been expanded into the document text.
  expect(probe.text).not.toContain('root:');
  expect(probe.text).not.toContain('/bin/');

  // GUARDED: refused before parsing, so the answer does not depend on the engine.
  const guarded = await page.evaluate((xml) => window.fmt.guardedXml(xml), xxe);
  expect(guarded.refused).toBe(true);
  expect(guarded.reason ?? '').toMatch(/DOCTYPE|entity|external/i);

  // A billion-laughs expansion is refused by the same rule, before expansion.
  const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [ <!ENTITY lol "lol"> <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;"> ]>
<model>&lol2;</model>`;
  const guardedLaughs = await page.evaluate((xml) => window.fmt.guardedXml(xml), laughs);
  expect(guardedLaughs.refused).toBe(true);

  // A well-formed 3MF model with no DTD is accepted.
  const clean = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources/></model>`;
  const accepted = await page.evaluate((xml) => window.fmt.guardedXml(xml), clean);
  expect(accepted.refused).toBe(false);
  expect(accepted.parseError).toBe(false);
  expect(accepted.root).toBe('model');

  // Malformed XML is reported as a parse error, not silently accepted.
  const malformed = `<model><unclosed></model>`;
  const bad = await page.evaluate((xml) => window.fmt.guardedXml(xml), malformed);
  expect(bad.parseError).toBe(true);
});

test('the bounded ZIP reader behaves the same in the browser as in Node', async ({ page }) => {
  await ready(page);

  const valid = await page.evaluate(async () => window.fmt.zipCase('valid'));
  expect(valid.accepted).toBe(true);
  expect(valid.entries).toHaveLength(3);

  const bomb = await page.evaluate(async () => window.fmt.zipCase('bomb'));
  expect(bomb.accepted).toBe(false);
  expect(bomb.refusal).toBe('COMPRESSION_RATIO_EXCEEDED');

  const traversal = await page.evaluate(async () => window.fmt.zipCase('traversal'));
  expect(traversal.accepted).toBe(false);
  expect(traversal.refusal).toBe('UNSAFE_PATH');
});

test('parsing hostile input reaches no network at all', async ({ page }) => {
  const offOrigin: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (
      !url.startsWith('http://localhost:4321/') &&
      !url.startsWith('data:') &&
      !url.startsWith('blob:')
    ) {
      offOrigin.push(url);
    }
  });

  await ready(page);

  // Every one of these NAMES a remote resource. None may be fetched.
  await page.evaluate(() =>
    window.fmt.guardedXml(
      `<?xml version="1.0"?><!DOCTYPE m SYSTEM "http://evil.test/x.dtd"><model/>`,
    ),
  );
  await page.evaluate(() =>
    window.fmt.probeXxe(`<?xml version="1.0"?><model xmlns="http://evil.test/ns"/>`),
  );
  await page.evaluate(() => window.fmt.parseObjText('mtllib http://evil.test/a.mtl\nv 0 0 0\n'));
  await page.evaluate(async () => window.fmt.zipCase('valid'));

  expect(offOrigin).toEqual([]);
});

test('OBJ parse scaling and main-thread cost', async ({ page }) => {
  await ready(page);
  const rows: string[] = ['  faces      bytes      parse_ms   MiB/s'];
  for (const faces of [20_000, 100_000, 200_000]) {
    const r = await page.evaluate((n) => window.fmt.objBenchmark(n), faces);
    const mib = r.bytes / (1024 * 1024);
    rows.push(
      `${String(r.faceCount).padStart(7)} ${String(r.bytes).padStart(10)} ${r.parseMs.toFixed(0).padStart(11)} ${(mib / (r.parseMs / 1000)).toFixed(1).padStart(7)}`,
    );
    expect(r.faceCount).toBe(faces);
  }
  process.stdout.write(`\n[obj-scaling]\n${rows.join('\n')}\n\n`);
});
