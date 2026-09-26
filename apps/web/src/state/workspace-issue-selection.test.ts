import { describe, expect, it } from 'vitest';
import type { DocumentHandle, DocumentId } from '@cadfixer/geometry-runtime';
import { RepairIssueId } from './repair-issues';
import { analysisKey, WorkspaceStore } from './workspace-store';

/**
 * The Repair workspace's ONE issue selection and its frame command.
 *
 * The selection carries the key of the analysis it was made against, so every
 * surface that resolves it can tell a stale one from a current one without the
 * store having to clear it on each of the many paths that change geometry.
 */
/** Same construction as the other store tests: a branded id from a string. */
function handle(documentId: string, revision: number): DocumentHandle {
  return { documentId: documentId as DocumentId, revision };
}

describe('issue selection', () => {
  it('keys a selection to one document revision and part', () => {
    const key = analysisKey(handle('doc', 3), 'part-1');
    expect(key).toBe('doc@3/part-1');
    expect(analysisKey(undefined, 'part-1')).toBeUndefined();
    expect(analysisKey(handle('doc', 3), undefined)).toBeUndefined();
    // A later revision of the same part is a different key: a selection made
    // before a repair cannot resolve after it.
    expect(analysisKey(handle('doc', 4), 'part-1')).not.toBe(key);
  });

  it('selects at the first occurrence, moves within the issue, and clears', () => {
    const store = new WorkspaceStore();
    store.selectIssue(RepairIssueId.WindingConflicts, 'doc@1/p');
    expect(store.getSnapshot().issueSelection).toEqual({
      issue: RepairIssueId.WindingConflicts,
      occurrence: 0,
      key: 'doc@1/p',
    });

    store.setIssueOccurrence(2);
    expect(store.getSnapshot().issueSelection?.occurrence).toBe(2);

    // Choosing another issue starts it from its first occurrence.
    store.selectIssue(RepairIssueId.DegenerateFaces, 'doc@1/p');
    expect(store.getSnapshot().issueSelection?.occurrence).toBe(0);

    store.selectIssue(undefined, undefined);
    expect(store.getSnapshot().issueSelection).toBeUndefined();
    // Moving with nothing selected does nothing.
    store.setIssueOccurrence(1);
    expect(store.getSnapshot().issueSelection).toBeUndefined();
  });

  it('issues frame requests as commands, so the same place can be framed twice', () => {
    const store = new WorkspaceStore();
    store.requestFrame('doc@1/p', [1, 2, 3], 4);
    const first = store.getSnapshot().frameRequest;
    store.requestFrame('doc@1/p', [1, 2, 3], 4);
    const second = store.getSnapshot().frameRequest;
    expect(first?.sequence).toBe(1);
    expect(second?.sequence).toBe(2);
    expect(second).toMatchObject({ key: 'doc@1/p', center: [1, 2, 3], radius: 4 });
  });
});
