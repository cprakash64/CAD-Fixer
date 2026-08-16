import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * REFUSES TO RUN THE PROJECT ON AN UNSUPPORTED NODE.
 *
 * This exists because of a specific, observed failure, not as a formality. On
 * Node 20, jsdom cannot load — undici calls `webidl.util.markAsUncloneable`,
 * which that runtime does not have. Vitest reports the affected files as
 * "failed to start", still prints a passing summary for everything else, and
 * **exits zero**. A developer in a shell that had not sourced nvm therefore saw
 * "17 files, 356 tests passed" and a green exit while five application test
 * files had never run at all. A false green is worse than a red.
 *
 * `.nvmrc` and the CI `node-version-file` pin already handle the machines that
 * read them. Neither protects a local shell that simply has the wrong Node on
 * its PATH, which is exactly the case that produced the false green.
 *
 * Written in plain JavaScript with no dependencies, so it runs under whatever
 * Node the user actually has — before any build step, and before anything that
 * could itself fail confusingly on an old runtime.
 *
 * The requirement is read from `engines.node` in package.json, so there is one
 * source of truth and this file cannot drift from it.
 */

/**
 * @typedef {{ major: number, minor: number, patch: number }} Version
 */

/**
 * Parses a plain `major.minor.patch` version, tolerating a leading `v` and any
 * pre-release or build suffix.
 *
 * @param {string} text
 * @returns {Version | undefined} undefined when the text is not a version.
 */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Extracts the minimum from a `>=x.y.z` engines range.
 *
 * Deliberately narrow: this project declares exactly one lower bound, and
 * quietly accepting a range shape it does not actually understand would be a
 * worse failure than refusing to guess.
 *
 * @param {string} range
 * @returns {Version | undefined}
 */
export function parseMinimum(range) {
  const match = /^>=\s*(.+)$/.exec(range.trim());
  if (match === null) return undefined;
  return parseVersion(match[1] ?? '');
}

/**
 * True when `actual` is at or above `minimum`.
 *
 * A HIGHER MAJOR IS ACCEPTED. The hazard this guard exists for is an OLD
 * runtime missing APIs the toolchain needs; a newer Node is not that hazard, and
 * refusing to start on one would make the guard the problem. Newer majors are
 * therefore allowed through, and any incompatibility they bring is expected to
 * surface as a real failure rather than as a version refusal here.
 *
 * @param {Version} actual
 * @param {Version} minimum
 * @returns {boolean}
 */
export function meetsMinimum(actual, minimum) {
  if (actual.major !== minimum.major) return actual.major > minimum.major;
  if (actual.minor !== minimum.minor) return actual.minor > minimum.minor;
  return actual.patch >= minimum.patch;
}

/**
 * Reads the `engines.node` requirement from the repository's package.json.
 *
 * @returns {string}
 */
export function readEnginesRange() {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = readFileSync(join(here, '..', 'package.json'), 'utf8');
  /** @type {{ engines?: { node?: string } }} */
  const parsed = JSON.parse(manifest);
  const range = parsed.engines?.node;
  if (range === undefined) {
    throw new Error('package.json does not declare engines.node, so there is nothing to enforce.');
  }
  return range;
}

/**
 * @param {string} actualText
 * @param {string} range
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkVersion(actualText, range) {
  const actual = parseVersion(actualText);
  const minimum = parseMinimum(range);

  if (minimum === undefined) {
    return {
      ok: false,
      message: `Cannot interpret the required Node range "${range}". Expected a form like ">=22.12.0".`,
    };
  }
  if (actual === undefined) {
    return { ok: false, message: `Cannot interpret the running Node version "${actualText}".` };
  }
  if (!meetsMinimum(actual, minimum)) {
    return {
      ok: false,
      message: [
        'Unsupported Node version.',
        `  running:  ${actualText}`,
        `  required: ${range}`,
        '',
        'Older runtimes fail to load jsdom, and the test runner can still exit',
        'zero after silently skipping the files that failed to start — a green',
        'result that proves nothing. Refusing to continue.',
        '',
        'This repository pins its version in .nvmrc. Run `nvm use` and retry.',
      ].join('\n'),
    };
  }
  return { ok: true };
}

// Only when run as a command, so importing this for tests cannot exit anything.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const result = checkVersion(process.version, readEnginesRange());
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}
