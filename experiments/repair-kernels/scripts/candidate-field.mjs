#!/usr/bin/env node
/**
 * Reads one field of one candidate out of `candidates.json`.
 *
 * A separate tiny program rather than inline shell, because the pinned identity
 * is the one thing in this stage that must not be fragile: a quoting accident
 * that silently produced an empty SHA would clone a default branch and the
 * whole bakeoff would describe unidentifiable software.
 *
 * Usage: candidate-field.mjs <candidate-id> <field>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , id, field] = process.argv;
if (id === undefined || field === undefined) {
  console.error('usage: candidate-field.mjs <candidate-id> <field>');
  process.exit(2);
}

const manifestPath = join(import.meta.dirname, '..', 'candidates.json');
/** @type {{ candidates: Record<string, unknown>[] }} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const entry = manifest.candidates.find((candidate) => candidate['id'] === id);
if (entry === undefined) {
  console.error(`unknown candidate: ${id}`);
  process.exit(1);
}

const value = entry[field];
if (value === undefined || value === null) {
  console.error(`candidate ${id} has no field ${field}`);
  process.exit(1);
}
process.stdout.write(String(value));
