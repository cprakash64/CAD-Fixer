import { afterEach, describe, expect, it } from 'vitest';
import {
  IDENTITY_PART_TRANSFORM,
  partId,
  singlePartDocument,
  type CanonicalMesh,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import {
  HOLE_FILL_MAX_PART_FACES,
  HoleFillStatus,
  type DocumentHandle,
  type OperationContext,
} from '@cadfixer/geometry-runtime';
import {
  CancellationSource,
  isAppError,
  operationCancelled,
  uncancellable,
} from '@cadfixer/shared';
import {
  hp01TriangleHole,
  hp02QuadHole,
  hp13BranchedBoundary,
  hp28AbovePartCeiling,
} from '@cadfixer/mesh-hole-fill/fixtures';
import {
  holeFillCandidates,
  holeFillDiscardHandler,
  holeFillListLoopsHandler,
  holeFillSendForFillHandler,
} from './hole-fill-handlers';
import { residentDocuments } from './stl-handlers';
import type { HoleFillWorkerReply } from './hole-fill-protocol';

/**
 * THE AUTHORITATIVE SIDE, and the four things it must never get wrong.
 *
 * ONE: it must not damage the authoritative geometry. It builds a copy and
 * TRANSFERS that copy, and transfer detaches — so a single wrong argument would
 * leave the worker holding empty buffers and the model gone. Checked byte for
 * byte, not by hashing.
 *
 * TWO: it must never register a candidate built from a revision the user has
 * left. HP31.
 *
 * THREE: it must refuse an unknown loop rather than defaulting to the first
 * one. Also HP31.
 *
 * FOUR: it must not move the document. Stage 4B-1B1 produces candidates; there
 * is no commit path and there must not be one.
 */

const PART = partId('part-1');

function context(cancellation = uncancellable): OperationContext {
  return {
    cancellation,
    interruptible: false,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

interface FakePort {
  readonly port: {
    postMessage(message: unknown, transfer?: unknown[]): void;
    close(): void;
    start(): void;
    onmessage: ((event: MessageEvent<HoleFillWorkerReply>) => void) | null;
  };
  readonly sent: { message: unknown; transfer: unknown[] }[];
  reply(message: HoleFillWorkerReply): void;
}

/** A port stand-in that records what it was given and can answer. */
function fakePort(): FakePort {
  const sent: { message: unknown; transfer: unknown[] }[] = [];
  const port = {
    onmessage: null as ((event: MessageEvent<HoleFillWorkerReply>) => void) | null,
    postMessage(message: unknown, transfer?: unknown[]): void {
      sent.push({ message, transfer: transfer ?? [] });
    },
    close(): void {
      // Nothing to release in a stub.
    },
    start(): void {
      // Nothing to start in a stub.
    },
  };
  return {
    port,
    sent,
    reply(message: HoleFillWorkerReply): void {
      port.onmessage?.(new MessageEvent('message', { data: message }));
    },
  };
}

function install(mesh: CanonicalMesh): DocumentHandle {
  return residentDocuments.commit(singlePartDocument(mesh));
}

async function loopIds(handle: DocumentHandle): Promise<readonly string[]> {
  const outcome = await holeFillListLoopsHandler({ handle, partId: PART }, context());
  return outcome.value.loops.map((loop) => loop.boundaryLoopId);
}

function candidateReply(operationId: string, mesh: CanonicalMesh): HoleFillWorkerReply {
  return {
    kind: 'result',
    operationId,
    status: HoleFillStatus.ValidCandidate,
    summary: emptySummary(),
    intersectionSamples: new Uint32Array(0),
    samplesTruncated: false,
    positions: new Float32Array(mesh.positions),
    indices: new Uint32Array(mesh.indices),
  };
}

function emptySummary(): Extract<HoleFillWorkerReply, { kind: 'result' }>['summary'] {
  return {
    boundaryVertexCount: 4,
    sourceFaceCount: 8,
    patchFaceCount: 2,
    addedVertexCount: 0,
    boundaryLoopsBefore: 2,
    boundaryLoopsAfter: 1,
    selectedLoopRemoved: true,
    degeneratePatchFaces: 0,
    duplicatePatchFaces: 0,
    foreignPatchCorners: 0,
    opposingBoundaryEdges: 4,
    agreeingBoundaryEdges: 0,
    invalidPatchSourcePairs: 0,
    invalidPatchPatchPairs: 0,
    broadphaseCandidates: 0,
    broadphaseAabbTests: 0,
    broadphaseNodeVisits: 0,
    narrowphaseChecks: 0,
    narrowphaseRefusals: 0,
    planarityRatio: 0,
    projectionAxis: 2,
    eulerApplicable: true,
    eulerBefore: 0,
    eulerAfter: 1,
    eulerPassed: true,
    totalDurationMs: 0,
    phaseMilliseconds: {
      loopResolution: 0,
      eligibility: 0,
      planarity: 0,
      triangulation: 0,
      candidateAssembly: 0,
      structuralValidation: 0,
      topologyValidation: 0,
      broadphase: 0,
      narrowphase: 0,
    },
  };
}

afterEach(() => {
  residentDocuments.releaseAll();
  holeFillCandidates.releaseAll();
});

describe('listing boundary loops', () => {
  it('names every component and says which are fillable', async () => {
    const handle = install(hp02QuadHole());
    const outcome = await holeFillListLoopsHandler({ handle, partId: PART }, context());

    // A tube has two rims, both simple cycles of four vertices.
    expect(outcome.value.loopCount).toBe(2);
    expect(outcome.value.loops).toHaveLength(2);
    expect(outcome.value.truncated).toBe(false);
    for (const loop of outcome.value.loops) {
      expect(loop.fillable).toBe(true);
      expect(loop.vertexCount).toBe(4);
      expect(loop.edgeCount).toBe(4);
      expect(loop.refusal).toBeUndefined();
      expect(loop.boundaryLoopId).toMatch(/^bl-/);
    }
  });

  it('reports a refused component with a CODE, never a sentence', async () => {
    const handle = install(hp13BranchedBoundary());
    const outcome = await holeFillListLoopsHandler({ handle, partId: PART }, context());
    const refused = outcome.value.loops.filter((loop) => !loop.fillable);
    expect(refused.length).toBeGreaterThan(0);
    for (const loop of refused) {
      expect(loop.refusal).toMatch(/^[A-Z_]+$/);
    }
  });

  it('caps the list without shrinking the COUNT', async () => {
    const handle = install(hp02QuadHole());
    const outcome = await holeFillListLoopsHandler({ handle, partId: PART, limit: 1 }, context());
    expect(outcome.value.loops).toHaveLength(1);
    expect(outcome.value.loopCount).toBe(2);
    expect(outcome.value.truncated).toBe(true);
  });

  it('carries no coordinates', async () => {
    const handle = install(hp02QuadHole());
    const outcome = await holeFillListLoopsHandler({ handle, partId: PART }, context());
    const serialised = JSON.stringify(outcome.value);
    expect(serialised).not.toContain('positions');
    expect(serialised).not.toContain('vertices');
  });

  it('refuses a part the document does not have', async () => {
    const handle = install(hp02QuadHole());
    const cause = await holeFillListLoopsHandler({ handle, partId: 'part-nope' }, context()).catch(
      (error: unknown) => error,
    );
    expect(isAppError(cause)).toBe(true);
  });
});

describe('the authoritative geometry survives byte for byte', () => {
  it('leaves every position and index byte untouched after sending a copy', async () => {
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const before = {
      positions: new Uint8Array(mesh.positions.buffer.slice(0) as ArrayBuffer),
      indices: new Uint8Array(mesh.indices.buffer.slice(0) as ArrayBuffer),
      positionLength: mesh.positions.length,
      indexLength: mesh.indices.length,
    };

    const ids = await loopIds(handle);
    const channel = fakePort();
    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-1',
        port: channel.port,
      },
      context(),
    );
    channel.reply({
      kind: 'result',
      operationId: 'op-1',
      status: HoleFillStatus.RefusedNonPlanar,
      summary: emptySummary(),
      intersectionSamples: new Uint32Array(0),
      samplesTruncated: false,
    });
    await pending;

    const document = residentDocuments.resolve(handle);
    expect(isAppError(document)).toBe(false);
    if (isAppError(document)) return;
    const resolved = document.parts[0]?.mesh;
    if (resolved === undefined) throw new Error('expected a part');

    // Lengths first: a transferred (detached) buffer reports zero.
    expect(resolved.positions.length).toBe(before.positionLength);
    expect(resolved.indices.length).toBe(before.indexLength);

    // Then every byte. A hash would prove difference, not identity.
    const positionsAfter = new Uint8Array(resolved.positions.buffer as ArrayBuffer);
    const indicesAfter = new Uint8Array(resolved.indices.buffer as ArrayBuffer);
    let differing = 0;
    for (let index = 0; index < before.positions.length; index += 1) {
      if (before.positions[index] !== positionsAfter[index]) differing += 1;
    }
    for (let index = 0; index < before.indices.length; index += 1) {
      if (before.indices[index] !== indicesAfter[index]) differing += 1;
    }
    expect(differing).toBe(0);

    // And the copy really was sent, with its OWN buffers in the transfer list.
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.transfer).toHaveLength(2);
  });

  it('sends CANONICAL Float32 positions, not widened doubles', async () => {
    // The engine's byte-level source-preservation check compares against these
    // exact bytes; widening here would validate something the model never is.
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const ids = await loopIds(handle);
    const channel = fakePort();
    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-2',
        port: channel.port,
      },
      context(),
    );
    const sent = channel.sent[0]?.message as { positions: unknown; indices: unknown };
    expect(sent.positions).toBeInstanceOf(Float32Array);
    expect(sent.indices).toBeInstanceOf(Uint32Array);

    channel.reply({
      kind: 'result',
      operationId: 'op-2',
      status: HoleFillStatus.RefusedNonPlanar,
      summary: emptySummary(),
      intersectionSamples: new Uint32Array(0),
      samplesTruncated: false,
    });
    await pending;
  });

  it('refuses a part above the ceiling BEFORE allocating a copy', async () => {
    const handle = install(hp28AbovePartCeiling(HOLE_FILL_MAX_PART_FACES + 1));
    const channel = fakePort();
    const cause = await holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: 'bl-anything',
        operationId: 'op-3',
        port: channel.port,
      },
      context(),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    // Nothing was posted, so nothing was copied.
    expect(channel.sent).toHaveLength(0);
  });
});

describe('HP31: a candidate from a revision the user has left is discarded', () => {
  it('reports STALE_REVISION and registers nothing', async () => {
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const ids = await loopIds(handle);
    const channel = fakePort();

    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-4',
        port: channel.port,
      },
      context(),
    );

    // The document moves on WHILE the fill worker is running.
    const replaced = residentDocuments.replace(handle, singlePartDocument(hp02QuadHole()));
    expect(isAppError(replaced)).toBe(false);

    channel.reply(candidateReply('op-4', mesh));
    const outcome = await pending;

    expect(outcome.value.status).toBe(HoleFillStatus.StaleRevision);
    expect(outcome.value.candidate).toBeUndefined();
    expect(holeFillCandidates.stats().candidateCount).toBe(0);
  });

  it('registers a candidate when the revision has NOT moved', async () => {
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const ids = await loopIds(handle);
    const channel = fakePort();

    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-5',
        port: channel.port,
      },
      context(),
    );
    channel.reply(candidateReply('op-5', mesh));
    const outcome = await pending;

    expect(outcome.value.status).toBe(HoleFillStatus.ValidCandidate);
    const candidate = outcome.value.candidate;
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    expect(candidate.partId).toBe(PART);
    expect(candidate.sourceRevision).toBe(handle.revision);
    expect(candidate.boundaryLoopId).toBe(ids[0]);
    expect(holeFillCandidates.stats().candidateCount).toBe(1);
  });
});

describe('HP31: a stale or unknown loop is refused, never substituted', () => {
  it('does not default to the first loop when the id is unknown', async () => {
    /*
     * The engine decides this, and the point of asserting it here is that the
     * handler passes the caller's id through UNCHANGED — no fallback, no
     * "nearest" loop, no index.
     */
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const channel = fakePort();

    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: 'bl-0-0-0000000000000000',
        operationId: 'op-6',
        port: channel.port,
      },
      context(),
    );
    const sent = channel.sent[0]?.message as { boundaryLoopId: string };
    expect(sent.boundaryLoopId).toBe('bl-0-0-0000000000000000');

    channel.reply({
      kind: 'result',
      operationId: 'op-6',
      status: HoleFillStatus.UnknownLoop,
      summary: emptySummary(),
      intersectionSamples: new Uint32Array(0),
      samplesTruncated: false,
    });
    const outcome = await pending;
    expect(outcome.value.status).toBe(HoleFillStatus.UnknownLoop);
    expect(outcome.value.candidate).toBeUndefined();
  });

  it('gives a loop a DIFFERENT id once the geometry changes', async () => {
    // The stale-loop case, stated as the property that makes it detectable.
    const first = install(hp02QuadHole());
    const before = await loopIds(first);
    residentDocuments.releaseAll();

    const second = install(hp13BranchedBoundary());
    const after = await loopIds(second);
    for (const id of after) expect(before).not.toContain(id);
  });
});

describe('a fill worker failure is contained', () => {
  it('surfaces a typed error and registers no candidate', async () => {
    const handle = install(hp02QuadHole());
    const ids = await loopIds(handle);
    const channel = fakePort();

    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-7',
        port: channel.port,
      },
      context(),
    );
    channel.reply({ kind: 'failed', operationId: 'op-7', reason: 'the engine threw' });

    const cause = await pending.catch((error: unknown) => error);
    expect(isAppError(cause)).toBe(true);
    expect(holeFillCandidates.stats().candidateCount).toBe(0);

    // AND the document is exactly where it was.
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(handle.revision);
  });

  it('settles on cancellation rather than waiting for a dead worker', async () => {
    const handle = install(hp02QuadHole());
    const ids = await loopIds(handle);
    const channel = fakePort();
    const source = new CancellationSource();

    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-8',
        port: channel.port,
      },
      context(source.token),
    );

    // The controller terminated the worker; the channel will never answer.
    source.cancel();

    const cause = await pending.catch((error: unknown) => error);
    expect(isAppError(cause)).toBe(true);
    expect(holeFillCandidates.stats().candidateCount).toBe(0);
  });
});

describe('Stage 4B-1B1 produces candidates and nothing else', () => {
  it('never moves the document revision, for any outcome', async () => {
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const ids = await loopIds(handle);

    for (const [index, status] of [
      HoleFillStatus.ValidCandidate,
      HoleFillStatus.RefusedNonPlanar,
      HoleFillStatus.SelfIntersectionCreated,
    ].entries()) {
      const channel = fakePort();
      const pending = holeFillSendForFillHandler(
        {
          handle,
          partId: PART,
          boundaryLoopId: ids[0] ?? '',
          operationId: `op-r${String(index)}`,
          port: channel.port,
        },
        context(),
      );
      channel.reply(
        status === HoleFillStatus.ValidCandidate
          ? candidateReply(`op-r${String(index)}`, mesh)
          : {
              kind: 'result',
              operationId: `op-r${String(index)}`,
              status,
              summary: emptySummary(),
              intersectionSamples: new Uint32Array(0),
              samplesTruncated: false,
            },
      );
      await pending;
      expect(residentDocuments.revisionOf(handle.documentId)).toBe(handle.revision);
    }
  });

  it('supersedes an earlier candidate rather than keeping two alive', async () => {
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const ids = await loopIds(handle);

    const build = async (operationId: string): Promise<void> => {
      const channel = fakePort();
      const pending = holeFillSendForFillHandler(
        { handle, partId: PART, boundaryLoopId: ids[0] ?? '', operationId, port: channel.port },
        context(),
      );
      channel.reply(candidateReply(operationId, mesh));
      await pending;
    };

    await build('op-a');
    await build('op-b');
    expect(holeFillCandidates.stats().candidateCount).toBe(1);
  });

  it('releases a candidate on discard, idempotently', async () => {
    const mesh = hp02QuadHole();
    const handle = install(mesh);
    const ids = await loopIds(handle);
    const channel = fakePort();
    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-9',
        port: channel.port,
      },
      context(),
    );
    channel.reply(candidateReply('op-9', mesh));
    const candidate = (await pending).value.candidate;
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    const first = await holeFillDiscardHandler({ candidate }, context());
    expect(first.value.released).toBe(true);
    const second = await holeFillDiscardHandler({ candidate }, context());
    expect(second.value.released).toBe(false);
    expect(holeFillCandidates.stats().candidateCount).toBe(0);
  });
});

describe('REVIEW A: multi-part targeting, and the ambiguity that makes it worth testing', () => {
  const PART_A = partId('part-a');
  const PART_B = partId('part-b');

  function twoParts(a: CanonicalMesh, b: CanonicalMesh): GeometryDocument {
    return {
      parts: [
        { id: PART_A, mesh: a, transform: IDENTITY_PART_TRANSFORM, name: 'A' },
        { id: PART_B, mesh: b, transform: IDENTITY_PART_TRANSFORM, name: 'B' },
      ],
    };
  }

  async function idsFor(handle: DocumentHandle, part: string): Promise<readonly string[]> {
    const outcome = await holeFillListLoopsHandler({ handle, partId: part }, context());
    return outcome.value.loops.map((loop) => loop.boundaryLoopId);
  }

  it('lists each part separately and never mixes their loops', async () => {
    const handle = residentDocuments.commit(twoParts(hp02QuadHole(), hp01TriangleHole()));
    const a = await holeFillListLoopsHandler({ handle, partId: PART_A }, context());
    const b = await holeFillListLoopsHandler({ handle, partId: PART_B }, context());

    expect(a.value.partId).toBe(PART_A);
    expect(b.value.partId).toBe(PART_B);
    for (const loop of a.value.loops) expect(loop.vertexCount).toBe(4);
    for (const loop of b.value.loops) expect(loop.vertexCount).toBe(3);
  });

  it('gives two parts sharing ONE mesh the same loop ids, and the PART disambiguates', async () => {
    /*
     * A REAL AMBIGUITY, made deliberate. Loop identity is unique WITHIN a part,
     * which is all it has to be: an operation already names a document, a
     * revision and a part. Two parts sharing one `CanonicalMesh` therefore
     * carry identical loop ids — so the thing that must decide which geometry
     * is filled is the `partId`, and this proves it does.
     */
    const shared = hp02QuadHole();
    const handle = residentDocuments.commit(twoParts(shared, shared));

    const a = await idsFor(handle, PART_A);
    const b = await idsFor(handle, PART_B);
    expect(b).toEqual(a);

    const channel = fakePort();
    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART_B,
        boundaryLoopId: a[0] ?? '',
        operationId: 'op-A1',
        port: channel.port,
      },
      context(),
    );
    channel.reply(candidateReply('op-A1', shared));
    const outcome = await pending;

    // Asked for B, got B — not A, whose id was passed.
    expect(outcome.value.candidate?.partId).toBe(PART_B);
  });

  it('leaves the OTHER part byte-identical, including when the mesh is shared', async () => {
    const shared = hp02QuadHole();
    const handle = residentDocuments.commit(twoParts(shared, shared));
    const before = new Uint8Array(shared.positions.buffer.slice(0) as ArrayBuffer);

    const ids = await idsFor(handle, PART_A);
    const channel = fakePort();
    const pending = holeFillSendForFillHandler(
      {
        handle,
        partId: PART_A,
        boundaryLoopId: ids[0] ?? '',
        operationId: 'op-A2',
        port: channel.port,
      },
      context(),
    );
    channel.reply(candidateReply('op-A2', shared));
    await pending;

    const document = residentDocuments.resolve(handle);
    expect(isAppError(document)).toBe(false);
    if (isAppError(document)) return;

    // STILL ONE MESH: producing a candidate must not break structural sharing.
    expect(document.parts[0]?.mesh).toBe(document.parts[1]?.mesh);
    expect(document.parts[1]?.id).toBe(PART_B);
    expect(document.parts[1]?.transform).toEqual(IDENTITY_PART_TRANSFORM);

    const after = new Uint8Array(
      (document.parts[0]?.mesh.positions.buffer ?? new ArrayBuffer(0)) as ArrayBuffer,
    );
    expect(after).toEqual(before);
  });

  it('refuses a part id the document does not carry rather than picking one', async () => {
    const handle = residentDocuments.commit(twoParts(hp02QuadHole(), hp01TriangleHole()));
    const channel = fakePort();
    const cause = await holeFillSendForFillHandler(
      {
        handle,
        partId: 'part-zzz',
        boundaryLoopId: 'bl-anything',
        operationId: 'op-A3',
        port: channel.port,
      },
      context(),
    ).catch((error: unknown) => error);

    expect(isAppError(cause)).toBe(true);
    expect(channel.sent).toHaveLength(0);
  });
});
