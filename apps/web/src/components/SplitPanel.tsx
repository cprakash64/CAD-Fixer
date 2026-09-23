import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  OperationHandle,
  SplitConnector,
  SplitCreateResult,
  SplitRequest,
} from '@cadfixer/geometry-runtime';
import { useGeometryClient } from '../runtime/client-context';
import { downloadBytes } from '../runtime/download';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { StatusSeverity } from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';

type Axis = 'X' | 'Y' | 'Z';
type ConnectorKind = 'none' | 'pin' | 'dovetail';
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'The split could not be completed.';

export function SplitPanel(): ReactNode {
  const { selectedWorkflow, model, activePartId } = useWorkspaceState();
  const store = useWorkspaceStore(),
    client = useGeometryClient();
  const part = model?.parts.find((candidate) => candidate.partId === activePartId);
  const [axis, setAxis] = useState<Axis>('X');
  const [offset, setOffset] = useState<number | undefined>(undefined);
  const [tilt, setTilt] = useState(0);
  const [connectorKind, setConnectorKind] = useState<ConnectorKind>('none');
  const [count, setCount] = useState<1 | 2 | 3 | 4>(1);
  const [diameter, setDiameter] = useState(4);
  const [depth, setDepth] = useState(6);
  const [clearance, setClearance] = useState(0.2);
  const [maleSide, setMaleSide] = useState<'A' | 'B'>('A');
  const [dovetailWidth, setDovetailWidth] = useState(8);
  const [dovetailLength, setDovetailLength] = useState(12);
  const [dovetailAngle, setDovetailAngle] = useState<0 | 90>(0);
  const [phase, setPhase] = useState<'idle' | 'computing' | 'preview' | 'applying' | 'applied'>(
    'idle',
  );
  const [progress, setProgress] = useState('');
  const [preview, setPreview] = useState<SplitCreateResult | undefined>();
  const [applied, setApplied] = useState<{ a: string; b: string; recordId: string } | undefined>();
  const running = useRef<OperationHandle<SplitCreateResult> | undefined>(undefined);

  const bounds = part?.bounds;
  const range = useMemo(() => {
    if (!bounds) return { min: -1, max: 1, center: 0 };
    const index = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
    const min = bounds.min[index],
      max = bounds.max[index];
    return { min, max, center: (min + max) / 2 };
  }, [axis, bounds]);
  const plane = useMemo<SplitRequest['plane']>(() => {
    const radians = (tilt * Math.PI) / 180,
      normal: readonly [number, number, number] =
        axis === 'X'
          ? [Math.cos(radians), Math.sin(radians), 0]
          : axis === 'Y'
            ? [0, Math.cos(radians), Math.sin(radians)]
            : [Math.sin(radians), 0, Math.cos(radians)],
      center = bounds?.center ?? [0, 0, 0],
      origin: [number, number, number] = [center[0], center[1], center[2]],
      index = axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
    origin[index] = offset ?? range.center;
    return { origin, normal };
  }, [axis, bounds?.center, offset, range.center, tilt]);
  useEffect(
    (): (() => void) => () => {
      running.current?.cancel();
    },
    [],
  );
  useEffect(() => {
    if (selectedWorkflow !== WorkflowId.Split || !model || !part) {
      store.setSplitPlane(undefined);
      return;
    }
    store.setSplitPlane({ ...plane, revision: model.revision });
    return (): void => {
      store.setSplitPlane(undefined);
    };
  }, [model, part, plane, selectedWorkflow, store]);
  const reset = (): void => {
    running.current?.cancel();
    running.current = undefined;
    if (preview) void client?.discardSplit(preview.candidate).promise.catch(() => undefined);
    setOffset(undefined);
    setTilt(0);
    setPreview(undefined);
    store.clearSplitPreview();
    setPhase('idle');
    setProgress('');
  };
  const connector = (): SplitConnector =>
    connectorKind === 'none'
      ? { kind: 'none' }
      : connectorKind === 'pin'
        ? { kind: 'pin', count, diameter, depth, clearance, maleSide }
        : {
            kind: 'dovetail',
            width: dovetailWidth,
            depth,
            length: dovetailLength,
            clearance,
            maleSide,
            orientationDegrees: dovetailAngle,
          };
  const request = (): SplitRequest => {
    return { plane, connector: connector() };
  };
  const discardPreview = async (): Promise<void> => {
    const candidate = preview?.candidate;
    setPreview(undefined);
    store.clearSplitPreview();
    if (candidate && client) await client.discardSplit(candidate).promise.catch(() => undefined);
  };
  const invalidatePreview = (): void => {
    running.current?.cancel();
    running.current = undefined;
    if (preview) void client?.discardSplit(preview.candidate).promise.catch(() => undefined);
    setPreview(undefined);
    store.clearSplitPreview();
    setPhase('idle');
    setProgress('');
  };
  const updatePreview = async (): Promise<void> => {
    if (!client || !model || !activePartId) return;
    if (connectorKind !== 'none' && model.source.unit !== 'millimeter') {
      store.pushStatus(
        StatusSeverity.Error,
        'Connectors require a model explicitly measured in millimetres for this MVP.',
      );
      return;
    }
    running.current?.cancel();
    await discardPreview();
    setPhase('computing');
    setProgress('Checking split…');
    const operation = client.createSplit(model.handle, activePartId, request(), (u) => {
      setProgress(u.note ?? 'Computing…');
    });
    running.current = operation;
    try {
      const result = await operation.promise;
      if (running.current !== operation) return;
      setPreview(result);
      store.setSplitPreview(model.handle, result.render, result.parts);
      setPhase('preview');
      setProgress('');
    } catch (cause) {
      if (running.current === operation) {
        setPhase('idle');
        setProgress('');
        store.pushStatus(StatusSeverity.Error, messageOf(cause));
      }
    } finally {
      if (running.current === operation) running.current = undefined;
    }
  };
  const cancel = async (): Promise<void> => {
    running.current?.cancel();
    running.current = undefined;
    await discardPreview();
    setPhase('idle');
    setProgress('');
    store.selectWorkflow(undefined);
  };
  const apply = async (): Promise<void> => {
    if (!client || !model || !activePartId || !preview) return;
    setPhase('applying');
    try {
      const result = await client.commitSplit(preview.candidate, model.handle, activePartId)
        .promise;
      if (!store.applySplitResult(result))
        throw new Error('The model changed before the split could be applied.');
      setApplied({ a: result.pieceAId, b: result.pieceBId, recordId: result.recordId });
      setPreview(undefined);
      setPhase('applied');
      store.pushStatus(StatusSeverity.Success, 'Split applied. Piece A and Piece B are ready.');
    } catch (cause) {
      setPhase('preview');
      store.pushStatus(StatusSeverity.Error, messageOf(cause));
    }
  };
  const exportPiece = async (id: string, label: string): Promise<void> => {
    if (!client || !model) return;
    try {
      const result = await client.exportModel(model.handle, id, 'binary', () => undefined).promise;
      downloadBytes(new Uint8Array(result.bytes), `${label}.stl`, 'model/stl');
      store.pushStatus(StatusSeverity.Success, `${label}.stl saved.`);
    } catch (cause) {
      store.pushStatus(StatusSeverity.Error, messageOf(cause));
    }
  };
  const undo = async (): Promise<void> => {
    if (!client || !model || !applied) return;
    try {
      const result = await client.undoRepair(model.handle, applied.recordId, () => undefined)
        .promise;
      if (!store.applyUndoResult(result))
        throw new Error('The model changed before Undo completed.');
      setApplied(undefined);
      setPhase('idle');
      store.pushStatus(StatusSeverity.Success, 'Split undone.');
    } catch (cause) {
      store.pushStatus(StatusSeverity.Error, messageOf(cause));
    }
  };

  if (selectedWorkflow !== WorkflowId.Split) return null;

  return (
    <section className="panel split-panel" aria-labelledby="split-heading">
      <h2 id="split-heading">Split</h2>
      {!model || !part ? (
        <p>Open a model and select a part to split.</p>
      ) : (
        <>
          <p className="panel__lede">
            Cut <strong>{part.name ?? part.partId}</strong> into Piece A and Piece B.
          </p>
          <fieldset>
            <legend>Cut</legend>
            <div role="group" aria-label="Split plane orientation">
              {(['X', 'Y', 'Z'] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={axis === value}
                  onClick={() => {
                    invalidatePreview();
                    setAxis(value);
                    setOffset(undefined);
                    setTilt(0);
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
            <label>
              Offset{' '}
              <input
                aria-label="Split plane offset"
                type="range"
                min={range.min}
                max={range.max}
                step={(range.max - range.min) / 200 || 0.01}
                value={offset ?? range.center}
                onChange={(e) => {
                  invalidatePreview();
                  setOffset(Number(e.target.value));
                }}
              />
              <input
                aria-label="Split plane offset value"
                type="number"
                value={offset ?? range.center}
                min={range.min}
                max={range.max}
                onChange={(e) => {
                  invalidatePreview();
                  setOffset(Number(e.target.value));
                }}
              />
            </label>
            <label>
              Rotation{' '}
              <input
                aria-label="Split plane rotation"
                type="number"
                min={-89}
                max={89}
                value={tilt}
                onChange={(e) => {
                  invalidatePreview();
                  setTilt(Number(e.target.value));
                }}
              />
              °
            </label>
            <button type="button" onClick={reset}>
              Reset plane
            </button>
          </fieldset>
          <fieldset>
            <legend>Connectors</legend>
            <label>
              Type{' '}
              <select
                aria-label="Connector type"
                value={connectorKind}
                onChange={(e) => {
                  invalidatePreview();
                  setConnectorKind(e.target.value as ConnectorKind);
                }}
              >
                <option value="none">None</option>
                <option value="pin">Round pin / socket</option>
                <option value="dovetail">Dovetail</option>
              </select>
            </label>
            {connectorKind === 'pin' ? (
              <>
                <label>
                  Count{' '}
                  <input
                    aria-label="Pin count"
                    type="number"
                    min={1}
                    max={4}
                    value={count}
                    onChange={(e) => {
                      invalidatePreview();
                      setCount(Math.max(1, Math.min(4, Number(e.target.value))) as 1 | 2 | 3 | 4);
                    }}
                  />
                </label>
                <label>
                  Pin diameter{' '}
                  <input
                    aria-label="Pin diameter"
                    type="number"
                    min={0.1}
                    max={100}
                    step={0.1}
                    value={diameter}
                    onChange={(e) => {
                      invalidatePreview();
                      setDiameter(Number(e.target.value));
                    }}
                  />{' '}
                  mm
                </label>
              </>
            ) : null}
            {connectorKind === 'dovetail' ? (
              <>
                <label>
                  Width{' '}
                  <input
                    aria-label="Dovetail width"
                    type="number"
                    min={0.1}
                    max={100}
                    step={0.1}
                    value={dovetailWidth}
                    onChange={(e) => {
                      invalidatePreview();
                      setDovetailWidth(Number(e.target.value));
                    }}
                  />{' '}
                  mm
                </label>
                <label>
                  Length{' '}
                  <input
                    aria-label="Dovetail length"
                    type="number"
                    min={0.1}
                    max={200}
                    step={0.1}
                    value={dovetailLength}
                    onChange={(e) => {
                      invalidatePreview();
                      setDovetailLength(Number(e.target.value));
                    }}
                  />{' '}
                  mm
                </label>
                <label>
                  Orientation{' '}
                  <select
                    aria-label="Dovetail orientation"
                    value={dovetailAngle}
                    onChange={(e) => {
                      invalidatePreview();
                      setDovetailAngle(Number(e.target.value) as 0 | 90);
                    }}
                  >
                    <option value={0}>0°</option>
                    <option value={90}>90°</option>
                  </select>
                </label>
              </>
            ) : null}
            {connectorKind !== 'none' ? (
              <>
                <label>
                  Depth{' '}
                  <input
                    aria-label="Connector depth"
                    type="number"
                    min={0.1}
                    max={100}
                    step={0.1}
                    value={depth}
                    onChange={(e) => {
                      invalidatePreview();
                      setDepth(Number(e.target.value));
                    }}
                  />{' '}
                  mm
                </label>
                <label>
                  Clearance{' '}
                  <input
                    aria-label="Connector clearance"
                    type="number"
                    min={0}
                    max={5}
                    step={0.05}
                    value={clearance}
                    onChange={(e) => {
                      invalidatePreview();
                      setClearance(Number(e.target.value));
                    }}
                  />{' '}
                  mm
                </label>
                <label>
                  Male side{' '}
                  <select
                    aria-label="Male connector side"
                    value={maleSide}
                    onChange={(e) => {
                      invalidatePreview();
                      setMaleSide(e.target.value as 'A' | 'B');
                    }}
                  >
                    <option value="A">Piece A</option>
                    <option value="B">Piece B</option>
                  </select>
                </label>
                <p>
                  Clearance adds space between mating parts. Printers vary; 0.2 mm is a common
                  starting point, not a guarantee.
                </p>
              </>
            ) : null}
          </fieldset>
          {progress ? <p role="status">{progress}</p> : null}
          {preview ? (
            <div className="split-summary">
              <h3>Preview</h3>
              <p>
                Piece A:{' '}
                {preview.parts
                  .find((p) => p.partId === preview.pieceAId)
                  ?.triangleCount.toLocaleString()}{' '}
                triangles
              </p>
              <p>
                Piece B:{' '}
                {preview.parts
                  .find((p) => p.partId === preview.pieceBId)
                  ?.triangleCount.toLocaleString()}{' '}
                triangles
              </p>
              <p>
                Connector: {preview.connector.kind}; volume error{' '}
                {(preview.metrics.volumeRelativeError * 100).toFixed(5)}%
              </p>
            </div>
          ) : null}
          <div className="panel__actions">
            <button
              type="button"
              disabled={phase === 'computing' || phase === 'applying'}
              onClick={() => void updatePreview()}
            >
              Update Preview
            </button>
            <button type="button" onClick={() => void cancel()}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!preview || phase === 'applying'}
              onClick={() => void apply()}
            >
              Apply
            </button>
          </div>
          {applied ? (
            <div className="panel__actions">
              <button type="button" onClick={() => void exportPiece(applied.a, 'Piece-A')}>
                Export Piece A
              </button>
              <button type="button" onClick={() => void exportPiece(applied.b, 'Piece-B')}>
                Export Piece B
              </button>
              <button type="button" onClick={() => void undo()}>
                Undo Split
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
