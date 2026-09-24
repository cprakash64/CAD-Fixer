/* eslint-disable react-hooks/exhaustive-deps */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  OperationHandle,
  SurfaceTextureRequest,
  TextureCreateResult,
  TextureMode,
  TexturePattern,
} from '@cadfixer/geometry-runtime';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import { StatusSeverity } from '../state/workspace-store';
import { WorkflowId } from '../state/workflows';
import type { PartPick } from '../viewport/pick-part';

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'The texture could not be completed.';

export function TexturePanel(): ReactNode {
  const { selectedWorkflow, model, activePartId } = useWorkspaceState();
  const store = useWorkspaceStore(),
    client = useGeometryClient();
  const part = model?.parts.find((candidate) => candidate.partId === activePartId);
  const [surface, setSurface] = useState<PartPick | undefined>();
  const [surfaceSource, setSurfaceSource] = useState<
    { readonly documentId: string; readonly revision: number } | undefined
  >();
  const [pattern, setPattern] = useState<TexturePattern>('dots');
  const [mode, setMode] = useState<TextureMode>('emboss');
  const [featureSize, setFeatureSize] = useState(2);
  const [spacing, setSpacing] = useState(5);
  const [heightOrDepth, setHeightOrDepth] = useState(0.8);
  const [rotationDegrees, setRotationDegrees] = useState(0);
  const [phase, setPhase] = useState<
    'select' | 'configure' | 'computing' | 'preview' | 'applying' | 'applied'
  >('select');
  const [progress, setProgress] = useState('');
  const [preview, setPreview] = useState<TextureCreateResult | undefined>();
  const previewRef = useRef<TextureCreateResult | undefined>(undefined);
  const [recordId, setRecordId] = useState<string | undefined>();
  const running = useRef<OperationHandle<TextureCreateResult> | undefined>(undefined);
  const selecting = useRef<OperationHandle<unknown> | undefined>(undefined);
  const selectedSurface =
    surface?.partId === activePartId &&
    surfaceSource?.documentId === model?.handle.documentId &&
    surfaceSource?.revision === model?.handle.revision
      ? surface
      : undefined;

  const discard = (): void => {
    running.current?.cancel();
    running.current = undefined;
    if (previewRef.current)
      void client?.discardGeometryEdit(previewRef.current.candidate).promise.catch(() => undefined);
    previewRef.current = undefined;
    setPreview(undefined);
    store.clearTexturePreview();
  };
  const invalidate = (): void => {
    discard();
    setPhase(selectedSurface ? 'configure' : 'select');
    setProgress('');
  };
  useEffect(() => {
    const pick = (event: Event): void => {
      const hit = (event as CustomEvent<PartPick>).detail;
      if (store.getSnapshot().selectedWorkflow !== WorkflowId.Texture) return;
      discard();
      selecting.current?.cancel();
      const snapshot = store.getSnapshot();
      if (!client || !snapshot.model) return;
      setProgress('Selecting connected surface…');
      const operation = client.selectTextureSurface(
        snapshot.model.handle,
        hit.partId,
        hit.triangleIndex,
      );
      selecting.current = operation;
      void operation.promise
        .then((result) => {
          if (selecting.current !== operation) return;
          if (!store.setTextureSelection(result.source, result.partId, result.triangleIds)) return;
          setSurface(hit);
          setSurfaceSource(result.source);
          setPhase('configure');
          setRecordId(undefined);
        })
        .catch((cause: unknown) => {
          if (selecting.current === operation)
            store.pushStatus(StatusSeverity.Error, messageOf(cause));
        })
        .finally(() => {
          if (selecting.current === operation) {
            selecting.current = undefined;
            setProgress('');
          }
        });
    };
    window.addEventListener('cadfixer:texture-surface-pick', pick);
    return (): void => {
      window.removeEventListener('cadfixer:texture-surface-pick', pick);
      running.current?.cancel();
      selecting.current?.cancel();
    };
  }, [client, store]);
  const request = (): SurfaceTextureRequest => ({
    seedTriangle: selectedSurface?.triangleIndex ?? -1,
    pattern,
    mode,
    featureSize,
    spacing,
    heightOrDepth,
    rotationDegrees,
  });
  const updatePreview = async (): Promise<void> => {
    if (!client || !model || !activePartId || !selectedSurface) return;
    if (model.source.unit !== 'millimeter') {
      store.pushStatus(
        StatusSeverity.Error,
        'Texture dimensions require a model explicitly measured in millimetres for this MVP.',
      );
      return;
    }
    discard();
    setPhase('computing');
    setProgress('Selecting surface…');
    const operation = client.createSurfaceTexture(
      model.handle,
      activePartId,
      request(),
      (update) => {
        setProgress(update.note ?? 'Computing…');
      },
    );
    running.current = operation;
    try {
      const result = await operation.promise;
      if (running.current !== operation) return;
      setPreview(result);
      previewRef.current = result;
      store.setTexturePreview(
        model.handle,
        activePartId,
        result.render,
        result.candidate.generation,
      );
      store.clearTextureSelection();
      setPhase('preview');
      setProgress('');
    } catch (cause) {
      if (running.current === operation) {
        setPhase('configure');
        setProgress('');
        store.pushStatus(StatusSeverity.Error, messageOf(cause));
      }
    } finally {
      if (running.current === operation) running.current = undefined;
    }
  };
  const apply = async (): Promise<void> => {
    if (!client || !model || !activePartId || !preview) return;
    setPhase('applying');
    try {
      const result = await client.commitGeometryEdit(preview.candidate, model.handle, activePartId)
        .promise;
      if (!store.applyGeometryEditResult(result))
        throw new Error('The model changed before the texture could be applied.');
      setRecordId(result.recordId);
      setPreview(undefined);
      previewRef.current = undefined;
      setPhase('applied');
      store.pushStatus(StatusSeverity.Success, 'Surface texture applied.');
    } catch (cause) {
      setPhase('preview');
      store.pushStatus(StatusSeverity.Error, messageOf(cause));
    }
  };
  const cancel = (): void => {
    discard();
    store.clearTextureSelection();
    setSurface(undefined);
    setSurfaceSource(undefined);
    setPhase('select');
    store.selectWorkflow(undefined);
  };
  const undo = async (): Promise<void> => {
    if (!client || !model || !recordId) return;
    try {
      const result = await client.undoRepair(model.handle, recordId, () => undefined).promise;
      if (!store.applyUndoResult(result))
        throw new Error('The model changed before Undo completed.');
      setRecordId(undefined);
      setSurface(undefined);
      setSurfaceSource(undefined);
      setPhase('select');
      store.pushStatus(StatusSeverity.Success, 'Surface texture undone.');
    } catch (cause) {
      store.pushStatus(StatusSeverity.Error, messageOf(cause));
    }
  };
  if (selectedWorkflow !== WorkflowId.Texture) return null;
  const setNumber = (setter: (value: number) => void, value: string): void => {
    invalidate();
    setter(Number(value));
  };
  return (
    <section className="panel texture-panel" aria-labelledby="texture-heading">
      <h2 id="texture-heading">Surface texture</h2>
      {!model || !part ? (
        <p>Open a model and select a part to texture.</p>
      ) : (
        <>
          <p>
            Texturing <strong>{part.name ?? part.partId}</strong>. Click a flat surface in the 3D
            view.
          </p>
          <p role="status">
            {selectedSurface
              ? `Surface selected (triangle ${String(selectedSurface.triangleIndex)}).`
              : 'Choose a surface.'}
          </p>
          <fieldset disabled={!selectedSurface || phase === 'computing' || phase === 'applying'}>
            <legend>Pattern</legend>
            <label>
              Pattern{' '}
              <select
                aria-label="Texture pattern"
                value={pattern}
                onChange={(event) => {
                  invalidate();
                  setPattern(event.target.value as TexturePattern);
                }}
              >
                <option value="dots">Dots</option>
                <option value="lines">Lines</option>
                <option value="diamond">Diamond</option>
              </select>
            </label>
            <label>
              Style{' '}
              <select
                aria-label="Texture mode"
                value={mode}
                onChange={(event) => {
                  invalidate();
                  setMode(event.target.value as TextureMode);
                }}
              >
                <option value="emboss">Raised (Emboss)</option>
                <option value="engrave">Engraved</option>
              </select>
            </label>
            <label>
              {pattern === 'dots' ? 'Diameter' : 'Line width'}{' '}
              <input
                aria-label="Texture feature size"
                type="number"
                min="0.01"
                step="0.1"
                value={featureSize}
                onChange={(event) => {
                  setNumber(setFeatureSize, event.target.value);
                }}
              />{' '}
              mm
            </label>
            <label>
              Spacing (centre-to-centre){' '}
              <input
                aria-label="Texture spacing"
                type="number"
                min="0.01"
                step="0.1"
                value={spacing}
                onChange={(event) => {
                  setNumber(setSpacing, event.target.value);
                }}
              />{' '}
              mm
            </label>
            <label>
              {mode === 'emboss' ? 'Height' : 'Depth'}{' '}
              <input
                aria-label="Texture height or depth"
                type="number"
                min="0.01"
                step="0.1"
                value={heightOrDepth}
                onChange={(event) => {
                  setNumber(setHeightOrDepth, event.target.value);
                }}
              />{' '}
              mm
            </label>
            {pattern !== 'dots' ? (
              <label>
                Rotation{' '}
                <input
                  aria-label="Texture rotation"
                  type="number"
                  min="0"
                  max="180"
                  step="1"
                  value={rotationDegrees}
                  onChange={(event) => {
                    setNumber(setRotationDegrees, event.target.value);
                  }}
                />
                °
              </label>
            ) : null}
          </fieldset>
          {progress ? <p role="status">{progress}</p> : null}
          {preview ? (
            <p>
              {preview.elementCount} elements · {preview.pattern} · {preview.mode} ·{' '}
              {preview.candidateTriangleCount} candidate triangles
            </p>
          ) : null}
          <div className="panel__actions">
            <button
              type="button"
              disabled={!selectedSurface || phase === 'computing' || phase === 'applying'}
              onClick={() => void updatePreview()}
            >
              Update Preview
            </button>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
            {preview ? (
              <button type="button" disabled={phase === 'applying'} onClick={() => void apply()}>
                Apply
              </button>
            ) : null}
            {phase === 'applied' && recordId ? (
              <button type="button" onClick={() => void undo()}>
                Undo
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
