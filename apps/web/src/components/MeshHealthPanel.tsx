import type { ReactNode } from 'react';
import type { TopologyReport, VolumeStatus } from '@cadfixer/geometry-runtime';
import { describeEncoding, describeSourceFormat, describeUnit } from '../state/model';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { useTopologyAnalysis } from '../state/use-topology-analysis';
import {
  DEFECT_EXPLANATIONS,
  describeBoundaryKind,
  describeOverlaySampling,
  describeTruncation,
  describeVolumeStatus,
  formatArea,
  formatMagnitude,
  presentVolume,
  summariseTopology,
} from '../state/topology-presentation';
import { AnalysisState, type OverlayId } from '../state/workspace-store';
import { SelfIntersectionSection } from './SelfIntersectionSection';
import { describeActivePart } from '../state/part-presentation';

/**
 * Engineering diagnostics for the loaded model.
 *
 * PRESENTATION ONLY. Every number here was computed in the worker; this
 * component reads a report and renders it. It runs no topology code, holds no
 * typed arrays of its own, and never derives a topological conclusion the engine
 * did not state.
 *
 * DELIBERATELY NOT A SCORE. There is no health percentage, no traffic light, and
 * no grade. A single number would have to weigh a boundary edge against a
 * winding conflict, which is not a judgement the engine can make — and it would
 * imply completeness the analysis does not have. Facts and counts instead.
 *
 * ZERO IS SHOWN, NOT HIDDEN. Every category is listed even when its count is 0,
 * because an absent row leaves the user wondering whether the check ran.
 */
export function MeshHealthPanel(): ReactNode {
  const { model, activePartId, analysis, overlays } = useWorkspaceState();
  const store = useWorkspaceStore();
  const { runAnalysis, cancelAnalysis, isAnalyzing, canRetry } = useTopologyAnalysis();

  if (model === undefined) {
    return (
      <section className="panel" aria-labelledby="mesh-health-title">
        <h2 className="panel__title" id="mesh-health-title">
          Mesh Health
        </h2>
        <p className="panel__empty" data-testid="health-empty">
          No model loaded.
        </p>
      </section>
    );
  }

  const unit = model.source.unit;
  /*
   * The counts this panel is scoped to.
   *
   * `model.triangleCount` is the DOCUMENT total, which is the right number for
   * the Model panel and the wrong one here. Falling back to the document's
   * totals keeps the panel readable in the instant between a document arriving
   * and a part being selected.
   */
  const active = model.parts.find((part) => part.partId === activePartId);
  const scoped = active ?? {
    triangleCount: model.triangleCount,
    vertexCount: model.vertexCount,
  };
  const report = analysis.report;
  const percent = Math.round(analysis.fraction * 100);

  return (
    <section className="panel" aria-labelledby="mesh-health-title" data-testid="mesh-health">
      <h2 className="panel__title" id="mesh-health-title">
        Mesh Health
      </h2>

      {/*
        THE SCOPE OF EVERY NUMBER BELOW, stated where the numbers are.
        Analysis is per part, so on a multi-part document these counts describe
        ONE part. Leaving that implicit would let "0 boundary edges" read as a
        statement about the whole model, which nothing here checked. Rendered
        only when there is more than one part, so the single-part panel is
        unchanged.
      */}
      {model.parts.length > 1 ? (
        <p className="panel__note" data-testid="health-part-scope">
          These counts describe <strong>{describeActivePart(model.parts, activePartId)}</strong>{' '}
          only, of {model.parts.length.toLocaleString()} parts. Each part is analysed separately;
          nothing here reports how the parts relate to one another.
        </p>
      ) : null}

      {/* --- B1: source and structure ------------------------------------ */}
      <h3 className="panel__subtitle">Source and structure</h3>
      <dl className="facts" data-testid="health-source">
        <Fact label="File" value={model.source.fileName} testId="health-filename" />
        <Fact label="Format" value={describeSourceFormat(model.source)} testId="health-format" />
        <Fact label="Encoding" value={describeEncoding(model.source)} testId="health-encoding" />
        <Fact label="File size" value={formatBytes(model.source.fileBytes)} />
        {/* THE ACTIVE PART'S COUNTS, not the document's. The scope note above
            says every number here describes one part; showing the document
            total under that sentence would make the sentence a lie. A one-part
            document has one total, so the single-part panel is unchanged. */}
        <Fact
          label="Triangles"
          value={scoped.triangleCount.toLocaleString()}
          testId="health-triangles"
        />
        <Fact
          label="Source corners"
          value={scoped.vertexCount.toLocaleString()}
          testId="health-corners"
        />
        <Fact label="Units" value={describeUnit(model.source)} testId="health-units" />
        {/* "Structural data" rather than "mesh": parsing checked the file's
            shape, which is a narrower claim than anything about the surface. */}
        <Fact
          label="Structural data"
          value={model.validation.valid ? 'Valid' : 'Invalid'}
          testId="health-structural"
        />
      </dl>

      {/* --- analysis lifecycle ------------------------------------------ */}
      {isAnalyzing ? (
        <div className="analysis__progress" data-testid="analysis-progress">
          <div className="import__progress-row">
            <span data-testid="analysis-phase">{analysis.phase ?? 'Analyzing topology'}</span>
            <span data-testid="analysis-percent">{percent}%</span>
          </div>
          <progress
            className="import__bar"
            max={100}
            value={percent}
            aria-label={`Topology analysis progress: ${String(percent)}%`}
          />
          <button
            type="button"
            className="import__cancel"
            onClick={cancelAnalysis}
            data-testid="cancel-analysis"
          >
            Cancel analysis
          </button>
        </div>
      ) : null}

      {analysis.state === AnalysisState.Failed && analysis.error !== undefined ? (
        <div className="analysis__error" role="alert" data-testid="analysis-error">
          <p className="analysis__error-message">{analysis.error.message}</p>
          <p className="panel__note">
            The model is still loaded. You can view and export it; only the topology report is
            missing.
          </p>
        </div>
      ) : null}

      {analysis.state === AnalysisState.Cancelled ? (
        <p className="panel__note" data-testid="analysis-cancelled">
          Topology analysis was cancelled. No partial results are shown.
        </p>
      ) : null}

      {!isAnalyzing && canRetry ? (
        <div className="panel__actions">
          <button
            type="button"
            className="action"
            onClick={runAnalysis}
            data-testid="rerun-analysis"
          >
            {report === undefined ? 'Run analysis' : 'Run analysis again'}
          </button>
        </div>
      ) : null}

      {report === undefined ? (
        analysis.state === AnalysisState.Analyzing ? null : (
          <p className="panel__empty" data-testid="health-no-report">
            No topology report for this model yet.
          </p>
        )
      ) : (
        <TopologySections report={report} unit={unit} />
      )}

      {/* --- B5: always visible, never behind a tooltip ------------------- */}
      <h3 className="panel__subtitle">Checks not yet performed</h3>
      <dl className="facts facts--muted" data-testid="health-unchecked">
        <Fact label="Self-intersections" value="Not checked" testId="health-selfintersection" />
        <Fact label="Wall thickness" value="Not checked" testId="health-thickness" />
        <Fact label="Full printability" value="Not yet determined" testId="health-printability" />
      </dl>
      <p className="panel__note">
        These are not implemented yet. A model with no topological defects can still pass through
        itself or have walls too thin to print.
      </p>

      {/* --- D4: overlay toggles ----------------------------------------- */}
      {report === undefined ? null : (
        <OverlayControls
          report={report}
          visible={overlays}
          sampleLimit={analysis.detail?.sampleLimit ?? 0}
          drawn={{
            boundaryEdges: (analysis.detail?.boundaryEdges.length ?? 0) / 2,
            nonManifoldEdges: (analysis.detail?.nonManifoldEdges.length ?? 0) / 2,
            windingConflictEdges: (analysis.detail?.windingConflictEdges.length ?? 0) / 2,
            degenerateFaces: analysis.detail?.degenerateFaces.length ?? 0,
          }}
          onToggle={(overlay, next) => {
            store.setOverlayVisible(overlay, next);
          }}
        />
      )}
    </section>
  );
}

/** The report-derived sections. Split out so the empty states stay readable. */
function TopologySections({
  report,
  unit,
}: {
  readonly report: TopologyReport;
  readonly unit: string | undefined;
}): ReactNode {
  const summary = summariseTopology(report);
  const renderedComponents = report.components.slice(0, MAX_COMPONENT_ROWS);
  const componentTruncation = describeTruncation(renderedComponents.length, report.componentCount);
  const totalBoundaries =
    report.simpleBoundaryLoopCount + report.openBoundaryChainCount + report.branchedBoundaryCount;
  const renderedBoundaries = report.boundaryComponents.slice(0, MAX_BOUNDARY_ROWS);

  return (
    <>
      {/* --- B6: the verdict, and its mandatory qualifier ----------------- */}
      <p
        className={summary.hasDefects ? 'validity validity--bad' : 'validity validity--ok'}
        data-testid="topology-headline"
      >
        {summary.headline}
      </p>
      <p className="panel__note" data-testid="topology-qualifier">
        {summary.qualifier}
      </p>

      {/* --- Self-intersection: its own diagnostic, with its own honesty --- */}
      <SelfIntersectionSection />

      {/* --- B2: topology summary ---------------------------------------- */}
      <h3 className="panel__subtitle">Topology</h3>
      <dl className="facts" data-testid="health-topology">
        <Fact
          label="Recovered vertices"
          value={report.topologicalVertexCount.toLocaleString()}
          testId="topo-vertices"
        />
        <Fact
          label="Unique edges"
          value={report.uniqueEdgeCount.toLocaleString()}
          testId="topo-edges"
        />
        <Fact
          label="Connected components"
          value={report.componentCount.toLocaleString()}
          testId="topo-components"
        />
        <CountFact
          category="boundaryEdge"
          value={report.boundaryEdgeCount}
          testId="topo-boundary-edges"
        />
        <CountFact
          category="simpleBoundaryLoop"
          value={report.simpleBoundaryLoopCount}
          testId="topo-boundary-loops"
        />
        <CountFact
          category="openBoundaryChain"
          value={report.openBoundaryChainCount}
          testId="topo-boundary-chains"
        />
        <CountFact
          category="branchedBoundary"
          value={report.branchedBoundaryCount}
          testId="topo-boundary-branched"
        />
        <CountFact
          category="nonManifoldEdge"
          value={report.nonManifoldEdgeCount}
          testId="topo-nonmanifold-edges"
        />
        <CountFact
          category="nonManifoldVertex"
          value={report.nonManifoldVertexCount}
          testId="topo-nonmanifold-vertices"
        />
        <CountFact
          category="windingConflict"
          value={report.windingConflictEdgeCount}
          testId="topo-winding"
        />
        <CountFact
          category="duplicateFace"
          value={report.sameOrientationDuplicateCount}
          testId="topo-duplicates"
        />
        <CountFact
          category="reversedDuplicateFace"
          value={report.reversedOrientationDuplicateCount}
          testId="topo-duplicates-reversed"
        />
        <CountFact
          category="repeatedPositionFace"
          value={report.repeatedPositionFaceCount}
          testId="topo-repeated-position"
        />
        <CountFact
          category="zeroAreaFace"
          value={report.zeroAreaFaceCount}
          testId="topo-zero-area"
        />
      </dl>

      {/* Edge and vertex manifoldness are separate properties and are stated
          separately: the bow-tie case is edge-manifold and vertex-non-manifold,
          so collapsing them into one "manifold" flag would hide it. */}
      <dl className="facts" data-testid="health-manifold">
        <Fact
          label="Edge manifold"
          value={report.isEdgeManifold ? 'Yes' : 'No'}
          testId="topo-edge-manifold"
        />
        <Fact
          label="Vertex manifold"
          value={report.isVertexManifold ? 'Yes' : 'No'}
          testId="topo-vertex-manifold"
        />
        <Fact
          label="Consistent winding"
          value={report.isWindingConsistent ? 'Yes' : 'No'}
          testId="topo-winding-consistent"
        />
        <Fact
          label="Boundary free"
          value={report.isBoundaryFree ? 'Yes' : 'No'}
          testId="topo-boundary-free"
        />
      </dl>

      {renderedBoundaries.length > 0 ? (
        <ul className="boundary-list" data-testid="boundary-components">
          {renderedBoundaries.map((boundary, index) => (
            <li key={`${boundary.kind}-${String(index)}`}>
              {describeBoundaryKind(boundary.kind)}: {boundary.edgeCount.toLocaleString()} edges,{' '}
              {boundary.vertexCount.toLocaleString()} vertices
            </li>
          ))}
        </ul>
      ) : null}
      {/* Two independent truncations can apply: the engine bounds its summary
          list, and the DOM bounds what it renders. Either one means the list on
          screen is incomplete, and the user is told so. */}
      {report.boundaryComponentsTruncated || renderedBoundaries.length < totalBoundaries ? (
        <p className="panel__note" data-testid="boundary-truncated">
          Showing {renderedBoundaries.length.toLocaleString()} of {totalBoundaries.toLocaleString()}{' '}
          boundary structures
          {report.boundaryComponentsTruncated ? ' (the engine list is itself capped)' : ''}.
        </p>
      ) : null}

      {/* --- B3/B4: surface metrics -------------------------------------- */}
      <h3 className="panel__subtitle">Surface metrics</h3>
      <dl className="facts" data-testid="health-metrics">
        <Fact
          label="Surface area"
          value={formatArea(report.totalSurfaceArea, unit)}
          testId="metric-area"
        />
        <Fact
          label="Signed volume (algebraic)"
          value={formatMagnitude(report.totalSignedVolume)}
          testId="metric-signed-volume"
        />
      </dl>
      <p className="panel__note">
        {/* THE UNIT SENTENCE DEPENDS ON THE FILE, and used to name STL
            unconditionally. A 3MF states its unit, so telling that user "STL
            states no unit" would be describing a format they did not open. */}
        {unit === undefined
          ? `This file states no unit, so areas and volumes are given in the model’s own unspecified unit.`
          : `Areas and volumes are in the unit the file stated (${unit}); nothing was rescaled on import.`}{' '}
        The signed volume is an algebraic sum over all components; its sign reflects triangle
        orientation, not physical quantity.
      </p>

      {/* --- B7/B8: per-component summaries ------------------------------ */}
      {report.components.length > 0 ? (
        <>
          <h3 className="panel__subtitle">Components</h3>
          {componentTruncation === undefined ? null : (
            <p className="panel__note" data-testid="components-truncated">
              {componentTruncation}
            </p>
          )}
          <div className="component-table__scroll">
            <table className="component-table" data-testid="component-table">
              <caption className="component-table__caption">
                Per-component topology. Component vertex counts may overlap where components touch
                at a single vertex, so they are not expected to add up to the total above.
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Faces</th>
                  <th scope="col">Vertices</th>
                  <th scope="col">Edges</th>
                  <th scope="col">Boundary</th>
                  <th scope="col">NM edges</th>
                  <th scope="col">NM vertices</th>
                  <th scope="col">Winding</th>
                  <th scope="col">χ</th>
                  <th scope="col">Area</th>
                  <th scope="col">Volume status</th>
                </tr>
              </thead>
              <tbody>
                {renderedComponents.map((component) => (
                  <tr key={component.componentId}>
                    <td>{component.componentId}</td>
                    <td>{component.faceCount.toLocaleString()}</td>
                    <td>{component.topologicalVertexCount.toLocaleString()}</td>
                    <td>{component.edgeCount.toLocaleString()}</td>
                    <td>{component.boundaryEdgeCount.toLocaleString()}</td>
                    <td>{component.nonManifoldEdgeCount.toLocaleString()}</td>
                    <td>{component.nonManifoldVertexCount.toLocaleString()}</td>
                    <td>{component.windingConflictCount.toLocaleString()}</td>
                    <td>{component.eulerCharacteristic.toLocaleString()}</td>
                    <td>{formatArea(component.surfaceArea, unit)}</td>
                    <td>
                      {describeVolumeStatus(component.volumeStatus)}
                      <ComponentVolume
                        signedVolume={component.signedVolume}
                        status={component.volumeStatus}
                        unit={unit}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * DOM ceilings, separate from the report's own bounds.
 *
 * The engine already caps component summaries, but the DOM needs its own limit:
 * a mesh of a million disconnected triangles produces a million components, and
 * even the engine's bounded thousand would be eleven thousand table cells. Exact
 * counts stay exact — only the rendered list is capped, and the notice above it
 * says how many exist.
 */
const MAX_COMPONENT_ROWS = 200;
const MAX_BOUNDARY_ROWS = 50;

/**
 * A component's volume, shown only when it means something.
 *
 * `presentVolume` withholds a number for open and non-interpretable surfaces,
 * and returns the magnitude rather than the signed value for closed ones — so a
 * shell wound inward never renders as negative matter.
 */
function ComponentVolume({
  signedVolume,
  status,
  unit,
}: {
  readonly signedVolume: number;
  readonly status: VolumeStatus;
  readonly unit: string | undefined;
}): ReactNode {
  const volume = presentVolume(signedVolume, status, unit);
  if (volume.value === undefined) return null;
  return <> &middot; {volume.value}</>;
}

interface OverlayDescriptor {
  readonly id: OverlayId;
  readonly label: string;
  readonly help: string;
  readonly count: number;
  readonly drawn: number;
}

function OverlayControls({
  report,
  visible,
  drawn,
  onToggle,
}: {
  readonly report: TopologyReport;
  readonly visible: Readonly<Record<OverlayId, boolean>>;
  readonly sampleLimit: number;
  readonly drawn: Readonly<Record<OverlayId, number>>;
  readonly onToggle: (overlay: OverlayId, next: boolean) => void;
}): ReactNode {
  const overlays: readonly OverlayDescriptor[] = [
    {
      id: 'boundaryEdges',
      label: DEFECT_EXPLANATIONS.boundaryEdge.label,
      help: DEFECT_EXPLANATIONS.boundaryEdge.help,
      count: report.boundaryEdgeCount,
      drawn: drawn.boundaryEdges,
    },
    {
      id: 'nonManifoldEdges',
      label: DEFECT_EXPLANATIONS.nonManifoldEdge.label,
      help: DEFECT_EXPLANATIONS.nonManifoldEdge.help,
      count: report.nonManifoldEdgeCount,
      drawn: drawn.nonManifoldEdges,
    },
    {
      id: 'windingConflictEdges',
      label: DEFECT_EXPLANATIONS.windingConflict.label,
      help: DEFECT_EXPLANATIONS.windingConflict.help,
      count: report.windingConflictEdgeCount,
      drawn: drawn.windingConflictEdges,
    },
    {
      id: 'degenerateFaces',
      label: 'Degenerate triangles',
      help: 'This triangle has no usable surface area.',
      count: report.repeatedPositionFaceCount + report.zeroAreaFaceCount,
      drawn: drawn.degenerateFaces,
    },
  ];

  return (
    <>
      <h3 className="panel__subtitle" id="overlay-controls-title">
        Viewport overlays
      </h3>
      <ul
        className="overlays"
        aria-labelledby="overlay-controls-title"
        data-testid="overlay-controls"
      >
        {overlays.map((overlay) => {
          const sampling = describeOverlaySampling(overlay.drawn, overlay.count);
          const empty = overlay.count === 0;
          return (
            <li className="overlays__row" key={overlay.id}>
              <label className="overlays__label">
                <input
                  type="checkbox"
                  checked={visible[overlay.id] && !empty}
                  disabled={empty}
                  onChange={(event) => {
                    onToggle(overlay.id, event.target.checked);
                  }}
                  data-testid={`overlay-toggle-${overlay.id}`}
                />
                {/* The swatch is decorative. Colour is never the only signal:
                    the label and the count carry the meaning on their own. */}
                <span
                  className={`overlays__swatch overlays__swatch--${overlay.id}`}
                  aria-hidden="true"
                />
                <span className="overlays__name">{overlay.label}</span>
                <span className="overlays__count" data-testid={`overlay-count-${overlay.id}`}>
                  {overlay.count.toLocaleString()}
                </span>
              </label>
              <p className="overlays__help">{overlay.help}</p>
              {sampling === undefined ? null : (
                <p className="overlays__sampling" data-testid={`overlay-sampling-${overlay.id}`}>
                  {sampling}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function CountFact({
  category,
  value,
  testId,
}: {
  readonly category: keyof typeof DEFECT_EXPLANATIONS;
  readonly value: number;
  readonly testId: string;
}): ReactNode {
  const explanation = DEFECT_EXPLANATIONS[category];
  return (
    <div className="facts__row">
      <dt className="facts__label" title={explanation.help}>
        {explanation.label}
      </dt>
      <dd
        className={value > 0 ? 'facts__value facts__value--flag' : 'facts__value'}
        data-testid={testId}
      >
        {value.toLocaleString()}
      </dd>
    </div>
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
