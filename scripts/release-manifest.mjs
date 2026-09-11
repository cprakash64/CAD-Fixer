#!/usr/bin/env node
/**
 * Release artifact manifest.
 *
 * Records exactly what a deployment is made of, so the bytes a CDN serves can
 * be compared against the bytes a reviewed commit produced. Stage 5B proved the
 * build is reproducible; this turns that property into a checkable artifact.
 *
 * The manifest describes the DEPLOYABLE set only — the files Cloudflare will
 * actually upload. Files the provider treats as configuration (`_headers`) and
 * files excluded by `.assetsignore` (source maps) are listed separately, as
 * exclusions, so the reason a file is absent is recorded rather than inferred.
 *
 * PRIVACY: no absolute path, user name, host name or environment value is ever
 * written. Paths are relative to the build output directory. The manifest is
 * written OUTSIDE that directory so it is never itself uploaded, and so it can
 * never become self-referential.
 *
 * Node core modules only, by design: a release-verification tool that needs a
 * dependency tree is a release-verification tool that can be compromised by one.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'apps', 'web', 'dist');
const outDir = join(repoRoot, 'artifacts', 'release');
const outFile = join(outDir, 'release-manifest.json');
const kernelPath = join(
  repoRoot,
  'packages',
  'self-intersection-kernel',
  'artifacts',
  'self-intersection.wasm',
);

/** Files the provider consumes as configuration rather than serving. */
const PROVIDER_CONFIG_FILES = new Set(['_headers', '.assetsignore']);

/** Deliberately excluded from upload — see apps/web/public/.assetsignore. */
const isSourceMap = (path) => path.endsWith('.map');

const sha256 = (absolutePath) =>
  createHash('sha256').update(readFileSync(absolutePath)).digest('hex');

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(absolute));
    } else if (entry.isFile()) {
      found.push(absolute);
    }
  }
  return found;
}

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const commit = git('rev-parse', 'HEAD');
/**
 * A manifest built from a dirty tree does not describe the commit it names, and
 * saying so is the whole point of recording it.
 */
const workingTreeClean = git('status', '--porcelain') === '';

const everyFile = walk(distDir)
  .map((absolute) => relative(distDir, absolute).split('\\').join('/'))
  .sort();

const deployable = [];
const excluded = [];

for (const path of everyFile) {
  const absolute = join(distDir, path);
  const record = { path, bytes: statSync(absolute).size, sha256: sha256(absolute) };
  if (PROVIDER_CONFIG_FILES.has(path)) {
    excluded.push({ ...record, reason: 'provider-configuration-not-served' });
  } else if (isSourceMap(path)) {
    excluded.push({ ...record, reason: 'source-map-excluded-from-upload' });
  } else {
    deployable.push(record);
  }
}

const totalBytes = deployable.reduce((sum, f) => sum + f.bytes, 0);
const largest = deployable.reduce((a, b) => (b.bytes > a.bytes ? b : a), deployable[0]);

const manifest = {
  manifestVersion: 1,
  source: { commit, workingTreeClean },
  buildOutputDirectory: 'apps/web/dist',
  deployable: {
    fileCount: deployable.length,
    totalBytes,
    largestFile: { path: largest.path, bytes: largest.bytes },
    files: deployable,
  },
  excluded: { fileCount: excluded.length, files: excluded },
  kernel: {
    path: 'packages/self-intersection-kernel/artifacts/self-intersection.wasm',
    sha256: sha256(kernelPath),
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

process.stdout.write(
  `release manifest: ${relative(repoRoot, outFile)}\n` +
    `  commit            ${commit}${workingTreeClean ? '' : ' (WORKING TREE DIRTY)'}\n` +
    `  deployable files  ${deployable.length}\n` +
    `  deployable bytes  ${totalBytes}\n` +
    `  largest           ${largest.path} (${largest.bytes} bytes)\n` +
    `  excluded files    ${excluded.length}\n` +
    `  kernel sha256     ${manifest.kernel.sha256}\n`,
);
