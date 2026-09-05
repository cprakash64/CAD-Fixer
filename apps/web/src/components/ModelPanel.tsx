import type { ReactNode } from 'react';
import { describeEncoding, describeSourceFormat, describeUnit } from '../state/model';
import { useWorkspaceState } from '../state/store-context';
import { useModelExport } from '../state/use-model-export';
import { useDocumentConversion } from '../state/use-document-conversion';

/**
 * Model information and the two ways out of it.
 *
 * PRESENTATION ONLY. Every number shown here was computed in the worker during
 * import, and both export controls call hooks that own their operations.
 *
 * THERE ARE TWO EXPORTS AND THEY ARE NOT THE SAME OPERATION, which is why they
 * are not both called "Export":
 *
 *   - EXPORT / CONVERT writes the WHOLE DOCUMENT, in a format the user chooses,
 *     after showing what that format keeps and what it cannot. It is the
 *     primary action and it is what "Export" means everywhere else in the
 *     product.
 *   - EXPORT ACTIVE PART AS STL writes ONE part, the selected one, and is the
 *     only way to get a single part out of a multi-part document. It is kept
 *     because nothing else does that, and it is labelled with the word "part"
 *     in the button itself — a second control also called "Export STL" that
 *     silently wrote a third of the model would be exactly the ambiguity Stage
 *     4A-2B3 exists to remove.
 */
export function ModelPanel(): ReactNode {
  const { model, activePartId } = useWorkspaceState();
  const { exportModel, cancelExport, isExporting, fraction, encoding } = useModelExport();
  const { open: openConversion } = useDocumentConversion();

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
        <Fact label="Format" value={describeSourceFormat(model.source)} testId="fact-format" />
        <Fact label="Encoding" value={describeEncoding(model.source)} testId="fact-encoding" />
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
        CAD Fixer reads STL, OBJ and 3MF, and writes all three. Files are written on this device;
        nothing is uploaded.
      </p>
      <div className="panel__actions">
        <button
          type="button"
          className="action action--primary"
          onClick={openConversion}
          data-testid="open-convert"
        >
          Export / Convert…
        </button>
      </div>
      <p className="panel__note">
        Writes the whole document — every part — as STL, OBJ or 3MF, and shows what the format you
        choose will keep before anything is written.
      </p>

      {/*
        THE SMALLER OPERATION, SEPARATED AND NAMED. It writes ONE part, which is
        a different thing from the button above, and nothing else in the product
        can do it. The heading, the note and the buttons all say "part".
      */}
      <h3 className="panel__subtitle">Export one part</h3>
      <p className="panel__note" data-testid="export-part-note">
        {model.parts.length > 1
          ? `Writes the selected part on its own as an STL. The other ${(model.parts.length - 1).toLocaleString()} ${model.parts.length === 2 ? 'part is' : 'parts are'} not included. Use Export / Convert above to write the whole document.`
          : 'Writes the selected part on its own as an STL. This document has one part, so this is the whole model.'}
      </p>
      {model.source.formatId === 'stl' ? null : (
        /* STATED BEFORE THE CLICK. Reading an OBJ or a 3MF and writing an STL
           does change format, and pretending otherwise would be the dishonesty
           this note exists to prevent — so it says exactly what the STL will
           not carry. */
        <p className="panel__note" data-testid="export-format-note">
          This model was read from {describeSourceFormat(model.source)}. The export is an STL, which
          records no unit
          {model.source.unit === undefined
            ? ' — and the source stated none either, so nothing is lost.'
            : `, so the source's stated unit (${model.source.unit}) is not written into the file. The coordinates are written unchanged.`}
        </p>
      )}
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
          Export active part as binary STL
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
          Export active part as ASCII STL
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
