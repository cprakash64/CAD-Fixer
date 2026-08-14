import { useCallback, type ReactNode } from 'react';
import { toAppError } from '@cadfixer/shared';
import { describeUnit } from '../state/model';
import { ExportState, StatusSeverity } from '../state/workspace-store';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useGeometryClient } from '../runtime/client-context';
import { deriveExportName, downloadBytes } from '../runtime/download';

/**
 * Model information and STL re-export.
 *
 * Every number shown here was computed in the worker during import. This
 * component performs no geometry work — it formats values that already exist.
 */
export function ModelPanel(): ReactNode {
  const store = useWorkspaceStore();
  const { model, exportState } = useWorkspaceState();
  const client = useGeometryClient();

  const exportStl = useCallback(
    (encoding: 'binary' | 'ascii'): void => {
      if (model === undefined || client === undefined) return;

      store.setExportState(ExportState.Working);
      const handle = client.exportStl(model.mesh, encoding, () => undefined);

      handle.promise.then(
        (result) => {
          store.setExportState(ExportState.Idle);
          const fileName = deriveExportName(
            model.source.fileName,
            encoding === 'binary' ? '' : '-ascii',
          );
          downloadBytes(new Uint8Array(result.bytes), fileName, 'model/stl');
          store.pushStatus(
            StatusSeverity.Success,
            `Exported ${fileName} (${encoding} STL, ${formatBytes(result.byteLength)}).`,
          );
        },
        (cause: unknown) => {
          store.setExportState(ExportState.Idle);
          store.pushStatus(StatusSeverity.Error, `Export failed: ${toAppError(cause).message}`);
        },
      );
    },
    [client, model, store],
  );

  if (model === undefined) {
    return (
      <section className="panel" aria-label="Model information">
        <h2 className="panel__title">Model</h2>
        <p className="panel__empty" data-testid="model-empty">
          No model loaded.
        </p>
      </section>
    );
  }

  const { bounds } = model;
  const busy = exportState === ExportState.Working;

  return (
    <section className="panel" aria-label="Model information">
      <h2 className="panel__title">Model</h2>

      <dl className="facts" data-testid="model-facts">
        <Fact label="File" value={model.source.fileName} testId="fact-filename" />
        <Fact label="Format" value="STL" />
        <Fact label="Encoding" value={model.source.encoding} testId="fact-encoding" />
        <Fact label="File size" value={formatBytes(model.source.fileBytes)} />
        <Fact
          label="Triangles"
          value={model.triangleCount.toLocaleString()}
          testId="fact-triangles"
        />
        <Fact label="Vertices" value={model.vertexCount.toLocaleString()} testId="fact-vertices" />
        <Fact label="Units" value={describeUnit(model.mesh)} testId="fact-units" />
        {bounds === undefined ? null : (
          <>
            <Fact
              label="Size X × Y × Z"
              value={bounds.size.map((value) => formatLength(value)).join(' × ')}
              testId="fact-size"
            />
            <Fact label="Min" value={bounds.min.map((v) => formatLength(v)).join(', ')} />
            <Fact label="Max" value={bounds.max.map((v) => formatLength(v)).join(', ')} />
            <Fact label="Bounding radius" value={formatLength(bounds.radius)} />
          </>
        )}
      </dl>

      {/* The distinction below is the whole point of saying "structurally
          valid" rather than "valid". */}
      <p
        className={model.validation.valid ? 'validity validity--ok' : 'validity validity--bad'}
        data-testid="validation-summary"
      >
        {model.validation.valid ? 'Structurally valid' : 'Structurally invalid'}
      </p>
      <p className="panel__note">
        Structurally valid means the mesh data is well formed. It does <strong>not</strong> mean the
        model is watertight, manifold, or printable — those checks are not implemented yet.
      </p>

      {model.warnings.length > 0 ? (
        <ul className="warnings" data-testid="model-warnings">
          {model.warnings.map((warning) => (
            <li key={warning.code}>{warning.message}</li>
          ))}
        </ul>
      ) : null}

      <h3 className="panel__subtitle">Export</h3>
      <p className="panel__note">
        Re-exports this STL. Converting between formats is not implemented — only STL can be read or
        written. Files are written on this device; nothing is uploaded.
      </p>
      <div className="panel__actions">
        <button
          type="button"
          className="action"
          onClick={() => {
            exportStl('binary');
          }}
          disabled={busy}
          data-testid="export-binary"
        >
          Export binary STL
        </button>
        <button
          type="button"
          className="action"
          onClick={() => {
            exportStl('ascii');
          }}
          disabled={busy}
          data-testid="export-ascii"
        >
          Export ASCII STL
        </button>
      </div>
    </section>
  );
}

function Fact({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
}): ReactNode {
  return (
    <div className="facts__row">
      <dt className="facts__label">{label}</dt>
      <dd className="facts__value" {...(testId === undefined ? {} : { 'data-testid': testId })}>
        {value}
      </dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Formats a coordinate for display.
 *
 * No unit suffix is appended: an STL does not state one, and writing "mm" here
 * would put an invented fact on screen.
 */
function formatLength(value: number): string {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-3) return value.toExponential(3);
  return value.toFixed(3).replace(/\.?0+$/, '');
}
