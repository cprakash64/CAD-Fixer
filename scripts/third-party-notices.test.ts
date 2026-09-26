import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE SHIPPED NOTICES AND THE SOURCE-TREE LICENCES MAY NOT DRIFT.
 *
 * Third-party artwork carries its licence beside it in the source tree, as
 * vendored code does (`workers/third-party/manifold/LICENSE`). The fonts and
 * icons are also DISTRIBUTED with every deployment, so their notices ship too,
 * as `apps/web/public/third-party-notices.txt` — a static file Vite copies
 * beside the application, never part of its code. Two copies of a licence can
 * disagree; this holds them to each other, and holds every shipped font to a
 * notice that names it.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const SHIPPED = 'apps/web/public/third-party-notices.txt';
const FONT_DIR = 'apps/web/src/styles/fonts';

describe('third-party notices', () => {
  const shipped = read(SHIPPED);

  it('ships the font licence exactly as it sits beside the fonts', () => {
    expect(shipped).toContain(read(`${FONT_DIR}/LICENSE`).trim());
    expect(shipped).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  it('ships the icon licence exactly as it sits beside the icons', () => {
    const beside = read('apps/web/src/components/shell/LICENSE-lucide');
    const licence = beside.slice(beside.indexOf('ISC License')).trim();
    expect(licence.length).toBeGreaterThan(0);
    expect(shipped).toContain(licence);
    // Lucide includes Feather's MIT notice; both must travel.
    expect(shipped).toContain('Copyright (c) 2013-present Cole Bemis');
  });

  it('names every font file the application ships', () => {
    const fonts = readdirSync(join(ROOT, FONT_DIR)).filter((name) => name.endsWith('.woff2'));
    expect(fonts.length).toBeGreaterThan(0);
    const beside = read(`${FONT_DIR}/LICENSE`);
    for (const font of fonts) expect(beside, font).toContain(`(${font}):`);
  });
});
