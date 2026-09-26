import { ExportFormat, stlContainerByteLength } from '@cadfixer/file-formats';
import { OutputSizeKind } from './conversion-presentation';
import type { LoadedModel } from './model';
import { measuredExportFor, type MeasuredExport } from './workspace-store';

/**
 * HOW BIG AN OUTPUT WILL BE, as far as CAD Fixer can say without writing it.
 *
 * PURE AND CHEAP. Scalars in, a scalar out: it never serialises, never touches
 * geometry and never talks to a worker, so selecting a card, picking a unit or
 * re-rendering the workspace costs a lookup and a multiplication. The only
 * numbers it returns are ones with something behind them:
 *
 *   - BINARY STL IS EXACT. The whole-document writer is fixed-width,
 *     `84 + 50 × triangles`, from the same leaf module its own preflight uses —
 *     so this is the size of the file, not an estimate of it. The triangle
 *     count is the document total, one per placement, which is what the writer
 *     flattens.
 *   - OBJ AND 3MF ARE MEASURED OR UNKNOWN. A real export of THIS revision, to
 *     THIS target, with THIS stated unit, produced a file of a known length;
 *     nothing else does. A lower bound or a compression ratio presented as an
 *     estimate would be a number that only looks like knowledge.
 */
export type OutputSize =
  | { readonly kind: typeof OutputSizeKind.Exact; readonly bytes: number }
  | { readonly kind: typeof OutputSizeKind.Measured; readonly bytes: number }
  | { readonly kind: typeof OutputSizeKind.Unknown };

export function outputSize(
  model: LoadedModel,
  target: ExportFormat,
  unitAssertion: string | undefined,
  measured: readonly MeasuredExport[],
): OutputSize {
  if (target === ExportFormat.Stl) {
    return { kind: OutputSizeKind.Exact, bytes: stlContainerByteLength(model.triangleCount) };
  }
  /*
   * THE UNIT IS PART OF THE KEY ONLY WHERE IT CHANGES THE BYTES, and the worker
   * applies an assertion only to a document that states no unit of its own —
   * so for a document that does, every assertion writes the same file.
   */
  const effectiveAssertion =
    target === ExportFormat.ThreeMf && model.source.unit === undefined ? unitAssertion : undefined;
  const entry = measuredExportFor(measured, model.handle, target, effectiveAssertion);
  if (entry !== undefined) return { kind: OutputSizeKind.Measured, bytes: entry.byteLength };
  return { kind: OutputSizeKind.Unknown };
}

/**
 * The unit a measurement is filed under, by the same rule `outputSize` reads it
 * with. Used when recording a finished export so the two cannot disagree.
 */
export function measurementUnitKey(
  model: LoadedModel,
  target: ExportFormat,
  unitAssertion: string | undefined,
): string | undefined {
  return target === ExportFormat.ThreeMf && model.source.unit === undefined
    ? unitAssertion
    : undefined;
}
