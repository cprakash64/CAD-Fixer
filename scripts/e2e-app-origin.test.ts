import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_BASE_URL, isInlineResource, resolveAppBaseUrl } from '../e2e/app-origin';

/**
 * RT01–RT08 — the end-to-end harness's notion of "our own origin".
 *
 * Stage 5C-Hostinger-B1 ran the suite against a real deployment and five
 * privacy specs failed, because they compared request URLs against a hardcoded
 * `http://localhost:4173`. Nothing had leaked — the "third-party" URLs were CAD
 * Fixer's own assets — but proving that required editing test constants by
 * hand. These tests cover the configuration that replaced it.
 *
 * The classifier is the load-bearing part. It must keep failing on a genuine
 * third-party request, so the cases below include the near-misses a substring
 * comparison would wave through.
 */

/** `isAppOrigin` reads a module-level constant, so origin comparison is tested directly. */
function isOriginOf(baseUrl: string | undefined, url: string): boolean {
  const origin = new URL(resolveAppBaseUrl(baseUrl)).origin;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

describe('RT01–RT08 — application origin resolution', () => {
  it('RT01: the default application origin remains the local preview server', () => {
    expect(DEFAULT_APP_BASE_URL).toBe('http://localhost:4173');
    expect(resolveAppBaseUrl(undefined)).toBe('http://localhost:4173');
  });

  it('RT02: an environment base URL is parsed and normalised to its origin', () => {
    expect(resolveAppBaseUrl('https://staging.example.invalid')).toBe(
      'https://staging.example.invalid',
    );
    /* A path is meaningless for a root-served app and is dropped. */
    expect(resolveAppBaseUrl('https://staging.example.invalid/some/path')).toBe(
      'https://staging.example.invalid',
    );
    expect(resolveAppBaseUrl('  https://staging.example.invalid  ')).toBe(
      'https://staging.example.invalid',
    );
  });

  it('RT03: a same-origin production URL is first-party', () => {
    const base = 'https://staging.example.invalid';
    expect(isOriginOf(base, 'https://staging.example.invalid/')).toBe(true);
    expect(isOriginOf(base, 'https://staging.example.invalid/assets/index-abc.js')).toBe(true);
    expect(isOriginOf(base, 'https://staging.example.invalid/a.wasm?v=1#x')).toBe(true);
  });

  it('RT04: a different hostname is external, including a prefix near-miss', () => {
    const base = 'https://staging.example.invalid';
    expect(isOriginOf(base, 'https://analytics.example.invalid/collect')).toBe(false);
    /*
     * THE CASE THAT MOTIVATED URL PARSING. `startsWith` would accept this as
     * first-party, and it is precisely what a privacy assertion must catch.
     */
    expect(isOriginOf(base, 'https://staging.example.invalid.attacker.test/beacon')).toBe(false);
    expect(isOriginOf(base, 'https://staging.example.invalidX/')).toBe(false);
  });

  it('RT05: a different scheme or port is external, because origin includes both', () => {
    const base = 'https://staging.example.invalid';
    expect(isOriginOf(base, 'http://staging.example.invalid/')).toBe(false);
    expect(isOriginOf(base, 'https://staging.example.invalid:8443/')).toBe(false);
    expect(isOriginOf('http://localhost:4173', 'http://localhost:5173/')).toBe(false);
    expect(isOriginOf('http://localhost:4173', 'http://localhost:4173/x.js')).toBe(true);
  });

  it('RT06: inline resources the page itself created are not third-party traffic', () => {
    expect(isInlineResource('blob:https://staging.example.invalid/abc-123')).toBe(true);
    expect(isInlineResource('data:application/json;base64,e30=')).toBe(true);
    expect(isInlineResource('https://staging.example.invalid/real.js')).toBe(false);
    /* They are still not the app origin — a spec must opt in to allowing them. */
    expect(isOriginOf('https://staging.example.invalid', 'data:text/plain,hi')).toBe(false);
  });

  it('RT07: a malformed or non-HTTP base URL fails closed rather than silently defaulting', () => {
    /*
     * Falling back to localhost would run a "remote" qualification against the
     * developer's own machine and report it as deployment evidence.
     */
    expect(() => resolveAppBaseUrl('not a url')).toThrow(/not a valid absolute URL/);
    expect(() => resolveAppBaseUrl('fixcad.example.invalid')).toThrow(/not a valid absolute URL/);
    expect(() => resolveAppBaseUrl('ftp://staging.example.invalid')).toThrow(
      /must be http: or https:/,
    );
    expect(() => resolveAppBaseUrl('file:///tmp/index.html')).toThrow(/must be http: or https:/);
  });

  it('RT08: an empty or whitespace override uses the local default', () => {
    expect(resolveAppBaseUrl('')).toBe(DEFAULT_APP_BASE_URL);
    expect(resolveAppBaseUrl('   ')).toBe(DEFAULT_APP_BASE_URL);
    expect(resolveAppBaseUrl(undefined)).toBe(DEFAULT_APP_BASE_URL);
  });

  it('RT02/RT04: an unparseable request URL is classified external, not first-party', () => {
    expect(isOriginOf('https://staging.example.invalid', 'http://[malformed')).toBe(false);
    expect(isOriginOf('https://staging.example.invalid', '')).toBe(false);
  });
});
