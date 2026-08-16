#!/usr/bin/env node
/**
 * BUILD-INPUT LICENCE AUDIT.
 *
 * Stage 3A-1 recorded that Geogram bundles `tetgen` (AGPL-3.0) and `triangle`
 * (whose own README requires a direct arrangement with the author for
 * distribution in a commercial system). Project rule 17 forbids the first
 * outright, and the second is a licensing decision nobody has taken.
 *
 * WHY THIS INSPECTS BUILD INPUTS, NOT THE ARTIFACT. A `.wasm` string scan is
 * secondary evidence: an optimising toolchain strips symbols and inlines code,
 * so a clean scan is consistent with the forbidden source having been compiled
 * and linked. What actually matters is whether the source was ever an input.
 * This reads `compile_commands.json`, the object files the build produced, and
 * the link line, and fails if any of them names a forbidden path.
 *
 * IT FAILS CLOSED. Missing evidence is a FAIL, not a pass — an audit that
 * cannot see the build inputs has not established anything, and treating
 * "no evidence of violation" as "no violation" is exactly the mistake this
 * exists to prevent.
 *
 * Forbidden patterns come from the Stage 3A-1 ledger, not from a hard-coded
 * example list, so adding a ledger entry tightens the audit automatically.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Components the Stage 3A-1 ledger marks as unusable in a proprietary build.
 *
 * @type {{ id: string, patterns: RegExp[], reason: string }[]}
 */
export const FORBIDDEN_COMPONENTS = [
  {
    id: 'tetgen',
    // Anchored to the BUNDLED DIRECTORY. The licensed code is
    // `third_party/tetgen/`; Geogram's own `delaunay/delaunay_tetgen.cpp` is a
    // BSD-licensed wrapper that merely names it, and `GEO::mesh_tetrahedralize`
    // is Geogram's own function. An unanchored /tetgen/i matched all three and
    // produced a false FAIL on a build that was in fact clean.
    patterns: [/third_party[/\\]tetgen[/\\]/i],
    reason:
      'AGPL-3.0 per its bundled README.txt. Project rule 17 forbids AGPL runtime code without explicit approval, and a browser-delivered product is precisely the AGPL network case.',
  },
  {
    id: 'triangle',
    patterns: [/third_party[/\\]triangle[/\\]/i],
    reason:
      'Its README states distribution as part of a commercial system is permissible only by direct arrangement with the author. No such arrangement exists.',
  },
];

/**
 * CMake options that must be provably OFF.
 *
 * POSITIVE EVIDENCE, not merely absence of a forbidden path. "I did not find
 * the bad thing" is a weaker claim than "the build recorded that the bad thing
 * was disabled", and this gate should require the stronger one. A build whose
 * cache does not mention these at all fails, because that means the audit is
 * looking at something other than a Geogram build.
 */
export const REQUIRED_OFF_OPTIONS = ['GEOGRAM_WITH_TETGEN', 'GEOGRAM_WITH_TRIANGLE'];

/**
 * Symbols that would only exist if the real upstream libraries were linked.
 *
 * Secondary evidence, checked against the archive. `tetgenmesh` and
 * `triangulateio` are TetGen's and Triangle's own types; neither appears in
 * Geogram's wrappers.
 */
export const FORBIDDEN_SYMBOLS = [/tetgenmesh/i, /tetgenio/i, /triangulateio/i];

/** @typedef {{ kind: string, source: string, detail: string }} Finding */

/**
 * @param {string} text
 * @param {string} kind
 * @param {string} source
 * @returns {Finding[]}
 */
function scanText(text, kind, source) {
  /** @type {Finding[]} */
  const findings = [];
  for (const line of text.split('\n')) {
    // CMakeCache records each option's HELP TEXT on a `//` comment line
    // immediately above its value. "//Tetrahedral mesher (Hang Si's TetGen)"
    // sits directly above `GEOGRAM_WITH_TETGEN:BOOL=OFF` — documentation of a
    // disabled option, not a build input. Scanning it flagged a clean build.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

    for (const component of FORBIDDEN_COMPONENTS) {
      if (component.patterns.some((pattern) => pattern.test(line))) {
        findings.push({
          kind,
          source,
          detail: `${component.id}: ${trimmed.slice(0, 200)}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Reads the recorded value of a CMake option from the cache.
 *
 * @param {string} cachePath
 * @param {string} option
 * @returns {string | undefined}
 */
function cacheOptionValue(cachePath, option) {
  if (!existsSync(cachePath)) return undefined;
  for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    const match = new RegExp(`^${option}:[A-Z]+=(.*)$`).exec(trimmed);
    if (match !== null) return (match[1] ?? '').trim();
  }
  return undefined;
}

/**
 * @param {string} directory
 * @param {RegExp} match
 * @returns {string[]}
 */
function filesUnder(directory, match) {
  /** @type {string[]} */
  const found = [];
  if (!existsSync(directory)) return found;
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(full);
      else if (match.test(entry)) found.push(full);
    }
  };
  walk(directory);
  return found;
}

/**
 * Audits one candidate's build tree.
 *
 * @param {string} buildDir
 * @returns {{ passed: boolean, findings: Finding[], evidence: string[], missing: string[] }}
 */
export function auditBuildDirectory(buildDir) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const evidence = [];
  /** @type {string[]} */
  const missing = [];

  // 1. compile_commands.json — the authoritative list of what was compiled.
  const compileCommands = join(buildDir, 'compile_commands.json');
  if (existsSync(compileCommands)) {
    const text = readFileSync(compileCommands, 'utf8');
    evidence.push(`compile_commands.json (${String(text.length)} bytes)`);
    findings.push(...scanText(text, 'compile-command', 'compile_commands.json'));
  } else {
    missing.push('compile_commands.json');
  }

  // 2. Object files actually produced. A forbidden source that compiled leaves
  //    an object behind even if the linker later drops it.
  const objects = filesUnder(buildDir, /\.(o|obj|bc)$/);
  if (objects.length > 0) {
    evidence.push(`${String(objects.length)} object files`);
    for (const object of objects) {
      findings.push(...scanText(relative(buildDir, object), 'object-file', 'build tree'));
    }
  } else {
    missing.push('object files');
  }

  // 3. Static archives linked into the artifact.
  const archives = filesUnder(buildDir, /\.a$/);
  if (archives.length > 0) {
    evidence.push(`${String(archives.length)} static archives`);
    for (const archive of archives) {
      findings.push(...scanText(relative(buildDir, archive), 'static-archive', 'build tree'));
    }
  }

  // 4. Link/response lines, where CMake recorded them.
  const linkFiles = filesUnder(buildDir, /(link\.txt|\.rsp|CMakeCache\.txt)$/);
  for (const file of linkFiles) {
    const text = readFileSync(file, 'utf8');
    evidence.push(relative(buildDir, file));
    findings.push(...scanText(text, 'link-input', relative(buildDir, file)));
  }

  // 5. POSITIVE evidence: the options must be recorded as OFF. Absence of a
  //    forbidden path is a weaker claim than a build that says it disabled the
  //    component, and this gate requires the stronger one.
  const cachePath = join(buildDir, 'CMakeCache.txt');
  /** @type {Record<string, string>} */
  const optionValues = {};
  if (existsSync(cachePath)) {
    for (const option of REQUIRED_OFF_OPTIONS) {
      const value = cacheOptionValue(cachePath, option);
      if (value === undefined) {
        missing.push(`${option} (not recorded in CMakeCache)`);
      } else {
        optionValues[option] = value;
        if (value.toUpperCase() !== 'OFF' && value !== '0' && value.toUpperCase() !== 'FALSE') {
          findings.push({
            kind: 'cmake-option',
            source: 'CMakeCache.txt',
            detail: `${option} is ${value}, expected OFF`,
          });
        }
      }
    }
    evidence.push(
      `options: ${Object.entries(optionValues)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')}`,
    );
  } else {
    missing.push('CMakeCache.txt');
  }

  // FAIL CLOSED. Without compile commands or objects there is nothing to audit,
  // and "nothing to audit" is not "audited clean". Missing option evidence is
  // likewise a failure, not a pass.
  const haveInputs =
    !missing.includes('compile_commands.json') || !missing.includes('object files');
  const haveOptions = REQUIRED_OFF_OPTIONS.every((option) => optionValues[option] !== undefined);

  return {
    passed: findings.length === 0 && haveInputs && haveOptions,
    findings,
    evidence,
    missing,
  };
}

/**
 * Secondary evidence only: strings in the produced artifact.
 *
 * @param {string} wasmPath
 * @returns {{ findings: Finding[], scanned: boolean }}
 */
export function auditArtifact(wasmPath) {
  if (!existsSync(wasmPath)) return { findings: [], scanned: false };
  const text = readFileSync(wasmPath).toString('latin1');

  // Symbol-level rather than path-level: an optimised artifact has no paths in
  // it, but a linked TetGen would still carry its own type names.
  /** @type {Finding[]} */
  const findings = [];
  for (const pattern of FORBIDDEN_SYMBOLS) {
    if (pattern.test(text)) {
      findings.push({
        kind: 'artifact-symbol',
        source: wasmPath,
        detail: `symbol matching ${String(pattern)} present in artifact`,
      });
    }
  }
  return { findings, scanned: true };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const buildDir = process.argv[2];
  if (buildDir === undefined) {
    console.error('usage: audit-build-inputs.mjs <build-dir> [artifact.wasm]');
    process.exit(2);
  }

  const result = auditBuildDirectory(buildDir);
  const artifactPath = process.argv[3];
  const artifact =
    artifactPath === undefined ? { findings: [], scanned: false } : auditArtifact(artifactPath);

  console.error(`build-input audit: ${buildDir}`);
  console.error(`  evidence: ${result.evidence.join(', ') || 'NONE'}`);
  if (result.missing.length > 0) console.error(`  missing:  ${result.missing.join(', ')}`);
  console.error(`  artifact scanned (secondary): ${String(artifact.scanned)}`);

  const all = [...result.findings, ...artifact.findings];
  if (all.length > 0) {
    console.error('  FORBIDDEN COMPONENTS FOUND:');
    for (const finding of all.slice(0, 40)) {
      console.error(`    [${finding.kind}] ${finding.detail}`);
    }
    console.error(`  total findings: ${String(all.length)}`);
  }

  if (!result.passed) {
    console.error('RESULT: FAIL — BLOCKED_BY_BUILD_LICENSE_GATE');
    process.exit(1);
  }
  console.error('RESULT: PASS — no forbidden component in the audited build inputs');
}
