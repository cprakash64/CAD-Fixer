import { malformedFile, throwIfCancelled, type CancellationToken } from '@cadfixer/shared';
import {
  assertMeshStructure,
  computeBounds,
  computeVertexNormals,
  meshTransferables,
  triangleCount,
  vertexCount,
  validateMeshStructure,
  MeshValidationSeverity,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import {
  DEFAULT_IMPORT_BUDGET,
  readStl,
  registerBuiltInFormats,
  requireWriter,
  MeshFormatId,
  type FormatProgressReporter,
  type ImportBudget,
} from '@cadfixer/file-formats';
import type {
  MeshValidationSummary,
  OperationHandler,
  StlExportResult,
  StlImportResult,
} from '@cadfixer/geometry-runtime';

/**
 * Worker-side handlers for the STL operations.
 *
 * These are adapters, not geometry code. Everything substantive — detection,
 * parsing, limits, writing — lives in `@cadfixer/file-formats` and is tested
 * under plain Node. What happens here is translating the worker protocol's
 * `OperationContext` into the format layer's `FormatReadContext`, running the
 * validation gate, and choosing the transfer list.
 */

registerBuiltInFormats();

/**
 * Returns control to the worker's event loop.
 *
 * A `MessageChannel` round-trip rather than `setTimeout(0)`: browsers clamp
 * nested timeouts to about 4 ms, and a parse that yields once per batch would
 * pay that clamp on every batch — hundreds of milliseconds of pure waiting on a
 * large model. A message task is not clamped.
 *
 * This is what makes cancellation real. The cancel message is queued behind the
 * running handler; yielding is the only thing that lets the worker read it.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * Phase boundaries within a single import, so the progress bar reflects the
 * work actually remaining rather than restarting at each stage.
 */
const PARSE_SHARE = 0.85;
const VALIDATE_SHARE = 0.95;

function progressReporter(
  report: (fraction: number, note?: string) => void,
  from: number,
  to: number,
): FormatProgressReporter {
  return {
    report(fraction: number, note?: string): void {
      const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
      report(from + clamped * (to - from), note);
    },
  };
}

/**
 * Applies caller-supplied limit overrides.
 *
 * Overrides may only LOWER a limit. Raising one over the wire would let a
 * message decide how much memory the worker is allowed to commit, which is
 * exactly the decision the budget exists to take away from untrusted input.
 */
function resolveBudget(overrides: Readonly<Record<string, number>> | undefined): ImportBudget {
  if (overrides === undefined) return DEFAULT_IMPORT_BUDGET;

  const lower = (key: keyof ImportBudget): number => {
    const proposed = overrides[key];
    const current = DEFAULT_IMPORT_BUDGET[key];
    if (proposed === undefined || !Number.isFinite(proposed) || proposed < 0) return current;
    return Math.min(current, proposed);
  };

  // Built field by field rather than by spreading and casting. A cast here
  // would let a renamed or removed budget field pass silently; this way the
  // compiler checks that every limit is accounted for.
  return {
    maxInputBytes: lower('maxInputBytes'),
    maxTriangles: lower('maxTriangles'),
    maxVertices: lower('maxVertices'),
    maxOutputBytes: lower('maxOutputBytes'),
    maxEstimatedPeakBytes: lower('maxEstimatedPeakBytes'),
    maxTokenBytes: lower('maxTokenBytes'),
  };
}

function summarise(mesh: CanonicalMesh): MeshValidationSummary {
  const report = validateMeshStructure(mesh);
  const errors = report.issues.filter(
    (issue) => issue.severity === MeshValidationSeverity.Error,
  ).length;
  return {
    valid: report.valid,
    issueCount: errors,
    warningCount: report.issues.length - errors,
    truncated: report.truncated,
    codes: [...new Set(report.issues.map((issue) => issue.code))],
  };
}

export const stlImportHandler: OperationHandler<'stl/import'> = async (payload, context) => {
  const source = payload.bytes;
  if (!(source instanceof ArrayBuffer)) {
    throw malformedFile('The import payload did not contain a transferable file buffer.');
  }

  const bytes = new Uint8Array(source);
  const cancellation: CancellationToken = context.cancellation;

  const parsed = await readStl(bytes, {
    cancellation,
    budget: resolveBudget(payload.budget),
    yieldToEventLoop,
    progress: progressReporter(
      (fraction, note) => {
        context.reportProgress(fraction, note);
      },
      0,
      PARSE_SHARE,
    ),
  });

  throwIfCancelled(cancellation);
  context.reportProgress(PARSE_SHARE, 'validating');

  // THE GATE. A parser returning a mesh is not a successful import; passing
  // structural validation is. This throws GEOMETRY_VALIDATION_FAILED otherwise,
  // and nothing reaches the workspace.
  assertMeshStructure(parsed.mesh, 'STL import');

  context.reportProgress(VALIDATE_SHARE, 'preparing');

  // Derived on this side of the boundary so the main thread never walks the
  // mesh. Both are per-vertex passes over data already in cache here.
  const bounds = computeBounds(parsed.mesh);
  const renderNormals = computeVertexNormals(parsed.mesh);

  throwIfCancelled(cancellation);
  context.reportProgress(1, 'complete');

  const value: StlImportResult = {
    mesh: parsed.mesh,
    encoding: parsed.encoding,
    bounds,
    triangleCount: triangleCount(parsed.mesh),
    vertexCount: vertexCount(parsed.mesh),
    renderNormals,
    warnings: parsed.warnings,
    validation: summarise(parsed.mesh),
  };

  // Moved, not copied. The input buffer is released when this operation ends;
  // peak memory is therefore input + output, which is what the budget's
  // estimate assumes.
  return {
    value,
    transfer: [...meshTransferables(parsed.mesh), renderNormals.buffer],
  };
};

export const stlExportHandler: OperationHandler<'stl/export'> = async (payload, context) => {
  const mesh = payload.mesh;

  // Export must never produce a file from geometry we would refuse to load.
  assertMeshStructure(mesh, 'STL export');
  context.reportProgress(0.05, 'writing');

  const writer = requireWriter(MeshFormatId.Stl);
  const bytes = await writer.write(mesh, {
    cancellation: context.cancellation,
    budget: DEFAULT_IMPORT_BUDGET,
    encoding: payload.encoding,
    yieldToEventLoop,
    progress: progressReporter(
      (fraction, note) => {
        context.reportProgress(fraction, note);
      },
      0.05,
      1,
    ),
  });

  const value: StlExportResult = {
    bytes: bytes.buffer,
    byteLength: bytes.byteLength,
    encoding: payload.encoding,
  };

  return { value, transfer: [bytes.buffer] };
};
