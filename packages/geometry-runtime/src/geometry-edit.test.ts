/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-non-null-assertion, @typescript-eslint/restrict-template-expressions */
import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  partId,
  IDENTITY_PART_TRANSFORM,
  type CanonicalMesh,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import { isAppError } from '@cadfixer/shared';
import { GeometryEditStore, validateGeometryEdit } from './geometry-edit';
import { ResidentDocumentStore, isDocument } from './resident-documents';
import { RepairHistoryStore } from './repair-history';
function mesh(x = 0): CanonicalMesh {
  const positions = createPositionArray(9);
  positions.set([x, 0, 0, x + 1, 0, 0, x, 1, 0]);
  const indices = createIndexArray(3);
  indices.set([0, 1, 2]);
  return { positions, indices, metadata: { sourceFormat: '3mf' } };
}
function setup(count = 1, shared = false) {
  const resident = new ResidentDocumentStore(),
    history = new RepairHistoryStore(),
    edit = new GeometryEditStore(resident, history);
  const original = mesh();
  const doc: GeometryDocument = {
    unit: 'millimeter',
    parts: Array.from({ length: count }, (_, i) => ({
      id: partId(`part-${i + 1}`),
      name: `Part ${i + 1}`,
      transform: IDENTITY_PART_TRANSFORM,
      mesh: shared ? original : mesh(i),
    })),
  };
  const source = resident.commit(doc);
  return { resident, history, edit, doc, source };
}
function translated(source: CanonicalMesh, x: number): CanonicalMesh {
  const p = createPositionArray(source.positions.length);
  p.set(source.positions);
  for (let i = 0; i < p.length; i += 3) p[i] = (p[i] ?? 0) + x;
  const indices = createIndexArray(source.indices.length);
  indices.set(source.indices);
  return { ...source, positions: p, indices };
}
describe('worker-resident geometry edit transaction', () => {
  it('previews without mutation, commits one part, and restores exact sharing on undo', () => {
    const { resident, history, edit, doc, source } = setup(7, true),
      part = partId('part-3'),
      original = doc.parts[0]!.mesh;
    const ticket = edit.begin(source, part, 'test-translate');
    const candidate = edit.resolve(ticket, translated(doc.parts[2]!.mesh, 2));
    expect(edit.preview(candidate.candidate, (m) => m.positions[0])).toBe(2);
    expect(resident.resolve(source)).toBe(doc);
    const applied = edit.commit(candidate.candidate, source, part, (m) => ({ x: m.positions[0] }));
    expect(applied.render.x).toBe(2);
    expect(applied.handle.revision).toBe(2);
    const next = resident.resolve(applied.handle);
    expect(isDocument(next)).toBe(true);
    if (!isDocument(next)) return;
    expect(next.parts[2]!.mesh).not.toBe(original);
    for (let i = 0; i < 7; i++) if (i !== 2) expect(next.parts[i]).toBe(doc.parts[i]);
    expect(next.parts[2]!.transform).toEqual(doc.parts[2]!.transform);
    expect(next.parts[2]!.name).toBe('Part 3');
    expect(next.unit).toBe('millimeter');
    const undo = history.prepareUndo(applied.recordId, applied.handle, applied.handle.revision);
    expect(isAppError(undo)).toBe(false);
    if (isAppError(undo)) return;
    const restored: GeometryDocument = {
      ...next,
      parts: next.parts.map((p) => (p.id === part ? { ...p, mesh: undo.inverse.previousMesh } : p)),
    };
    const undoHandle = resident.replace(applied.handle, restored);
    expect(isAppError(undoHandle)).toBe(false);
    expect(restored.parts.every((p) => p.mesh === original)).toBe(true);
  });
  it('rejects late A after B begins, wrong part, cancellation, and stale revision', () => {
    const { resident, edit, doc, source } = setup(2);
    const a = edit.begin(source, partId('part-1'), 'A');
    const b = edit.begin(source, partId('part-2'), 'B');
    expect(() => edit.resolve(a, translated(doc.parts[0]!.mesh, 1))).toThrow(/superseded/);
    const c = edit.resolve(b, translated(doc.parts[1]!.mesh, 1));
    expect(() => edit.commit(c.candidate, source, partId('part-1'), () => 0)).toThrow(/different/);
    expect(edit.discard(c.candidate)).toBe(true);
    expect(() => edit.preview(c.candidate, () => 0)).toThrow(/stale/);
    const d = edit.begin(source, partId('part-1'), 'C');
    const e = edit.resolve(d, translated(doc.parts[0]!.mesh, 1));
    resident.replace(source, doc);
    expect(() => edit.commit(e.candidate, source, partId('part-1'), () => 0)).toThrow(/stale/);
  });
  it('leaves source and candidate untouched if render preparation fails', () => {
    const { resident, edit, doc, source } = setup(),
      part = partId('part-1');
    const c = edit.resolve(edit.begin(source, part, 'test'), translated(doc.parts[0]!.mesh, 1));
    expect(() =>
      edit.commit(c.candidate, source, part, () => {
        throw new Error('GPU snapshot failed');
      }),
    ).toThrow(/GPU snapshot/);
    expect(resident.resolve(source)).toBe(doc);
    expect(edit.stats().candidateCount).toBe(1);
  });
  it('names observed resource value and limit before accepting a candidate', () => {
    const { doc } = setup();
    expect(() =>
      validateGeometryEdit(mesh(), doc, partId('part-1'), {
        maxTriangles: 0,
        maxVertices: 10,
        maxCanonicalBytes: 1000,
        maxPreviewSnapshotBytes: 1000,
        maxEstimatedPeakBytes: 1000,
      }),
    ).toThrow(/triangle count is 1; limit is 0/);
  });
});
