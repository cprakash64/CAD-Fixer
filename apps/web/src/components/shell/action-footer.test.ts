import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WORKSPACE-UX-03: the bounded action region, held at source.
 *
 * The browser suite proves the controls can be clicked at thirteen window
 * sizes. This pins the RULE that makes them so, so a fifth workspace or a new
 * footer line cannot quietly reintroduce a region that grows with its state:
 * every workspace footer is the shared component, the cap and the scroller's
 * padding are one length, and no workspace invents a cap of its own.
 */

const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(COMPONENTS, '..', 'styles', 'shell.css'), 'utf8');
const WORKSPACES = ['Repair', 'Convert', 'Split', 'Texture'] as const;
const source = (name: string): string =>
  readFileSync(join(COMPONENTS, `${name}Workspace.tsx`), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (match?.[1] === undefined) throw new Error(`No rule for ${selector}`);
  return match[1];
}

describe('the workspace action region is one shared, bounded contract', () => {
  it.each(WORKSPACES)('%s builds its footer from the shared component', (name) => {
    const text = source(name);
    expect(text).toContain("from './shell/action-footer'");
    expect(text).toMatch(/<ActionFooter testId="[a-z]+-footer"/);
    // No hand-built footer beside it: that is the element that grew.
    expect(text).not.toMatch(/className="convert-footer[ "]/);
  });

  it('covers every workspace there is', () => {
    const present = readdirSync(COMPONENTS)
      .filter((file) => /^[A-Z][A-Za-z]*Workspace\.tsx$/.test(file))
      .map((file) => file.replace('Workspace.tsx', ''))
      .sort();
    expect(present).toEqual([...WORKSPACES].sort());
  });

  it('caps the region and pads the scroller by the same length', () => {
    expect(rule('.action-footer')).toMatch(/max-height: var\(--action-footer-max\);/);
    expect(rule('.action-footer')).toMatch(/overflow: hidden;/);
    const scroller = rule('.tool-panel__body');
    expect(scroller).toMatch(/--action-footer-max: \d+px;/);
    expect(scroller).toMatch(/scroll-padding-bottom: var\(--action-footer-max\);/);
  });

  it('never lets the action row give way, and keeps the line to one line', () => {
    expect(rule('.action-footer > .convert-footer__actions')).toMatch(/flex: none;/);
    expect(css).toMatch(/\.action-footer__line,[^{]*\{[^}]*white-space: nowrap;/);
  });

  it('has one cap, not one per workspace', () => {
    expect(css).not.toMatch(/--(repair|split|texture|convert)-footer-max/);
    const caps = css.match(/--action-footer-max: \d+px/g) ?? [];
    // The default and the short-window tier.
    expect(caps).toHaveLength(2);
  });

  it('keeps explanations and results out of the footers at source', () => {
    for (const name of WORKSPACES) {
      const text = source(name);
      const start = text.search(/<ActionFooter testId=/);
      const footer = text.slice(start, text.indexOf('</ActionFooter>', start));
      expect(footer, name).not.toMatch(/<InfoPanel|<PanelSection|<SegmentedControl/);
      expect(footer, name).not.toMatch(
        /undo-repair|texture-undo|convert-saved"|split-export-saved/,
      );
    }
  });
});
