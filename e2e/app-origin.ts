/**
 * WHERE THE APPLICATION UNDER TEST LIVES.
 *
 * The end-to-end suites default to the local `vite preview` origin, and that
 * default must never require configuration. Setting
 * `CAD_FIXER_E2E_BASE_URL` points the same specs at a real deployment instead:
 *
 *     CAD_FIXER_E2E_BASE_URL=https://example.invalid npm run test:e2e
 *
 * WHY THIS EXISTS. Stage 5C-Hostinger-B1 ran the suite against the deployed
 * staging origin and five privacy specs failed — not because anything leaked,
 * but because they compared request URLs against a hardcoded
 * `http://localhost:4173`. Against any other origin that predicate classifies
 * the application's OWN assets as third-party. Proving the deployment correct
 * then required editing test constants by hand, which is not a repeatable
 * qualification.
 *
 * ORIGINS ARE COMPARED AS ORIGINS, never as substrings. `startsWith` would
 * treat `https://fixcad.example.com.attacker.test/` as first-party, which is
 * exactly the kind of request the privacy assertions exist to catch.
 */

/** The local preview origin. Unchanged, and used whenever nothing overrides it. */
export const DEFAULT_APP_BASE_URL = 'http://localhost:4173';

/**
 * Normalise a configured base URL to an origin, or throw.
 *
 * FAILS CLOSED. A malformed or non-HTTP override is a configuration mistake,
 * and silently falling back to localhost would run a "remote" qualification
 * against the developer's own machine and report it as production evidence.
 */
export function resolveAppBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_APP_BASE_URL;

  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `CAD_FIXER_E2E_BASE_URL is not a valid absolute URL: ${JSON.stringify(trimmed)}`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `CAD_FIXER_E2E_BASE_URL must be http: or https:, got ${JSON.stringify(parsed.protocol)}`,
    );
  }

  /*
   * The application is served from the root of its origin, so a path in the
   * override is meaningless and keeping it would make `page.goto('/')` and the
   * request classifier disagree.
   */
  return parsed.origin;
}

export const APP_BASE_URL: string = resolveAppBaseUrl(process.env.CAD_FIXER_E2E_BASE_URL);

/** The origin every first-party request must match exactly. */
export const APP_ORIGIN: string = new URL(APP_BASE_URL).origin;

/** True when no override is active, so the local preview server is still needed. */
export const IS_LOCAL_APP_ORIGIN: boolean = APP_BASE_URL === DEFAULT_APP_BASE_URL;

/**
 * Is this request to the application's own origin?
 *
 * Anything unparseable is NOT first-party: an assertion that cannot classify a
 * request must surface it rather than wave it through.
 */
export function isAppOrigin(url: string): boolean {
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * `data:` and `blob:` URLs are content the page itself created — an exported
 * file handed to the download mechanism, a worker built in memory. They leave
 * no network, so they are not third-party traffic. Kept separate from
 * `isAppOrigin` so a spec has to opt into allowing them.
 */
export function isInlineResource(url: string): boolean {
  return url.startsWith('data:') || url.startsWith('blob:');
}
