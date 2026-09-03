/**
 * Stage 3C-1A research static server. RESEARCH ONLY — not the product server.
 *
 * Serves the experiment directory with the SAME cross-origin isolation headers
 * the product mandates (docs/DEPLOYMENT_REQUIREMENTS.md), because the questions
 * being asked — SharedArrayBuffer availability, worker-to-worker transfer,
 * WASM behaviour — only have meaningful answers under the deployment CAD Fixer
 * actually ships.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.SI_PORT ?? 4319);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = url.pathname === '/' ? '/harness/index.html' : url.pathname;
  // Contained to the experiment directory: a research server is still a server.
  const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => {
  process.stdout.write(`si-harness listening on http://localhost:${PORT}\n`);
});
