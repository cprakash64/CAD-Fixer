import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  analyseConversion,
  ExportStatus,
  isExportFormat,
  type ConversionCompatibilityReport,
  type ExportFormat,
} from '@cadfixer/file-formats';
import {
  DocumentExportService,
  type DocumentExportSession,
} from '../runtime/document-export-service';
import type { GeometryClient } from '../runtime/geometry-client';
import { deriveDocumentExportName, downloadBytes } from '../runtime/download';
import { useGeometryClient } from '../runtime/client-context';
import { documentFeatureProfile } from './document-profile';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import {
  ConversionState,
  StatusSeverity,
  type ConversionSnapshot,
  type ConversionToken,
} from './workspace-store';

/**
 * THE FORMAT CONVERSION WORKFLOW, bound to the store.
 *
 * TWO PROPERTIES THIS HOOK EXISTS TO GUARANTEE:
 *
 *   1. THE REPORT IS NEVER STALE. It is DERIVED from the model on every render
 *      rather than fetched and held, so a repair, an undo or a replacement
 *      import moves the document to a new revision and the report recomputes
 *      with it. There is no code path in which a report built at revision N can
 *      authorise an export at revision N+1 — because there is no stored report.
 *   2. THE EXPORT WORKER IS CREATED LATE. `DocumentExportService` constructs a
 *      `Worker` only inside `run`, so opening the dialog, choosing a target,
 *      reading the compatibility summary and picking a unit all happen with no
 *      export worker in existence. Only pressing Export makes one.
 *
 * WHAT IT DOES NOT DO: decide wording (that is `conversion-presentation.ts`),
 * decide policy (that is `analyseConversion`), or write anything (that is the
 * export worker). It sequences the operation and moves store state.
 */

/** The MIME types the browser is told about. Local `Blob`s; nothing is uploaded. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  stl: 'model/stl',
  obj: 'model/obj',
  '3mf': 'model/3mf',
};

/**
 * ONE EXPORT SERVICE PER GEOMETRY CLIENT, shared by every component using this
 * hook.
 *
 * THREE COMPONENTS CALL IT — the Model panel and the workflow nav to OPEN the
 * dialog, the dialog itself to run one — and a service held in each component's
 * own ref would be three services. Nothing breaks today, because only the
 * dialog ever starts an export; but "ONE EXPORT AT A TIME" is a guarantee about
 * a service, and three of them are three guarantees that do not add up to one.
 * The next caller to run an export would be the bug, and it would arrive as two
 * fifty-megabyte serialisations competing for the memory the ceilings were
 * sized against.
 *
 * A `WeakMap` rather than a module singleton, so a client that goes away — a
 * worker that died and was replaced — takes its service with it instead of
 * leaving one bound to a dead worker.
 */
const servicesByClient = new WeakMap<GeometryClient, DocumentExportService>();

function serviceFor(client: GeometryClient): DocumentExportService {
  const existing = servicesByClient.get(client);
  if (existing !== undefined) return existing;
  const created = new DocumentExportService(client);
  servicesByClient.set(client, created);
  return created;
}

export interface DocumentConversionControls {
  readonly conversion: ConversionSnapshot;
  /**
   * The compatibility report for the CURRENT model and the chosen target.
   *
   * `undefined` when there is no model or no target — never a stale one.
   */
  readonly report: ConversionCompatibilityReport | undefined;
  readonly open: () => void;
  readonly close: () => void;
  readonly chooseTarget: (target: ExportFormat) => void;
  readonly chooseUnit: (unit: string | undefined) => void;
  readonly convert: () => void;
  readonly cancel: () => void;
}

export function useDocumentConversion(): DocumentConversionControls {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model, conversion } = useWorkspaceState();
  const sessionRef = useRef<DocumentExportSession | undefined>(undefined);

  /*
   * RESOLVED PER CLIENT, not per component, and it holds no worker until `run`.
   * A page with no geometry worker yet has no service at all, rather than one
   * wired to a client that is about to be replaced.
   */
  const service = useMemo(() => (client === undefined ? undefined : serviceFor(client)), [client]);

  useEffect(() => {
    return (): void => {
      /*
       * CANCELS ONLY WHAT THIS HOOK STARTED. The service is shared, so disposing
       * it here would kill an export another component is running — and
       * unmounting a panel is not a reason to throw away someone's file. A
       * component that started an export and then went away leaves nothing
       * behind, because `cancel` terminates the worker.
       */
      sessionRef.current?.cancel();
      sessionRef.current = undefined;
    };
  }, []);

  /*
   * DERIVED, NOT STORED. This is the whole staleness answer: `model` is the
   * current model by construction, so a report computed from it describes the
   * revision on screen. When the model changes React re-renders and this runs
   * again — the previous report simply ceases to exist.
   */
  const report = useMemo((): ConversionCompatibilityReport | undefined => {
    if (model === undefined) return undefined;
    const target = conversion.target;
    if (target === undefined || !isExportFormat(target)) return undefined;
    return analyseConversion({
      profile: documentFeatureProfile(model),
      target,
      ...(conversion.unitAssertion === undefined
        ? {}
        : { unitAssertion: conversion.unitAssertion }),
    });
  }, [model, conversion.target, conversion.unitAssertion]);

  const open = useCallback((): void => {
    /*
     * PRESELECTS THE SOURCE FORMAT when CAD Fixer can write it. Saving the same
     * kind of file is the commonest reason to open this, and it bypasses no
     * review: the compatibility summary for that target is already on screen,
     * and nothing exports without an explicit press.
     */
    const source = model?.source.formatId;
    store.openConversion(source !== undefined && isExportFormat(source) ? source : undefined);
  }, [model, store]);

  const close = useCallback((): void => {
    sessionRef.current?.cancel();
    sessionRef.current = undefined;
    store.closeConversion();
  }, [store]);

  const chooseTarget = useCallback(
    (target: ExportFormat): void => {
      store.setConversionTarget(target);
    },
    [store],
  );

  const chooseUnit = useCallback(
    (unit: string | undefined): void => {
      store.setConversionUnit(unit);
    },
    [store],
  );

  const cancel = useCallback((): void => {
    sessionRef.current?.cancel();
  }, []);

  const convert = useCallback((): void => {
    if (model === undefined) return;
    const target = conversion.target;
    if (target === undefined || !isExportFormat(target)) return;
    if (service === undefined) {
      store.pushStatus(StatusSeverity.Error, 'The geometry worker is not ready yet.');
      return;
    }
    /*
     * REFUSED BEFORE IT STARTS when the report says it cannot be written.
     *
     * NOT THE ONLY GUARD, and deliberately not the important one: the 3MF
     * writer refuses a unit-less document on its own, in the worker, whatever
     * this page believes. This exists so a user is not made to wait for a
     * failure the interface could already see.
     */
    if (report?.exportable !== true) return;

    sessionRef.current?.cancel();
    const token: ConversionToken = store.beginConversion();
    /*
     * THE HANDLE IS CAPTURED HERE, at the moment the user pressed Export.
     *
     * The controller re-checks it against the revision the artifact was built
     * from, so if the document moves while the file is being written the bytes
     * are discarded rather than downloaded. A user must never be handed a file
     * of geometry they are no longer looking at.
     */
    const handle = model.handle;
    const fileName = deriveDocumentExportName(model.source.fileName, target);

    const session = service.run({
      handle,
      target,
      ...(conversion.unitAssertion === undefined
        ? {}
        : { unitAssertion: conversion.unitAssertion }),
      onProgress: (fraction, note) => {
        store.reportConversionProgress(token, fraction, note);
      },
    });
    sessionRef.current = session;

    session.promise.then(
      (outcome) => {
        if (outcome.status !== ExportStatus.Success) {
          if (!store.failConversion(token, { status: outcome.status, reason: outcome.reason })) {
            return;
          }
          sessionRef.current = undefined;
          return;
        }

        /*
         * THE DOWNLOAD HAPPENS ONLY AFTER VALIDATION SUCCEEDED. `exportDocument`
         * read these bytes back with the production reader and compared them
         * with the document they were written from; anything less and "Saved"
         * would be a claim about a serialiser rather than about a file.
         */
        downloadBytes(outcome.bytes, fileName, MIME_TYPES[target] ?? 'application/octet-stream');

        if (
          !store.completeConversion(token, {
            fileName,
            byteLength: outcome.metadata.outputBytes,
            target,
            triangleCount: outcome.metadata.triangleCount,
            partCount: outcome.metadata.partCount,
          })
        ) {
          return;
        }
        sessionRef.current = undefined;
      },
      () => {
        /*
         * The controller resolves rather than rejects for every outcome it
         * knows about, so reaching here means something threw outside it. Still
         * handled rather than swallowed: a dialog stuck on "Writing…" with
         * nothing running is worse than a plain failure.
         */
        if (
          !store.failConversion(token, { status: ExportStatus.InternalFailure, reason: undefined })
        )
          return;
        sessionRef.current = undefined;
      },
    );
  }, [conversion.target, conversion.unitAssertion, model, report, service, store]);

  /*
   * A DIALOG LEFT OPEN OVER NO MODEL CLOSES ITSELF. Reachable when the geometry
   * worker dies mid-review: the store clears the model, and a conversion panel
   * describing nothing would offer an Export button that could only fail.
   */
  useEffect(() => {
    if (model === undefined && conversion.state !== ConversionState.Closed) {
      store.closeConversion();
    }
  }, [conversion.state, model, store]);

  return { conversion, report, open, close, chooseTarget, chooseUnit, convert, cancel };
}
