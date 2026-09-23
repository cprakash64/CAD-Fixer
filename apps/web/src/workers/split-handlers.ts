import { documentTriangleCount, documentVertexCount, partId } from '@cadfixer/mesh-core';
import {
  documentByteLength,
  splitWithConnectors,
  type OperationHandler,
} from '@cadfixer/geometry-runtime';
import {
  booleanOperations,
  buildDocumentRenderSnapshot,
  describeParts,
  documentRenderTransferables,
  documentBounds,
  residentDocuments,
  splitCandidates,
} from './stl-handlers';
import { isPart } from '@cadfixer/geometry-runtime';
import type { BooleanKind } from '@cadfixer/geometry-runtime';
import type { BooleanOperationPhase } from './boolean-operation-protocol';

export interface SplitQualificationEvent {
  readonly documentId: string;
  readonly generation: number;
  readonly booleanIndex: number;
  readonly operation: BooleanKind;
  readonly phase: BooleanOperationPhase | 'TERMINAL';
  readonly at: number;
  readonly stats: {
    readonly active: number;
    readonly created: number;
    readonly terminated: number;
  };
}
let qualificationObserver: ((event: SplitQualificationEvent) => void) | undefined;
/** Harness-only observation seam; production leaves it unset. */
export function setSplitQualificationObserver(
  observer: ((event: SplitQualificationEvent) => void) | undefined,
): void {
  qualificationObserver = observer;
}

export const splitCreateHandler: OperationHandler<'split/create'> = async (payload, context) => {
  context.throwIfCancelled();
  const sourcePart = residentDocuments.resolvePart(payload.source, partId(payload.partId));
  if (!isPart(sourcePart)) throw sourcePart;
  const ticket = splitCandidates.begin(payload.source, sourcePart.id);
  let booleanIndex = 0;
  try {
    context.reportProgress(0.05, 'checking split');
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, cancellation) => {
          const index = booleanIndex++;
          return booleanOperations.run(kind, a, b, cancellation, {
            owner: { documentId: ticket.documentId, generation: ticket.generation },
            onPhase: (timing) =>
              qualificationObserver?.({
                documentId: ticket.documentId,
                generation: ticket.generation,
                booleanIndex: index,
                operation: kind,
                ...timing,
                stats: booleanOperations.stats,
              }),
          });
        },
      },
      sourcePart.mesh,
      payload.request,
      context.cancellation,
    );
    context.reportProgress(0.85, 'validating pieces');
    const summary = splitCandidates.resolve(ticket, result, context.cancellation);
    const preview = splitCandidates.preview(summary.candidate, (document) => ({
      render: buildDocumentRenderSnapshot(document),
      parts: describeParts(document),
    }));
    context.reportProgress(1, 'preview ready');
    return {
      value: { ...summary, ...preview },
      transfer: documentRenderTransferables(preview.render),
    };
  } catch (error) {
    splitCandidates.fail(ticket);
    throw error;
  } finally {
    qualificationObserver?.({
      documentId: ticket.documentId,
      generation: ticket.generation,
      booleanIndex,
      operation: 'intersection',
      phase: 'TERMINAL',
      at: performance.now(),
      stats: booleanOperations.stats,
    });
  }
};

export const splitCommitHandler: OperationHandler<'split/commit'> = (payload, context) => {
  context.throwIfCancelled();
  const committed = splitCandidates.commit(
    payload.candidate,
    payload.expectedSource,
    partId(payload.expectedPart),
    (document) => ({
      render: buildDocumentRenderSnapshot(document),
      parts: describeParts(document),
      residentBytes: documentByteLength(document),
      triangleCount: documentTriangleCount(document),
      vertexCount: documentVertexCount(document),
      bounds: documentBounds(document),
    }),
  );
  const value = {
    ...committed.summary,
    ...committed.value,
    handle: committed.handle,
    parentRevision: payload.expectedSource.revision,
    recordId: committed.recordId,
  };
  return Promise.resolve({ value, transfer: documentRenderTransferables(value.render) });
};

export const splitDiscardHandler: OperationHandler<'split/discard'> = (payload) =>
  Promise.resolve({ value: { released: splitCandidates.discard(payload.candidate) } });
