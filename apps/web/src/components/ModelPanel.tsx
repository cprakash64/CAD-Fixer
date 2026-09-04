import type { ReactNode } from 'react';
import { describeUnit } from '../state/model';
import { useWorkspaceState } from '../state/store-context';
import { useModelExport } from '../state/use-model-export';

/**
 * Model information and STL re-export.
 *
 * PRESENTATION ONLY. Every number shown here was computed in the worker during
 * import, and the export button calls a hook that owns the operation. This
 * component dispatches no worker operations, builds no filenames, and triggers
 * no downloads — that all moved to `runtime/export-service`.
 */
export function ModelPanel(): ReactNode {
  const { model, activePartId } = useWorkspaceState();
  const { exportModel, cancelExport, isExporting, fraction, encoding } = useModelExport();

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
  const percent = Math.round(fraction * 100);

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
        {model.parts.length > 1 ? (
          <Fact label="Parts" value={model.parts.length.toLocaleString()} testId="fact-parts" />
        ) : null}
        <Fact label="Units" value={describeUnit(model.source)} testId="fact-units" />
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
        Structurally valid means the file&rsquo;s mesh data is well formed. It is a claim about the
        data, not about the surface. Topology &mdash; boundaries, manifoldness, winding, components
        &mdash; is reported separately in <strong>Mesh Health</strong>. Self-intersections and wall
        thickness are not checked at all yet, so no result here or there establishes that a model
        will print.
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
      {model.parts.length > 1 ? (
        /* STATED BEFORE THE CLICK, not warned about after it. An STL file holds
           one object, so exporting a multi-part document cannot keep the parts
           apart — and a button that silently wrote one of three parts would be
           losing the user's structure without saying so. */
        <p className="panel__note" data-testid="export-part-note">
          STL files hold one object. This writes the selected part only; the other{' '}
          {(model.parts.length - 1).toLocaleString()} will not be included. Multi-part export
          arrives with format conversion.
        </p>
      ) : null}
      <div className="panel__actions">
        <button
          type="button"
          className="action"
          onClick={() => {
            exportModel('binary');
          }}
          disabled={isExporting || activePartId === undefined}
          data-testid="export-binary"
        >
          Export binary STL
        </button>
        <button
          type="button"
          className="action"
          onClick={() => {
            exportModel('ascii');
          }}
          disabled={isExporting || activePartId === undefined}
          data-testid="export-ascii"
        >
          Export ASCII STL
        </button>
      </div>

      {isExporting ? (
        <div className="import__progress" data-testid="export-progress">
          <div className="import__progress-row">
            <span>Writing {encoding} STL</span>
            <span data-testid="export-percent">{percent}%</span>
          </div>
          <progress
            className="import__bar"
            max={100}
            value={percent}
            aria-label={`Export progress: ${String(percent)}%`}
          />
          <button
            type="button"
            className="import__cancel"
            onClick={cancelExport}
            data-testid="cancel-export"
          >
            Cancel export
          </button>
        </div>
      ) : null}
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
