import type { BakeoffRow } from './contract';
import { SCORING_MODEL } from './scoring';

/**
 * BAKEOFF RESULT FORMAT.
 *
 * JSON for machines, Markdown for people. Both are produced from the same rows,
 * so the readable summary cannot drift from the data — a hand-written summary
 * beside a machine-written file is a summary that will eventually be wrong.
 *
 * NO RAW GEOMETRY, ever. Results get committed, shared, and pasted into reviews.
 * A mesh in there would make the file unreadable and enormous, and would put
 * user-shaped data somewhere it travels.
 */

export interface BakeoffRun {
  /** ISO timestamp. */
  readonly startedAt: string;
  /** Machine description, for reproducibility. */
  readonly environment: string;
  /** Corpus revision, so a result can be tied to the fixtures that produced it. */
  readonly corpusVersion: string;
  readonly rows: readonly BakeoffRow[];
}

export function toJson(run: BakeoffRun): string {
  return JSON.stringify(run, null, 2);
}

/**
 * A readable summary. Deliberately leads with failures.
 *
 * A table sorted by speed with correctness in a column somewhere invites the
 * wrong reading. Disqualifications come first, then acceptance rates, then
 * everything else.
 */
export function toMarkdown(run: BakeoffRun): string {
  const lines: string[] = [
    '# Repair kernel bakeoff results',
    '',
    `Run: ${run.startedAt}`,
    `Environment: ${run.environment}`,
    `Corpus: ${run.corpusVersion}`,
    '',
    '> Generated. Do not edit by hand — regenerate from the JSON.',
    '',
  ];

  const candidates = [...new Set(run.rows.map((row) => row.candidateId))];

  lines.push('## Disqualifying outcomes', '');
  const disqualified = run.rows.filter((row) => row.verdict.forbidden.length > 0);
  if (disqualified.length === 0) {
    lines.push('None recorded.', '');
  } else {
    lines.push(
      '| Candidate | Fixture | Operation | Forbidden outcome |',
      '| --- | --- | --- | --- |',
    );
    for (const row of disqualified) {
      lines.push(
        `| ${row.candidateId} | ${row.fixtureId} | ${row.operation} | ${row.verdict.forbidden.join(', ')} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Acceptance by candidate',
    '',
    '| Candidate | Version | Accepted | Cases | Rate |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const candidate of candidates) {
    const rows = run.rows.filter((row) => row.candidateId === candidate);
    const accepted = rows.filter((row) => row.verdict.accepted).length;
    const first = rows[0];
    const rate = rows.length === 0 ? '—' : `${((accepted / rows.length) * 100).toFixed(0)}%`;
    lines.push(
      `| ${candidate} | ${first?.candidateVersion ?? '—'} | ${String(accepted)} | ${String(rows.length)} | ${rate} |`,
    );
  }
  lines.push('');

  lines.push('## Per-case detail', '');
  lines.push(
    '| Candidate | Fixture | Operation | Status | Kernel claim | Our verdict | ms | Δtris | Δcomponents |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const row of run.rows) {
    lines.push(
      [
        '',
        row.candidateId,
        row.fixtureId,
        row.operation,
        row.status,
        // Recorded beside our verdict precisely so a disagreement is visible.
        row.kernelReportedSuccess ? 'success' : 'failure',
        row.verdict.accepted ? '**accepted**' : 'rejected',
        row.elapsedMs.toFixed(1),
        row.geometryChange === undefined ? '—' : String(row.geometryChange.triangleDelta),
        row.geometryChange === undefined ? '—' : String(row.geometryChange.componentDelta),
        '',
      ].join(' | '),
    );
  }
  lines.push('');

  lines.push('## Scoring model in force', '', '| Dimension | Weight |', '| --- | --- |');
  for (const dimension of SCORING_MODEL) {
    lines.push(`| ${dimension.label} | ${String(dimension.weight)} |`);
  }
  lines.push(
    '',
    'Weights were frozen before this run. Changing them after seeing results',
    'would make them a rationalisation rather than a criterion.',
    '',
  );

  return lines.join('\n');
}
