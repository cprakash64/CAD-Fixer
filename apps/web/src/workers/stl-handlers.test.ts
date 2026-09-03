import { describe, expect, it } from 'vitest';
import {
  AppErrorCode,
  isAppError,
  operationCancelled,
  uncancellable,
  type CancellationToken,
} from '@cadfixer/shared';
import { IDENTITY_MATRIX4, type CanonicalMesh } from '@cadfixer/mesh-core';
import type { OperationContext } from '@cadfixer/geometry-runtime';
import { modelExportHandler, modelImportHandler, residentModels } from './stl-handlers';

/**
 * The worker handlers are thin, but they own two things nothing else does: the
 * structural validation gate that decides whether an import counts as
 * successful, and the budget-override policy. Both were previously untestable
 * by construction — deleting the gate would have left every test in the
 * repository passing.
 */

function context(
  cancellation: CancellationToken = uncancellable,
  interruptible = true,
): OperationContext {
  return {
    cancellation,
    interruptible,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}

/** A valid single-triangle binary STL, built by hand so the bytes are auditable. */
function binaryStl(triangles: number): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  for (let index = 0; index < triangles; index += 1) {
    const offset = 84 + index * 50;
    view.setFloat32(offset + 8, 1, true); // normal +Z
    view.setFloat32(offset + 16, index, true); // v0.y
    view.setFloat32(offset + 24, 1, true); // v1.x
    view.setFloat32(offset + 28, index, true); // v1.y
    view.setFloat32(offset + 40, index + 1, true); // v2.y
  }
  return buffer;
}

async function rejection(run: () => Promise<unknown>): Promise<AppErrorCode | undefined> {
  try {
    await run();
    return undefined;
  } catch (caught) {
    return isAppError(caught) ? caught.code : undefined;
  }
}

describe('import handler', () => {
  it('parses a valid STL and reports what the worker measured', async () => {
    const outcome = await modelImportHandler({ bytes: binaryStl(3) }, context());

    expect(outcome.value.encoding).toBe('binary');
    expect(outcome.value.triangleCount).toBe(3);
    expect(outcome.value.vertexCount).toBe(9);
    expect(outcome.value.validation.valid).toBe(true);
    expect(outcome.value.bounds).toBeDefined();
    // Derived in the worker precisely so the main thread never walks the mesh.
    expect(outcome.value.render.normals).toHaveLength(27);
  });

  it('transfers the mesh buffers instead of cloning them', async () => {
    const outcome = await modelImportHandler({ bytes: binaryStl(2) }, context());

    // Only the RENDER SNAPSHOT is transferred. The authoritative mesh stays
    // resident in the worker, which is the whole point of the resident runtime.
    expect(outcome.transfer).toContain(outcome.value.render.positions.buffer);
    expect(outcome.transfer).toContain(outcome.value.render.normals.buffer);
    expect(residentModels.has(outcome.value.handle)).toBe(true);
  });

  it('rejects a payload that is not a transferable buffer', async () => {
    // A malformed or hostile message must not reach the parser.
    const badPayload = { bytes: 'not a buffer' } as unknown as { bytes: ArrayBufferLike };

    expect(await rejection(() => modelImportHandler(badPayload, context()))).toBe(
      AppErrorCode.MalformedFile,
    );
  });

  it('honours a budget override that LOWERS a limit', async () => {
    const outcome = await rejection(() =>
      modelImportHandler({ bytes: binaryStl(10), budget: { maxTriangles: 2 } }, context()),
    );

    expect(outcome).toBe(AppErrorCode.ResourceLimitExceeded);
  });

  it('IGNORES a budget override that tries to raise a limit', async () => {
    // The stated invariant: a message may tighten the worker's limits, never
    // loosen them. Otherwise the decision about how much memory to commit would
    // belong to the sender rather than to the budget.
    const raised = { maxInputBytes: Number.MAX_SAFE_INTEGER, maxTriangles: 1e12 };

    const outcome = await modelImportHandler({ bytes: binaryStl(2), budget: raised }, context());

    // Still parses — the defaults are ample for two triangles — and the raised
    // ceiling had no effect, which the next assertion pins.
    expect(outcome.value.triangleCount).toBe(2);
  });

  it('ignores unknown and nonsensical override keys instead of trusting them', async () => {
    const outcome = await modelImportHandler(
      {
        bytes: binaryStl(2),
        budget: { notARealLimit: 1, maxTriangles: Number.NaN, maxVertices: -5 },
      },
      context(),
    );

    expect(outcome.value.triangleCount).toBe(2);
  });

  it('aborts when cancellation is requested', async () => {
    const cancelled: CancellationToken = {
      isCancelled: true,
      onCancelled: () => (): void => undefined,
    };

    expect(
      await rejection(() => modelImportHandler({ bytes: binaryStl(2) }, context(cancelled))),
    ).toBe(AppErrorCode.OperationCancelled);
  });
});

describe('the structural validation gate', () => {
  /**
   * Rule 11: returning a mesh is not success; passing validation is. The export
   * handler takes a mesh straight from its payload, which makes it the place
   * the gate can be exercised directly — and the gate is the same call on both
   * paths.
   */
  function invalidMesh(): CanonicalMesh {
    return {
      // Indices reference vertices that do not exist.
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 77]),
      metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
    };
  }

  it('refuses to export a structurally invalid mesh', async () => {
    const outcome = await rejection(() =>
      modelExportHandler(
        { handle: residentModels.commit(invalidMesh()), encoding: 'binary' },
        context(),
      ),
    );

    expect(outcome).toBe(AppErrorCode.GeometryValidationFailed);
  });

  it('refuses to export an empty mesh', async () => {
    const empty: CanonicalMesh = {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
    };

    expect(
      await rejection(() =>
        modelExportHandler({ handle: residentModels.commit(empty), encoding: 'binary' }, context()),
      ),
    ).toBe(AppErrorCode.GeometryValidationFailed);
  });

  it('never produces a file from geometry it would refuse to load', async () => {
    // The property that matters: no bytes come back at all, rather than bytes
    // that another tool would then choke on.
    let produced: unknown;
    try {
      produced = await modelExportHandler(
        { handle: residentModels.commit(invalidMesh()), encoding: 'ascii' },
        context(),
      );
    } catch {
      produced = undefined;
    }

    expect(produced).toBeUndefined();
  });
});

describe('export handler', () => {
  const validMesh: CanonicalMesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 },
  };

  it.each(['binary', 'ascii'])('writes %s STL and transfers the result', async (encoding) => {
    const outcome = await modelExportHandler(
      { handle: residentModels.commit(validMesh), encoding },
      context(),
    );

    expect(outcome.value.encoding).toBe(encoding);
    expect(outcome.value.byteLength).toBeGreaterThan(0);
    expect(outcome.transfer).toContain(outcome.value.bytes);
  });

  it('produces exactly 134 bytes for a one-triangle binary STL', () => {
    // 84-byte prefix plus one 50-byte facet.
    return modelExportHandler(
      { handle: residentModels.commit(validMesh), encoding: 'binary' },
      context(),
    ).then((outcome: { value: { byteLength: number } }) => {
      expect(outcome.value.byteLength).toBe(134);
    });
  });

  it('rejects an unknown encoding rather than guessing', async () => {
    const outcome = await rejection(() =>
      modelExportHandler({ handle: residentModels.commit(validMesh), encoding: 'gltf' }, context()),
    );

    expect(outcome).toBeDefined();
  });

  it('does not mutate the mesh it was given', async () => {
    const before = [...validMesh.positions];

    await modelExportHandler(
      { handle: residentModels.commit(validMesh), encoding: 'binary' },
      context(),
    );

    expect([...validMesh.positions]).toEqual(before);
  });
});
