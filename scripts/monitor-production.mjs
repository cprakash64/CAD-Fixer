#!/usr/bin/env node
/**
 * CAD Fixer production monitor — external, lightweight, dependency-free.
 *
 * Answers one question: is the public Technical Preview being served correctly?
 *
 * THE CENTRAL RULE, and the reason this file is careful:
 *
 *   A TRANSPORT FAILURE IS NOT A SEMANTIC FAILURE.
 *
 * A release-era watcher once reported `TARGET MISMATCH` for a perfectly healthy
 * server. Its SSH call had timed out, the error text landed in the variable
 * holding the expected value, and a string comparison failed. It reported a
 * defect that did not exist, and would equally have reported success had the
 * comparison happened to match. Alerting that cannot tell "I could not look"
 * from "I looked and it was wrong" is worse than no alerting: it teaches people
 * to ignore it.
 *
 * So every check resolves to exactly one of three states, and the distinction is
 * structural rather than a convention to remember:
 *
 *   PASS                 observed, and correct
 *   FAIL                 observed, and demonstrably wrong
 *   UNKNOWN_UNREACHABLE  could not be observed at all
 *
 * A check may only return FAIL from a code path that holds a real response.
 * Every transport error path returns UNKNOWN_UNREACHABLE, and UNKNOWN outranks
 * FAIL when the overall result is computed — because "the site might be down"
 * must never be silently downgraded to "one header looks off".
 *
 * Node core only. A monitor that needs a dependency tree is a monitor that can
 * be broken by one, and it must keep working when everything else is on fire.
 *
 * Usage:
 *   node scripts/monitor-production.mjs [--deep] [--json]
 *   CAD_FIXER_MONITOR_URL=https://example.invalid node scripts/monitor-production.mjs
 */
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';

/** The public Technical Preview. Overridable for testing. */
export const DEFAULT_MONITOR_URL = 'https://fixcad.thelunai.com';

export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const UNKNOWN = 'UNKNOWN_UNREACHABLE';

/** Exit codes. Distinct, so a caller can branch without parsing text. */
export const EXIT_CODE = { [PASS]: 0, [FAIL]: 1, [UNKNOWN]: 2 };

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Pause between a failed transport attempt and its single retry.
 *
 * Injectable so tests can exercise the unreachable paths without waiting three
 * real seconds per request. Production keeps the full delay: a retry that fires
 * instantly does not actually ride out the transient blip it exists for.
 */
export const DEFAULT_RETRY_DELAY_MS = 3_000;

/** Certificate thresholds. Under 14 days means renewal deserves investigating. */
export const CERT_WARN_DAYS = 21;
export const CERT_FAIL_DAYS = 14;

/** The shell's own title. NOT a marker added for monitoring. */
const IDENTITY_PATTERN = /<title>\s*CAD Fixer\s*<\/title>/i;

const MISSING_ASSET_PATH = '/__cad_fixer_monitor_missing_asset__.js';

/** Required on the shell, exactly. */
export const REQUIRED_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Perform one HTTP(S) request.
 *
 * Resolves `{ ok: true, response }` when a response was genuinely received, and
 * `{ ok: false, reason }` for EVERY transport failure. Callers therefore cannot
 * accidentally compare an error against an expected value: there is no response
 * object to read on the failure path.
 */
function fetchOnce(url, { method = 'GET', maxBodyBytes = 512 * 1024 } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, reason: `invalid URL: ${url}` });
      return;
    }

    const isHttps = target.protocol === 'https:';
    const send = isHttps ? request : httpRequest;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let req;
    try {
      req = send(
        target,
        {
          method,
          /* TLS verification stays ON. A monitor that skips it proves nothing. */
          servername: target.hostname,
          headers: { 'user-agent': 'cad-fixer-monitor/1' },
        },
        (res) => {
          /*
           * CAPTURE THE CERTIFICATE NOW, not in the `end` handler. With
           * keep-alive the socket can be released back to the agent before the
           * body finishes, and `getPeerCertificate` then returns nothing —
           * which the monitor would correctly report as UNKNOWN, but that would
           * be a blind spot in the monitor rather than a fact about the server.
           */
          const peerCertificate =
            isHttps && typeof res.socket?.getPeerCertificate === 'function'
              ? res.socket.getPeerCertificate()
              : undefined;
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total <= maxBodyBytes) chunks.push(c);
          });
          res.on('end', () => {
            finish({
              ok: true,
              response: {
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
                bytes: total,
                peerCertificate,
              },
            });
          });
          res.on('error', (e) => finish({ ok: false, reason: `response error: ${e.message}` }));
        },
      );
    } catch (e) {
      finish({ ok: false, reason: `request failed: ${e.message}` });
      return;
    }

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      finish({ ok: false, reason: `timeout after ${REQUEST_TIMEOUT_MS}ms` });
    });
    /* DNS failure, refusal, TLS rejection and reset all arrive here. */
    req.on('error', (e) => finish({ ok: false, reason: `${e.code ?? 'error'}: ${e.message}` }));
    req.end();
  });
}

/**
 * One bounded retry, for TRANSPORT failures only.
 *
 * A single dropped packet should not page anyone. A wrong header should not be
 * retried into silence, so semantic outcomes are never re-attempted here.
 */
async function fetchWithRetry(url, options, retryDelayMs = DEFAULT_RETRY_DELAY_MS) {
  const first = await fetchOnce(url, options);
  if (first.ok) return first;
  await sleep(retryDelayMs);
  const second = await fetchOnce(url, options);
  if (second.ok) return second;
  return { ok: false, reason: `${first.reason}; retry: ${second.reason}` };
}

const check = (id, state, detail, warning) => ({
  id,
  state,
  detail,
  ...(warning === undefined ? {} : { warning }),
});

/** Certificate state from a real peer certificate. */
export function evaluateCertificate(peerCertificate, now = Date.now()) {
  if (
    peerCertificate === undefined ||
    peerCertificate === null ||
    typeof peerCertificate.valid_to !== 'string' ||
    peerCertificate.valid_to === ''
  ) {
    /* No certificate to inspect is a failure to OBSERVE, not a bad certificate. */
    return check('M11', UNKNOWN, 'peer certificate unavailable');
  }
  const expiry = Date.parse(peerCertificate.valid_to);
  if (Number.isNaN(expiry)) {
    return check('M11', UNKNOWN, `unparseable certificate expiry: ${peerCertificate.valid_to}`);
  }
  const days = Math.floor((expiry - now) / 86_400_000);
  if (days < 0) return check('M11', FAIL, `certificate EXPIRED ${Math.abs(days)} days ago`);
  if (days < CERT_FAIL_DAYS) {
    return check('M11', FAIL, `certificate expires in ${days} days — check renewal`);
  }
  if (days <= CERT_WARN_DAYS) {
    return check(
      'M11',
      PASS,
      `certificate valid, ${days} days remaining`,
      `renewal window approaching (${days} days)`,
    );
  }
  return check('M11', PASS, `certificate valid, ${days} days remaining`);
}

/** Header checks against a response that genuinely arrived. */
export function evaluateHeaders(headers) {
  const results = [];
  const ids = {
    'cross-origin-opener-policy': 'M05',
    'cross-origin-embedder-policy': 'M06',
    'cross-origin-resource-policy': 'M07',
    'x-content-type-options': 'M08',
    'referrer-policy': 'M09',
  };
  for (const [name, expected] of Object.entries(REQUIRED_HEADERS)) {
    const actual = headers[name];
    const id = ids[name] ?? name;
    if (typeof actual !== 'string') {
      results.push(check(id, FAIL, `${name} absent`));
    } else if (actual.trim().toLowerCase() !== expected) {
      results.push(check(id, FAIL, `${name} is "${actual}", expected "${expected}"`));
    } else {
      results.push(check(id, PASS, `${name}: ${expected}`));
    }
  }
  return results;
}

/**
 * Overall state.
 *
 * A CONFIRMED FAILURE OUTRANKS AN UNOBSERVABLE CHECK, and the ordering matters
 * enough to justify: if the monitor reaches production, sees COEP is wrong, but
 * separately cannot read some other value, reporting UNKNOWN would bury a
 * confirmed, actionable defect behind an unrelated observability gap.
 *
 * This does not reintroduce the HV40 hazard, because FAIL is unreachable
 * without a real response — every transport path yields UNKNOWN. So a genuinely
 * unreachable target produces no FAIL checks at all and correctly resolves to
 * UNKNOWN; only a target we actually observed can resolve to FAIL.
 */
export function combine(checks) {
  if (checks.some((c) => c.state === FAIL)) return FAIL;
  if (checks.some((c) => c.state === UNKNOWN)) return UNKNOWN;
  return PASS;
}

/** Extract one same-origin hashed runtime asset from the shell. */
export function findRuntimeAsset(html) {
  const match = /(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/i.exec(html);
  return match?.[1];
}

export async function runMonitor({
  url = DEFAULT_MONITOR_URL,
  deep = false,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
  const started = Date.now();
  const checks = [];
  const target = new URL(url);

  /*
   * M02 — HTTP must redirect to HTTPS.
   *
   * Only applicable when the monitored target IS https. If an operator points
   * the monitor at an http:// origin, demanding a redirect to https would fail
   * a target they deliberately chose; the check does not apply, so it is not
   * emitted — the same reasoning as M11 below.
   */
  if (target.protocol === 'https:') {
    const httpUrl = `http://${target.host}/`;
    const httpResult = await fetchWithRetry(httpUrl, { maxBodyBytes: 4096 }, retryDelayMs);
    if (!httpResult.ok) {
      checks.push(check('M02', UNKNOWN, `HTTP unreachable — ${httpResult.reason}`));
    } else {
      const { status, headers } = httpResult.response;
      const location = typeof headers.location === 'string' ? headers.location : '';
      if (status >= 300 && status < 400 && location.startsWith('https://')) {
        checks.push(check('M02', PASS, `HTTP ${status} → ${location}`));
      } else {
        checks.push(check('M02', FAIL, `expected redirect to https, got ${status} ${location}`));
      }
    }
  }

  /* M01/M03 — reach the HTTPS shell. */
  const shell = await fetchWithRetry(target.href, {}, retryDelayMs);
  if (!shell.ok) {
    checks.push(check('M01', UNKNOWN, `HTTPS unreachable — ${shell.reason}`));
    return finalise(url, checks, started);
  }
  checks.push(check('M01', PASS, 'host reachable over HTTPS'));

  const { status, headers, body, peerCertificate } = shell.response;
  checks.push(
    status === 200
      ? check('M03', PASS, 'HTTPS root 200')
      : check('M03', FAIL, `HTTPS root returned ${status}`),
  );

  /* M04 — is this actually CAD Fixer, or a default vhost? */
  checks.push(
    IDENTITY_PATTERN.test(body)
      ? check('M04', PASS, 'page identity confirmed')
      : check('M04', FAIL, 'CAD Fixer page identity absent — possible vhost misrouting'),
  );

  /* M05–M09 */
  checks.push(...evaluateHeaders(headers));

  /* M10 — the shell must stay revalidated, never immutable. */
  const cache = typeof headers['cache-control'] === 'string' ? headers['cache-control'] : '';
  checks.push(
    cache.includes('no-cache') && !cache.includes('immutable')
      ? check('M10', PASS, `shell Cache-Control: ${cache}`)
      : check('M10', FAIL, `shell Cache-Control is "${cache}", expected no-cache`),
  );

  /*
   * M11 — only meaningful over TLS. On a plain-HTTP target there is no
   * certificate to inspect, so the check does not APPLY; emitting UNKNOWN for
   * an inapplicable check is noise that trains people to ignore UNKNOWN.
   */
  if (target.protocol === 'https:') {
    checks.push(evaluateCertificate(peerCertificate));
  }

  /* M12 — a missing asset must 404, never fall back to the shell. */
  const missing = await fetchWithRetry(
    new URL(MISSING_ASSET_PATH, target).href,
    { maxBodyBytes: 4096 },
    retryDelayMs,
  );
  if (!missing.ok) {
    checks.push(check('M12', UNKNOWN, `probe unreachable — ${missing.reason}`));
  } else if (missing.response.status === 404) {
    checks.push(check('M12', PASS, 'missing asset 404'));
  } else {
    checks.push(
      check('M12', FAIL, `missing asset returned ${missing.response.status} — SPA fallback?`),
    );
  }

  /* M13 — one representative hashed asset. Deliberately not every asset. */
  const assetPath = findRuntimeAsset(body);
  if (assetPath === undefined) {
    checks.push(check('M13', FAIL, 'no hashed runtime asset referenced by the shell'));
  } else {
    const asset = await fetchWithRetry(
      new URL(assetPath, target).href,
      { maxBodyBytes: 4096 },
      retryDelayMs,
    );
    if (!asset.ok) {
      checks.push(check('M13', UNKNOWN, `asset unreachable — ${asset.reason}`));
    } else {
      const a = asset.response;
      const type = typeof a.headers['content-type'] === 'string' ? a.headers['content-type'] : '';
      const aCache =
        typeof a.headers['cache-control'] === 'string' ? a.headers['cache-control'] : '';
      const problems = [];
      if (a.status !== 200) problems.push(`status ${a.status}`);
      if (!/javascript|css/i.test(type)) problems.push(`content-type "${type}"`);
      if (!aCache.includes('immutable')) problems.push(`cache-control "${aCache}"`);
      for (const [name, expected] of Object.entries(REQUIRED_HEADERS)) {
        const v = a.headers[name];
        if (typeof v !== 'string' || v.trim().toLowerCase() !== expected) {
          problems.push(`${name} missing/incorrect on asset`);
        }
      }
      checks.push(
        problems.length === 0
          ? check('M13', PASS, `runtime asset served correctly (${assetPath})`)
          : check('M13', FAIL, `${assetPath}: ${problems.join('; ')}`),
      );
    }
  }

  /* M14 — deep mode only. The WASM is ~1.2 MB; not for a 15-minute cadence. */
  if (deep) {
    const wasmMatch = /\/assets\/[A-Za-z0-9._-]+\.wasm/.exec(body);
    if (wasmMatch === null) {
      checks.push(check('M14', PASS, 'no WASM referenced from the shell (loaded lazily)'));
    } else {
      const wasm = await fetchWithRetry(
        new URL(wasmMatch[0], target).href,
        { maxBodyBytes: 1024 },
        retryDelayMs,
      );
      if (!wasm.ok) {
        checks.push(check('M14', UNKNOWN, `WASM unreachable — ${wasm.reason}`));
      } else {
        const t = wasm.response.headers['content-type'];
        checks.push(
          t === 'application/wasm'
            ? check('M14', PASS, 'WASM served as application/wasm')
            : check('M14', FAIL, `WASM content-type is "${t}"`),
        );
      }
    }
  }

  return finalise(url, checks, started);
}

function finalise(url, checks, started) {
  return {
    result: combine(checks),
    target: url,
    checks,
    warnings: checks.filter((c) => c.warning !== undefined).map((c) => c.warning),
    durationMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ CLI -- */

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=scripts\/)/, ''));

if (isMain || process.argv.some((a) => a === '--run')) {
  const url = process.env.CAD_FIXER_MONITOR_URL ?? DEFAULT_MONITOR_URL;
  const deep = process.argv.includes('--deep');
  const asJson = process.argv.includes('--json');

  const report = await runMonitor({ url, deep });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`CAD Fixer production monitor\n  target: ${report.target}\n\n`);
    for (const c of report.checks) {
      const mark = c.state === PASS ? 'PASS' : c.state === FAIL ? 'FAIL' : 'UNKN';
      process.stdout.write(`  [${mark}] ${c.id}  ${c.detail}\n`);
    }
    for (const w of report.warnings) process.stdout.write(`\n  WARNING: ${w}\n`);
    process.stdout.write(`\n  duration: ${report.durationMs}ms\n`);
  }

  /* Explicit, greppable, and never inferred from the exit code alone. */
  process.stdout.write(`MONITOR_RESULT=${report.result}\n`);
  process.exit(EXIT_CODE[report.result]);
}
