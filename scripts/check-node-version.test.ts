import { describe, expect, it } from 'vitest';
import { checkVersion, meetsMinimum, parseMinimum, parseVersion } from './check-node-version.js';

/**
 * The comparison is tested directly rather than by spawning other Node builds,
 * which would make the suite depend on what happens to be installed. The
 * versions below are the ones that matter: 20.20.2 is the runtime that produced
 * a false green, and 22.12.0 is the declared minimum.
 */

const REQUIRED = '>=22.12.0';

describe('parsing', () => {
  it('reads a plain version and tolerates the leading v', () => {
    expect(parseVersion('22.12.0')).toEqual({ major: 22, minor: 12, patch: 0 });
    expect(parseVersion('v22.22.2')).toEqual({ major: 22, minor: 22, patch: 2 });
  });

  it('reads the lower bound out of an engines range', () => {
    expect(parseMinimum(REQUIRED)).toEqual({ major: 22, minor: 12, patch: 0 });
  });

  it('returns undefined rather than guessing at input it does not understand', () => {
    expect(parseVersion('not-a-version')).toBeUndefined();
    // A range shape this project does not use. Silently accepting it would be
    // worse than refusing, because the bound would be wrong.
    expect(parseMinimum('^22.12.0')).toBeUndefined();
  });
});

describe('version acceptance against >=22.12.0', () => {
  it.each([
    ['v20.20.2', false], // the runtime that silently skipped five test files
    ['v22.11.0', false], // Node 22, but below the minimum
    ['v22.11.9', false],
    ['v22.12.0', true], // exactly the minimum
    ['v22.22.2', true], // the pinned version
    ['v22.99.1', true], // any later Node 22
    ['v23.5.0', true], // newer major: allowed, see meetsMinimum
    ['v24.0.0', true],
  ])('%s → %s', (version, expected) => {
    const parsed = parseVersion(version);
    const minimum = parseMinimum(REQUIRED);
    expect(parsed).toBeDefined();
    expect(minimum).toBeDefined();
    if (parsed === undefined || minimum === undefined) return;

    expect(meetsMinimum(parsed, minimum)).toBe(expected);
  });
});

describe('the reported failure', () => {
  it('names both the actual and the required version', () => {
    const result = checkVersion('v20.20.2', REQUIRED);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('20.20.2');
    expect(result.message).toContain('>=22.12.0');
    // The reason matters as much as the refusal.
    expect(result.message).toContain('nvm use');
  });

  it('passes a supported version without a message', () => {
    expect(checkVersion('v22.22.2', REQUIRED)).toEqual({ ok: true });
  });

  it('fails closed on an unreadable requirement rather than assuming it is met', () => {
    const result = checkVersion('v22.22.2', 'latest');

    expect(result.ok).toBe(false);
  });
});
