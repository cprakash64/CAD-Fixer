import { modelUnavailable, type AppError } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';

/**
 * The worker's registry of authoritative geometry.
 *
 * WHY THIS EXISTS. Stage 1 transferred the canonical mesh to the main thread as
 * soon as it was parsed, which made the UI the owner of the geometry. Every
 * later operation then had to send it back: export structured-cloned ~96 MiB
 * into the worker for a 2M-triangle model, and diagnostics, repair, booleans and
 * hollowing would each have paid the same toll. Ownership now stays where the
 * work happens.
 *
 * The main thread holds a `ModelHandle` — an id and a revision — plus a render
 * snapshot. It never holds the authoritative mesh.
 *
 * REVISIONS EXIST TO MAKE STALE OPERATIONS FAIL LOUDLY. An operation dispatched
 * against revision 3 must not silently apply to revision 4 after the model has
 * been replaced underneath it. Every geometry operation names the revision it
 * expects, and a mismatch is an error rather than a surprise.
 *
 * This module is deliberately platform-free: no DOM, no worker globals. It is
 * the worker's state, but it is testable as a plain object.
 */

declare const modelIdBrand: unique symbol;

export type ModelId = string & { readonly [modelIdBrand]: true };

export interface ModelHandle {
  readonly modelId: ModelId;
  /**
   * Increments whenever the geometry behind `modelId` is replaced.
   *
   * Stage 2 replaces a model by importing a new one, so in practice each import
   * produces a fresh id at revision 1. The revision is still carried because
   * repair operations will mutate a model in place, and the guard has to exist
   * before the first operation that needs it.
   */
  readonly revision: number;
}

interface ResidentEntry {
  readonly mesh: CanonicalMesh;
  readonly revision: number;
  /** Bytes of authoritative geometry held for this model. */
  readonly byteLength: number;
}

export interface ResidentModelStats {
  readonly modelCount: number;
  readonly totalBytes: number;
}

export function meshByteLength(mesh: CanonicalMesh): number {
  let bytes = mesh.positions.byteLength + mesh.indices.byteLength;
  if (mesh.normals) bytes += mesh.normals.byteLength;
  if (mesh.uvs) bytes += mesh.uvs.byteLength;
  return bytes;
}

export class ResidentModelStore {
  private readonly models = new Map<ModelId, ResidentEntry>();
  private nextId = 1;

  /**
   * Takes ownership of a mesh and returns its handle.
   *
   * The caller must not retain a reference to the mesh afterwards; the store is
   * the owner from this point.
   */
  public commit(mesh: CanonicalMesh): ModelHandle {
    const modelId = `model-${String(this.nextId)}` as ModelId;
    this.nextId += 1;
    this.models.set(modelId, { mesh, revision: 1, byteLength: meshByteLength(mesh) });
    return { modelId, revision: 1 };
  }

  /**
   * Resolves a handle to its mesh, refusing stale or unknown handles.
   *
   * Returns an `AppError` rather than throwing so callers can add operation
   * context; every caller throws it.
   */
  public resolve(handle: ModelHandle): CanonicalMesh | AppError {
    const entry = this.models.get(handle.modelId);
    if (entry === undefined) {
      return modelUnavailable(
        'That model is no longer available. It may have been replaced or released.',
        { modelId: handle.modelId, requestedRevision: handle.revision },
      );
    }
    if (entry.revision !== handle.revision) {
      // The specific failure this guard exists for: an operation queued against
      // an older revision must not apply to whatever replaced it.
      return modelUnavailable('That operation refers to an out-of-date version of the model.', {
        modelId: handle.modelId,
        requestedRevision: handle.revision,
        currentRevision: entry.revision,
      });
    }
    return entry.mesh;
  }

  public has(handle: ModelHandle): boolean {
    return this.models.get(handle.modelId)?.revision === handle.revision;
  }

  /** Releases a model. Returns whether anything was actually released. */
  public release(modelId: ModelId): boolean {
    return this.models.delete(modelId);
  }

  /** Releases everything. Used when the runtime is torn down. */
  public releaseAll(): void {
    this.models.clear();
  }

  public stats(): ResidentModelStats {
    let totalBytes = 0;
    for (const entry of this.models.values()) totalBytes += entry.byteLength;
    return { modelCount: this.models.size, totalBytes };
  }
}
