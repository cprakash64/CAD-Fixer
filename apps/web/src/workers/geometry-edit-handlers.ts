import {
  computeBounds,
  documentTriangleCount,
  documentVertexCount,
  partId,
} from '@cadfixer/mesh-core';
import { documentByteLength, type OperationHandler } from '@cadfixer/geometry-runtime';
import {
  buildRenderSnapshot,
  describeParts,
  geometryEdits,
  holeFillCandidates,
  repairCandidates,
} from './stl-handlers';

/** Generic preview: a disposable render snapshot of the stored candidate. */
export const editPreviewHandler: OperationHandler<'edit/preview'> = (payload, context) => {
  context.throwIfCancelled();
  const render = geometryEdits.preview(payload.candidate, buildRenderSnapshot);
  context.throwIfCancelled();
  return Promise.resolve({
    value: { candidate: payload.candidate, render },
    transfer: [render.positions.buffer, render.normals.buffer],
  });
};

/** Builds every fallible reply field before GeometryEditStore swaps authority. */
export const editCommitHandler: OperationHandler<'edit/commit'> = (payload, context) => {
  context.throwIfCancelled();
  const applied = geometryEdits.commit(
    payload.candidate,
    payload.expectedSource,
    partId(payload.expectedPart),
    (mesh, document) => ({
      render: buildRenderSnapshot(mesh),
      parts: describeParts(document),
      residentBytes: documentByteLength(document),
      triangleCount: documentTriangleCount(document),
      vertexCount: documentVertexCount(document),
      bounds: computeBounds(mesh),
    }),
  );
  holeFillCandidates.releaseDocument(applied.handle.documentId);
  repairCandidates.releaseDocument(applied.handle.documentId);
  const { render, ...facts } = applied.render;
  return Promise.resolve({
    value: {
      handle: applied.handle,
      parentRevision: payload.expectedSource.revision,
      recordId: applied.recordId,
      partId: applied.partId,
      render,
      ...facts,
      resources: applied.resources,
    },
    transfer: [render.positions.buffer, render.normals.buffer],
  });
};
export const editDiscardHandler: OperationHandler<'edit/discard'> = (payload) =>
  Promise.resolve({ value: { released: geometryEdits.discard(payload.candidate) } });
