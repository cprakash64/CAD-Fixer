import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CERT_FAIL_DAYS,
  CERT_WARN_DAYS,
  EXIT_CODE,
  FAIL,
  PASS,
  UNKNOWN,
  combine,
  evaluateCertificate,
  evaluateHeaders,
  findRuntimeAsset,
  runMonitor,
} from './monitor-production.mjs';

/**
 * MON-T01–MON-T12 — the production monitor's semantics.
 *
 * The monitor exists to answer "is production being served correctly", and its
 * one non-obvious requirement is that it must distinguish
 *
 *     "I looked and it is wrong"        (FAIL)
 *
 * from
 *
 *     "I could not look"                (UNKNOWN_UNREACHABLE)
 *
 * A release-era watcher failed exactly that distinction: an SSH timeout left an
 * error string in the variable holding the expected value, a comparison failed,
 * and it reported a mismatch on a healthy server. MON-T12 encodes that lesson
 * directly; the rest keep the ordinary paths honest.
 *
 * Served over plain HTTP by a local fixture, so no certificate is present —
 * which is itself worth asserting, because "no certificate" must read as
 * UNKNOWN rather than as a bad certificate.
 */

const HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const SHELL =
  '<!doctype html><html><head><title>CAD Fixer</title>' +
  '<script type="module" src="/assets/index-abc123.js"></script></head><body></body></html>';

interface FixtureOptions {
  shellStatus?: number;
  title?: string;
  omitHeader?: string;
  shellCache?: string;
  missingAssetStatus?: number;
  assetCache?: string;
  redirect?: boolean;
}

function startFixture(options: FixtureOptions = {}): Promise<{ server: Server; url: string }> {
  const {
    shellStatus = 200,
    title = 'CAD Fixer',
    omitHeader,
    shellCache = 'no-cache',
    missingAssetStatus = 404,
    assetCache = 'public, max-age=31536000, immutable',
    redirect = true,
  } = options;

  const server = createServer((req, res) => {
    const send = (status: number, extra: Record<string, string>, body: string): void => {
      const base: Record<string, string> = { ...HEADERS, ...extra };
      const headers: Record<string, string> = Object.fromEntries(
        Object.entries(base).filter(([k]) => k !== omitHeader),
      );
      res.writeHead(status, headers);
      res.end(body);
    };

    const url = req.url ?? '/';
    if (url === '/' && !redirect) {
      send(200, { 'content-type': 'text/html', 'cache-control': shellCache }, SHELL);
      return;
    }
    if (url === '/') {
      send(
        shellStatus,
        { 'content-type': 'text/html', 'cache-control': shellCache },
        SHELL.replace('CAD Fixer', title),
      );
      return;
    }
    if (url.startsWith('/assets/')) {
      send(200, { 'content-type': 'text/javascript', 'cache-control': assetCache }, 'export {};');
      return;
    }
    send(missingAssetStatus, { 'content-type': 'text/html' }, 'not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${String(port)}/` });
    });
  });
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

const stateOf = (report: { checks: { id: string; state: string }[] }, id: string): string =>
  report.checks.find((c) => c.id === id)?.state ?? 'ABSENT';

describe('MON-T01–MON-T12 — monitor semantics', () => {
  let fixture: { server: Server; url: string };
  beforeAll(async () => {
    fixture = await startFixture();
  });
  afterAll(async () => {
    await close(fixture.server);
  });

  it('MON-T01: a correct deployment is PASS on every observable check', async () => {
    const report = await runMonitor({ url: fixture.url, retryDelayMs: 1 });
    /*
     * Plain-HTTP fixture, so the two TLS-dependent checks do not APPLY and must
     * not be emitted at all. Emitting UNKNOWN (or worse, FAIL) for an
     * inapplicable check is noise that trains people to ignore the signal.
     */
    expect(report.checks.some((c) => c.id === 'M02')).toBe(false);
    expect(report.checks.some((c) => c.id === 'M11')).toBe(false);
    expect(report.checks.every((c) => c.state === PASS)).toBe(true);
    expect(report.result).toBe(PASS);
    expect(stateOf(report, 'M03')).toBe(PASS);
    expect(stateOf(report, 'M04')).toBe(PASS);
    expect(stateOf(report, 'M12')).toBe(PASS);
    expect(stateOf(report, 'M13')).toBe(PASS);
  });

  it('MON-T02: an observed 500 is FAIL, not UNKNOWN', async () => {
    const f = await startFixture({ shellStatus: 500 });
    const report = await runMonitor({ url: f.url, retryDelayMs: 1 });
    expect(stateOf(report, 'M03')).toBe(FAIL);
    await close(f.server);
  });

  it('MON-T03: 200 with the wrong page identity is FAIL', async () => {
    const f = await startFixture({ title: 'Some Other Site' });
    const report = await runMonitor({ url: f.url, retryDelayMs: 1 });
    /* Catches a default-vhost regression that a status check alone would miss. */
    expect(stateOf(report, 'M04')).toBe(FAIL);
    expect(report.result).toBe(FAIL);
    await close(f.server);
  });

  it('MON-T04: a missing COEP header is FAIL', async () => {
    const f = await startFixture({ omitHeader: 'cross-origin-embedder-policy' });
    const report = await runMonitor({ url: f.url, retryDelayMs: 1 });
    expect(stateOf(report, 'M06')).toBe(FAIL);
    expect(report.result).toBe(FAIL);
    await close(f.server);
  });

  it('MON-T05: a connection timeout is UNKNOWN_UNREACHABLE, never FAIL', async () => {
    /* Port 1 on loopback: nothing listens, so the connection is refused. */
    const report = await runMonitor({ url: 'http://127.0.0.1:1/', retryDelayMs: 1 });
    expect(report.result).toBe(UNKNOWN);
    expect(report.checks.some((c) => c.state === FAIL)).toBe(false);
  }, 30_000);

  it('MON-T06: DNS failure is UNKNOWN_UNREACHABLE, never FAIL', async () => {
    const report = await runMonitor({ url: 'https://nonexistent.invalid/', retryDelayMs: 1 });
    expect(report.result).toBe(UNKNOWN);
    expect(report.checks.some((c) => c.state === FAIL)).toBe(false);
  }, 30_000);

  it('MON-T07: an expired certificate is FAIL', () => {
    const now = Date.UTC(2026, 0, 20);
    const cert = { valid_to: 'Jan 10 00:00:00 2026 GMT' };
    const result = evaluateCertificate(cert, now);
    expect(result.state).toBe(FAIL);
    expect(result.detail).toMatch(/EXPIRED/);
  });

  it('MON-T08: a certificate near expiry is PASS with a warning', () => {
    const now = Date.UTC(2026, 0, 1);
    const near = { valid_to: `Jan ${String(1 + CERT_WARN_DAYS - 2)} 00:00:00 2026 GMT` };
    const result = evaluateCertificate(near, now);
    expect(result.state).toBe(PASS);
    expect(result.warning).toBeDefined();

    /* Below the failure threshold it stops being a warning. */
    const soon = { valid_to: `Jan ${String(1 + CERT_FAIL_DAYS - 3)} 00:00:00 2026 GMT` };
    expect(evaluateCertificate(soon, now).state).toBe(FAIL);

    /* Comfortably valid is a plain PASS with no warning. */
    const far = { valid_to: 'Jun 01 00:00:00 2026 GMT' };
    const farResult = evaluateCertificate(far, now);
    expect(farResult.state).toBe(PASS);
    expect(farResult.warning).toBeUndefined();
  });

  it('MON-T09: a missing asset returning 200 is FAIL (SPA fallback)', async () => {
    const f = await startFixture({ missingAssetStatus: 200 });
    const report = await runMonitor({ url: f.url, retryDelayMs: 1 });
    expect(stateOf(report, 'M12')).toBe(FAIL);
    await close(f.server);
  });

  it('MON-T10: a missing asset returning 404 is PASS', async () => {
    const report = await runMonitor({ url: fixture.url, retryDelayMs: 1 });
    expect(stateOf(report, 'M12')).toBe(PASS);
  });

  it('MON-T11: an asset without immutable caching is FAIL', async () => {
    const f = await startFixture({ assetCache: 'no-cache' });
    const report = await runMonitor({ url: f.url, retryDelayMs: 1 });
    expect(stateOf(report, 'M13')).toBe(FAIL);
    await close(f.server);
  });

  it('MON-T12: a transport error can NEVER become a semantic mismatch', async () => {
    /*
     * THE LESSON FROM THE STALE HV40 WATCHER, encoded.
     *
     * That watcher captured an SSH timeout's error text into the variable
     * holding the expected value, compared it, and reported TARGET MISMATCH on
     * a healthy server. Here an unreachable target must produce UNKNOWN and
     * NOTHING may be reported as FAIL — there is no response to compare, so
     * there is no basis for a semantic verdict.
     */
    for (const unreachable of [
      'http://127.0.0.1:1/',
      'https://nonexistent.invalid/',
      'http://127.0.0.1:2/',
    ]) {
      const report = await runMonitor({ url: unreachable, retryDelayMs: 1 });
      expect(report.result, `${unreachable} must be UNKNOWN`).toBe(UNKNOWN);
      expect(
        report.checks.filter((c) => c.state === FAIL),
        `${unreachable} must produce no FAIL checks`,
      ).toEqual([]);
    }

    /* And UNKNOWN outranks FAIL when combining: "cannot see" is not "fine". */
    /*
     * A CONFIRMED failure outranks an unobservable check: a real defect must not
     * be buried behind an unrelated observability gap. This is safe precisely
     * because FAIL is unreachable without a response, so an unreachable target
     * still resolves to UNKNOWN (asserted above).
     */
    expect(combine([{ state: PASS }, { state: FAIL }, { state: UNKNOWN }] as never)).toBe(FAIL);
    expect(combine([{ state: PASS }, { state: UNKNOWN }] as never)).toBe(UNKNOWN);
    expect(combine([{ state: PASS }] as never)).toBe(PASS);
  }, 60_000);

  it('exit codes are distinct and stable', () => {
    expect(EXIT_CODE[PASS]).toBe(0);
    expect(EXIT_CODE[FAIL]).toBe(1);
    expect(EXIT_CODE[UNKNOWN]).toBe(2);
  });

  it('header evaluation reports the exact offending value', () => {
    const results = evaluateHeaders({ ...HEADERS, 'cross-origin-opener-policy': 'unsafe-none' });
    const coop = results.find((r) => r.id === 'M05');
    expect(coop?.state).toBe(FAIL);
    expect(coop?.detail).toMatch(/unsafe-none/);
  });

  it('a hashed runtime asset is discovered from the shell', () => {
    expect(findRuntimeAsset(SHELL)).toBe('/assets/index-abc123.js');
    expect(findRuntimeAsset('<html></html>')).toBeUndefined();
  });
});
