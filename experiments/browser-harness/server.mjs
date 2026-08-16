#!/usr/bin/env node
/**
 * Static server for the Stage 3A-3B EXPERIMENTAL browser harness.
 *
 * RESEARCH ONLY. This serves nothing the application serves, and the
 * application serves nothing from here. It exists so candidate WASM can be
 * qualified in a real browser without any of it touching the production build.
 *
 * WHY NOT VITE. Emscripten's ES6 glue does not survive Vite's transform — that
 * defect fabricated 321 "crashes" in Stage 3A-2. Serving the artifacts as raw
 * bytes from a plain `node:http` server removes the bundler from the experiment
 * entirely, so what the browser instantiates is byte-identical to the artifact
 * whose SHA-256 the manifests record.
 *
 * WHY THE SAME HEADERS AS PRODUCTION. CAD Fixer runs cross-origin isolated
 * (COOP same-origin, COEP require-corp — see apps/web/vite.config.ts). A
 * candidate that only works outside isolation would be useless to us, so the
 * harness reproduces the real security context and the tests assert
 * `crossOriginIsolated === true` in the browser rather than trusting headers.
 *
 * LOCAL ONLY. Every route resolves inside this repository. There is no proxy,
 * no redirect, and no route that can reach another origin.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const HERE = import.meta.dirname;
const REPO = resolve(HERE, '..', '..');
const KERNELS = join(REPO, 'experiments', 'repair-kernels');
const PORT = Number(process.env.CF_HARNESS_PORT ?? 4174);

/**
 * Cross-origin isolation, matching apps/web/vite.config.ts exactly.
 *
 * COEP `require-corp` means every subresource must opt in; because everything
 * here is same-origin and carries CORP `same-origin`, the WASM and the worker
 * load inside the isolated context rather than being blocked by it.
 */
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Maps a URL path to a file, or `null`.
 *
 * Two roots only: the harness directory, and each candidate's artifacts
 * directory. Everything is re-checked with `resolve` + prefix test after
 * normalisation, so `..` cannot escape either root — a traversal here would let
 * the experiment serve arbitrary repository content to a browser page.
 */
function resolveRequest(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0] ?? '/'));

  if (clean === '/' || clean === '\\') return join(HERE, 'index.html');

  const artifacts = /^[/\\]artifacts[/\\]([a-z]+)[/\\](.+)$/.exec(clean);
  if (artifacts !== null) {
    const [, candidate, file] = artifacts;
    const root = resolve(KERNELS, candidate, 'artifacts');
    const target = resolve(root, file);
    return target.startsWith(root + sep) ? target : null;
  }

  const target = resolve(HERE, `.${clean}`);
  return target.startsWith(HERE + sep) ? target : null;
}

const server = createServer((request, response) => {
  const path = resolveRequest(request.url ?? '/');

  if (path === null || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { ...ISOLATION, 'Content-Type': 'text/plain' });
    response.end('not found');
    return;
  }

  response.writeHead(200, {
    ...ISOLATION,
    'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
    // The harness measures load and compile time; a cached response would
    // silently turn a cold-start measurement into a warm one.
    'Cache-Control': 'no-store',
  });
  createReadStream(path).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`cf browser harness on http://127.0.0.1:${String(PORT)}/\n`);
});
