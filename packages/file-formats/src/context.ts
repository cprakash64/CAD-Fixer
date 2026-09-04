import type { CancellationToken, Diagnostic, LengthUnit } from '@cadfixer/shared';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { ImportBudget } from './budget';

/**
 * What a codec needs from whoever invoked it.
 *
 * Deliberately smaller than the worker's `OperationContext`: the format layer
 * knows nothing about the worker protocol, and the adapter between the two
 * lives at the worker boundary. That is what keeps the codecs runnable — and
 * testable — under plain Node with no DOM and no worker.
 */

export interface FormatProgressReporter {
  /** `fraction` is 0..1 and must not decrease. Implementations should throttle. */
  report(fraction: number, note?: string): void;
}

export interface FormatReadContext {
  readonly cancellation: CancellationToken;
  readonly progress: FormatProgressReporter;
  /** Limits enforced before any allocation. */
  readonly budget: ImportBudget;
  /**
   * Yields to the host event loop.
   *
   * WHY A CODEC MUST YIELD. Cancellation crosses the worker boundary as a
   * message. A handler that runs one long synchronous loop never returns to the
   * event loop, so that message sits unread in the queue and the cancellation
   * flag it would set can never become true. Polling a flag that cannot change
   * is not cancellation — it only looks like it. Codecs therefore yield between
   * batches, which is what actually lets a cancel be delivered.
   *
   * Injected rather than implemented here because a macrotask scheduler is a
   * platform concern, and this package compiles without DOM or Node types.
   */
  readonly yieldToEventLoop: () => Promise<void>;
  /**
   * Decodes UTF-8 bytes into text.
   *
   * INJECTED FOR THE SAME REASON `yieldToEventLoop` IS. `TextDecoder` is a
   * platform global, and this package compiles with `lib: ES2023` alone —
   * deliberately, so a codec cannot quietly acquire a DOM or Node dependency
   * and stop being testable under plain Node. The STL readers never needed it
   * because STL's only text is a `solid` name they scan byte by byte; OBJ is
   * text throughout and 3MF's model part is XML, so both do.
   *
   * Implementations must be lenient (`fatal: false`): a stray byte in a comment
   * is far more often a real file from a real tool than an attack, and nothing
   * downstream treats decoded text as markup or as a path.
   */
  readonly decodeText: (bytes: Uint8Array) => string;
  /**
   * Inflates a raw DEFLATE stream, yielding output as it is produced.
   *
   * CHUNKED, NOT WHOLE-BUFFER, and that is the entire security property. A zip
   * bomb is refused by abandoning the stream after the first chunk that takes
   * the total past budget, so peak memory stays bounded by the limit rather
   * than by whatever the archive claimed. A `Promise<Uint8Array>` signature
   * would make that impossible: the allocation would already have happened.
   *
   * Injected because `DecompressionStream` is a platform primitive. Optional
   * because only 3MF needs it, and a caller importing STL should not have to
   * supply one.
   */
  readonly inflateRaw?: (compressed: Uint8Array) => AsyncIterable<Uint8Array>;
}

export interface FormatWriteContext {
  readonly cancellation: CancellationToken;
  readonly progress: FormatProgressReporter;
  readonly budget: ImportBudget;
  /** See `FormatReadContext.yieldToEventLoop`. */
  readonly yieldToEventLoop: () => Promise<void>;
  /**
   * Format-specific encoding to produce, for formats that have more than one.
   * STL uses `binary` and `ascii`.
   */
  readonly encoding?: string;
}

/**
 * What a reader returns.
 *
 * STAGE 1 CHANGE: Stage 0 defined `MeshReader.read` as returning a bare
 * `CanonicalMesh`. Writing the first real codec showed that to be too narrow —
 * an import legitimately produces findings that are not failures (unusable
 * stored normals, trailing bytes, a missing `endsolid`) and the interface has to
 * carry which encoding was actually detected, since that is not derivable from
 * the mesh. Both are user-visible, so hiding them in the codec was not an
 * option. The seam was defined before any codec existed; this widens it once,
 * with the mesh still the primary result.
 */
/**
 * What a writer returns.
 *
 * Bytes alone were not enough. Binary STL has no way to represent the multiple
 * `solid` blocks an ASCII file can carry, so exporting a grouped model to
 * binary genuinely discards information. Returning that as a warning is the
 * difference between a documented loss and a silent one.
 */
export interface MeshWriteResult {
  readonly bytes: Uint8Array;
  /** Non-fatal findings, e.g. metadata that could not be represented. */
  readonly warnings: readonly Diagnostic[];
}

export interface MeshReadResult {
  readonly mesh: CanonicalMesh;
  /** The encoding actually detected, e.g. `binary` or `ascii`. */
  readonly encoding: string;
  /**
   * The unit the SOURCE stated, or absent when it stated none.
   *
   * ON THE RESULT, NOT ON THE MESH. Physical unit is a property of the document
   * a file describes, not of one triangle soup inside it: a 3MF file states one
   * unit for everything it contains, and two parts of one document cannot
   * honestly disagree about it. Leaving it here means there is exactly one place
   * the value travels and exactly one place it lands — `GeometryDocument.unit`.
   *
   * Absent is meaningful and must never be flattened into a default. STL and OBJ
   * state no unit.
   */
  readonly unit?: LengthUnit;
  /** Non-fatal findings. An empty array means a clean import. */
  readonly warnings: readonly Diagnostic[];
}
