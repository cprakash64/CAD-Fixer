#!/usr/bin/env node
/** Byte-aware deployment hygiene. Logical /src paths are deliberately permitted. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';

// Recognizable filesystem roots, not arbitrary slash-like binary bytes or URLs.
const LOCAL_PATH =
  /\/(?:Users|home)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_. -]+)*|\/private\/(?:tmp|var\/folders)\/[A-Za-z0-9_.-]+|\/tmp\/[A-Za-z0-9_.-]+|(?<![A-Za-z0-9_])[A-Za-z]:(?:\\+|\/)[A-Za-z0-9_. -]+(?:(?:\\+|\/)[A-Za-z0-9_. -]+)*/g;

export function scanArtifactPaths(bytes, { roots = [], username = userInfo().username } = {}) {
  const buffer = Buffer.from(bytes);
  const findings = [];
  // Also inspect UTF-16 strings in binary formats; ASCII scanning alone misses them.
  for (const [encoding, text, scale] of [
    ['bytes', buffer.toString('latin1'), 1],
    ['utf16le', buffer.toString('utf16le'), 2],
    [
      'utf16be',
      Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)))
        .swap16()
        .toString('utf16le'),
      2,
    ],
  ]) {
    for (const match of text.matchAll(LOCAL_PATH)) {
      // Emscripten's fixed virtual home is runtime state, not a host checkout.
      // Nested source paths under it still fail; this permits only the exact root.
      if (match[0] === '/home/web_user') continue;
      findings.push({ kind: 'local-absolute-path', encoding, offset: match.index * scale });
    }
    for (const root of roots.filter((value) => value.length > 1)) {
      const offset = text.indexOf(root);
      if (offset !== -1) findings.push({ kind: 'checkout-root', encoding, offset: offset * scale });
    }
    // Avoid generic account names (root, user, admin) that occur in normal runtime code.
    if (username.length >= 4 && !['root', 'user', 'admin', 'runner'].includes(username)) {
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`(?:^|[^A-Za-z0-9_])(${escaped})(?=$|[^A-Za-z0-9_])`).exec(text);
      if (match)
        findings.push({ kind: 'developer-username', encoding, offset: match.index * scale });
    }
  }
  return findings;
}

export function auditArtifactDirectory(directory, options = {}) {
  const findings = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        for (const finding of scanArtifactPaths(readFileSync(path), options))
          findings.push({ path, ...finding });
      }
    }
  };
  walk(directory);
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  if (targets.length === 0)
    throw new Error('usage: audit-artifact-paths.mjs <file-or-directory> ...');
  let files = 0;
  let failed = false;
  for (const target of targets) {
    const path = resolve(target);
    const findings = statSync(path).isDirectory()
      ? auditArtifactDirectory(path)
      : scanArtifactPaths(readFileSync(path)).map((finding) => ({ path, ...finding }));
    files += statSync(path).isDirectory() ? countFiles(path) : 1;
    if (findings.length) {
      failed = true;
      process.stderr.write(`${JSON.stringify(findings)}\n`);
    }
  }
  process.stdout.write(`Artifact path audit: ${files} files; ${failed ? 'FAIL' : 'PASS'}\n`);
  process.exitCode = failed ? 1 : 0;
}

function countFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (count, entry) =>
      count +
      (entry.isDirectory() ? countFiles(join(directory, entry.name)) : entry.isFile() ? 1 : 0),
    0,
  );
}
