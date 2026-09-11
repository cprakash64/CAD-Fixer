#!/usr/bin/env node
/**
 * CAD Fixer release packager — provider-neutral.
 *
 * Turns `apps/web/dist` into two separate things:
 *
 *   artifacts/release/site/                 exactly what a web server serves
 *   artifacts/release/release-manifest.json what that artifact is made of
 *
 * The manifest is deliberately OUTSIDE the served directory, so it is never
 * uploaded, never fetchable, and cannot become self-referential.
 *
 * PACKAGING COPIES BYTES AND NOTHING ELSE. No minification, recompression or
 * rewriting: the server must receive exactly Vite's output, minus the files we
 * intentionally leave behind. `--verify` proves that by re-hashing both sides.
 *
 * FAIL-CLOSED. An unrecognised file in `dist` stops the build rather than being
 * shipped. A release artifact is the one place where "copy everything and hope"
 * is how a source map, a stray fixture or an environment file reaches the
 * public internet.
 *
 * Node core modules only. A release-verification tool that needs a dependency
 * tree can be compromised by one.
 *
 * Usage:
 *   node scripts/build-release-artifact.mjs [--allow-dirty]
 *
 * `--allow-dirty` exists to qualify the MECHANISM before the deployment-source
 * commit exists. A real deployment artifact must come from a clean tree, so the
 * default refuses: a manifest naming a commit it was not built from is worse
 * than no manifest.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'apps', 'web', 'dist');
const releaseDir = join(repoRoot, 'artifacts', 'release');
const siteDir = join(releaseDir, 'site');
const manifestPath = join(releaseDir, 'release-manifest.json');
const kernelPath = join(
  repoRoot,
  'packages',
  'self-intersection-kernel',
  'artifacts',
  'self-intersection.wasm',
);

/** The Geogram build qualified in Stage 3C-1B. A different one is not shippable. */
const EXPECTED_KERNEL_SHA256 = '507ea5e7c9110781e4d90ade507d1b37a7b95b2832b055cb59418bca43399fc3';

/**
 * Extensions a browser actually requests. Anything else in `dist` is either a
 * new product capability that must be added here deliberately, or a mistake.
 */
const DEPLOYABLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.wasm',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.json',
  '.txt',
  '.webmanifest',
]);

/** Excluded on purpose, with the reason recorded in the manifest. */
const EXCLUSION_RULES = [
  {
    reason: 'source-map-excluded-from-public-artifact',
    matches: (path) => path.endsWith('.map'),
  },
];

/**
 * Names that must never reach a public directory. Checked before the extension
 * allowlist, because `.env.json` would otherwise pass as JSON.
 */
const FORBIDDEN_PATTERNS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.dev\.vars($|\.)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.ssh(\/|$)/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
  /(^|\/)release-manifest\.json$/,
  /\.(ts|tsx|mts|cts)$/,
  /\.(test|spec)\./,
];

const sha256 = (absolutePath) =>
  createHash('sha256').update(readFileSync(absolutePath)).digest('hex');

const toPosix = (p) => p.split('\\').join('/');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out.sort();
}

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function fail(message) {
  process.stderr.write(`release packaging FAILED: ${message}\n`);
  process.exit(1);
}

const allowDirty = process.argv.includes('--allow-dirty');

if (!existsSync(join(distDir, 'index.html'))) {
  fail(`no build output at ${relative(repoRoot, distDir)} — run \`npm run build\` first`);
}

/*
 * Only TRACKED changes make a release inexact. Generated, ignored output —
 * including this script's own artifacts/ directory — does not.
 */
const trackedStatus = git('status', '--porcelain', '--untracked-files=no');
const workingTreeClean = trackedStatus === '';
if (!workingTreeClean && !allowDirty) {
  fail(
    'tracked working tree is dirty, so the artifact would not correspond to any commit.\n' +
      '  Commit first, or pass --allow-dirty to qualify the mechanism only.',
  );
}
const commit = git('rev-parse', 'HEAD');

const kernelSha = sha256(kernelPath);
if (kernelSha !== EXPECTED_KERNEL_SHA256) {
  fail(`kernel SHA-256 is ${kernelSha}, expected ${EXPECTED_KERNEL_SHA256}`);
}

const everyFile = walk(distDir).map((absolute) => toPosix(relative(distDir, absolute)));

const deployable = [];
const excluded = [];

for (const path of everyFile) {
  const forbidden = FORBIDDEN_PATTERNS.find((pattern) => pattern.test(path));
  if (forbidden) {
    fail(`refusing to package ${path} — matches forbidden pattern ${forbidden}`);
  }

  const rule = EXCLUSION_RULES.find((r) => r.matches(path));
  if (rule) {
    excluded.push({ path, bytes: statSync(join(distDir, path)).size, reason: rule.reason });
    continue;
  }

  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase();
  if (!DEPLOYABLE_EXTENSIONS.has(extension)) {
    fail(
      `unrecognised file in build output: ${path}\n` +
        '  Packaging is fail-closed. If this is a real runtime asset, add its\n' +
        '  extension to DEPLOYABLE_EXTENSIONS deliberately.',
    );
  }

  deployable.push(path);
}

if (deployable.length === 0) fail('build output contains no deployable file');
if (!deployable.includes('index.html')) fail('build output has no index.html');
if (!deployable.some((p) => p.endsWith('.wasm'))) {
  fail('build output contains no .wasm — the Geogram kernel is missing');
}

/* A stale site directory must not leak a file the new release does not have. */
rmSync(siteDir, { recursive: true, force: true });
mkdirSync(siteDir, { recursive: true });

const files = [];
for (const path of deployable) {
  const source = join(distDir, path);
  const destination = join(siteDir, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);

  const sourceHash = sha256(source);
  const copiedHash = sha256(destination);
  if (sourceHash !== copiedHash) {
    fail(`packaging altered ${path} — ${sourceHash} became ${copiedHash}`);
  }
  files.push({ path, bytes: statSync(destination).size, sha256: copiedHash });
}

files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
const largest = files.reduce((a, b) => (b.bytes > a.bytes ? b : a), files[0]);

/*
 * Deliberately free of timestamps, absolute paths, user names, host names and
 * deployment targets: the manifest must be byte-identical for the same commit
 * on any machine, and it must disclose nothing about where it will be sent.
 */
const manifest = {
  schema: 'cad-fixer.release-manifest',
  schemaVersion: 1,
  source: { commit, workingTreeClean },
  siteDirectory: 'artifacts/release/site',
  deployable: {
    fileCount: files.length,
    totalBytes,
    largestFile: { path: largest.path, bytes: largest.bytes },
    files,
  },
  excluded: {
    fileCount: excluded.length,
    totalBytes: excluded.reduce((sum, f) => sum + f.bytes, 0),
    files: excluded,
  },
  kernel: {
    path: 'packages/self-intersection-kernel/artifacts/self-intersection.wasm',
    sha256: kernelSha,
  },
};

mkdirSync(releaseDir, { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

process.stdout.write(
  `release artifact: ${relative(repoRoot, siteDir)}\n` +
    `manifest:         ${relative(repoRoot, manifestPath)}\n` +
    `  commit          ${commit}${workingTreeClean ? '' : '  (TRACKED TREE DIRTY)'}\n` +
    `  deployable      ${files.length} files, ${totalBytes} bytes\n` +
    `  largest         ${largest.path} (${largest.bytes} bytes)\n` +
    `  excluded        ${excluded.length} files, ${manifest.excluded.totalBytes} bytes\n` +
    `  kernel          ${kernelSha}\n`,
);
