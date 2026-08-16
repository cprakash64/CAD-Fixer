/**
 * Page-side driver for the Stage 3A-3B experimental browser harness.
 *
 * RESEARCH ONLY. Exposes `window.cfHarness` for Playwright to drive. Nothing
 * here is application code and nothing imports it.
 *
 * THE PAGE IS THE AUTHORITY. It holds the source geometry; a candidate worker
 * only ever receives a copy. That mirrors the production invariant — the
 * resident geometry worker owns the model, a repair candidate does not — and it
 * is what makes `terminate()` a safe cancellation rather than data loss.
 */

const WORKER_URL = '/candidate-worker.js';

let nextSession = 1;
let nextOp = 1;

/** Live sessions by id. A terminated session is deleted, never reused. */
const sessions = new Map();

/**
 * Messages received whose session is no longer live.
 *
 * Recorded rather than ignored: "a terminated worker never published a stale
 * result" is a claim that needs evidence, and this counter is the evidence.
 */
const stale = [];

function createSession(candidateId) {
  const sessionId = nextSession;
  nextSession += 1;

  const createStarted = performance.now();
  const worker = new Worker(WORKER_URL, { type: 'module', name: `cf-${candidateId}-${sessionId}` });
  const createMs = performance.now() - createStarted;

  const session = {
    sessionId,
    candidateId,
    worker,
    createMs,
    terminated: false,
    pending: new Map(),
    started: new Map(),
    events: [],
  };

  worker.onmessage = (event) => {
    const message = event.data;

    /*
     * IDENTITY CHECK, NOT A TRUST CHECK. A worker terminated mid-flight can
     * still have a queued message delivered after its replacement exists. If
     * the page matched replies to operations by order or by "most recent", a
     * dead worker's output could be attributed to a live operation — a result
     * that looks perfectly plausible and is completely wrong.
     */
    const live = sessions.get(message.sessionId);
    if (live === undefined || live.terminated || live.worker !== worker) {
      stale.push({
        sessionId: message.sessionId,
        opId: message.opId,
        type: message.type,
        reason: live === undefined ? 'session-gone' : 'session-terminated',
      });
      return;
    }

    live.events.push({ type: message.type, opId: message.opId, at: performance.now() });

    if (message.type === 'started') {
      const notify = live.started.get(message.opId);
      if (notify !== undefined) {
        notify(performance.now());
        live.started.delete(message.opId);
      }
      return;
    }

    const settle = live.pending.get(message.opId);
    if (settle === undefined) return;
    live.pending.delete(message.opId);
    settle(message);
  };

  sessions.set(sessionId, session);
  return session;
}

function send(session, request, { expectResult = true } = {}) {
  const opId = nextOp;
  nextOp += 1;

  const startedAt = performance.now();
  const started = new Promise((resolve) => {
    session.started.set(opId, resolve);
  });
  const settled = expectResult
    ? new Promise((resolve) => {
        session.pending.set(opId, resolve);
      })
    : Promise.resolve(null);

  session.worker.postMessage({ ...request, sessionId: session.sessionId, opId });
  return { opId, startedAt, started, settled };
}

/** Summary a large result can return without shipping the mesh to Node. */
function summarise(positions, indices) {
  if (positions === undefined || indices === undefined) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let nonFinite = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      nonFinite += 1;
      continue;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  let area = 0;
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    volume += (positions[a] * nx + positions[a + 1] * ny + positions[a + 2] * nz) / 6;
  }

  return {
    vertices: positions.length / 3,
    triangles: indices.length / 3,
    nonFinite,
    boundingBox: [minX, minY, minZ, maxX, maxY, maxZ],
    surfaceArea: area,
    signedVolume: volume,
  };
}

/**
 * The page's authoritative geometry, and a digest of it.
 *
 * MIRRORS THE PRODUCTION INVARIANT. In CAD Fixer the resident geometry worker
 * owns the model; a repair candidate never does. Here the page owns it and a
 * candidate worker receives a COPY — note that `send` posts without a transfer
 * list, so the structured clone leaves this buffer intact. Transferring would
 * detach it, and terminating the worker would then destroy the only copy. That
 * is precisely the failure the cancellation test has to rule out.
 */
let authoritative = null;

/**
 * FNV-1a over the raw bytes.
 *
 * A cheap non-cryptographic digest is the right tool: this answers "did these
 * bytes change", not "could someone forge these bytes". Computed over a
 * `Uint8Array` view so it sees the actual float bits, not decimal renderings.
 */
function digestOf(buffer) {
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(buffer)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Meshes generated IN THE PAGE, by name.
 *
 * WHY NOT BUILD THEM IN NODE AND SEND THEM. The first version did, and
 * `Array.from` over a 50 MiB mesh produced millions of boxed numbers in the
 * test runner, which then had to be structured-cloned across the Playwright
 * bridge — the Node process died with "JavaScript heap out of memory" before
 * the browser had done any work at all. That measured the bridge, not the
 * candidate.
 *
 * Generating in the page also matches production: CAD Fixer's geometry is
 * already in the browser, so a repair candidate never receives a mesh over a
 * network-shaped boundary.
 */
const generated = new Map();
let generators = null;

window.cfHarness = {
  /** Builds a named mesh in the page using the shared deterministic generators. */
  async buildMesh(name, spec) {
    generators ??= await import('/scale-meshes.mjs');
    const startedAt = performance.now();
    let mesh;
    if (spec.kind === 'uvSphere') {
      mesh = generators.uvSphere(
        spec.segments,
        spec.rings,
        spec.radius ?? 1,
        spec.centre ?? [0, 0, 0],
      );
    } else if (spec.kind === 'openedSphere') {
      mesh = generators.openedSphere(spec.segments, spec.rings, spec.radius ?? 1);
    } else if (spec.kind === 'crackedGrid') {
      mesh = generators.crackedGrid(spec.side, spec.gap);
    } else {
      throw new Error(`unknown mesh kind ${String(spec.kind)}`);
    }
    generated.set(name, mesh);
    return {
      name,
      buildMs: performance.now() - startedAt,
      vertices: mesh.positions.length / 3,
      triangles: mesh.triangles.length / 3,
      bytes: generators.transferBytes(mesh.positions.length / 3, mesh.triangles.length / 3),
    };
  },

  /** Chooses tessellation parameters for a target transfer size, in the page. */
  async sphereForBytes(targetBytes) {
    generators ??= await import('/scale-meshes.mjs');
    return generators.sphereForBytes(targetBytes);
  },

  releaseMeshes() {
    generated.clear();
    return true;
  },

  /** Runs an operation against a named in-page mesh. Nothing large crosses out. */
  async runOnMesh(sessionId, meshName, request, options) {
    const mesh = generated.get(meshName);
    if (mesh === undefined) return { ok: false, phase: 'NO_MESH' };
    return this.run(
      sessionId,
      { ...request, positions: mesh.positions, triangles: mesh.triangles },
      options ?? { returnGeometry: false },
    );
  },

  /** Two-solid boolean against two named in-page meshes. */
  async booleanOnMeshes(sessionId, leftName, rightName, opType) {
    const a = generated.get(leftName);
    const b = generated.get(rightName);
    if (a === undefined || b === undefined) return { ok: false, phase: 'NO_MESH' };
    return this.run(
      sessionId,
      {
        type: 'boolean',
        opType,
        a: { positions: a.positions, triangles: a.triangles },
        b: { positions: b.positions, triangles: b.triangles },
      },
      { returnGeometry: false },
    );
  },

  /** Stores the page-side authoritative mesh and returns its digest. */
  setAuthoritative(positions, triangles) {
    authoritative = {
      positions: Float64Array.from(positions),
      triangles: Uint32Array.from(triangles),
    };
    return this.authoritativeDigest();
  },

  authoritativeDigest() {
    if (authoritative === null) return null;
    return {
      positions: digestOf(authoritative.positions.buffer),
      triangles: digestOf(authoritative.triangles.buffer),
      positionBytes: authoritative.positions.byteLength,
      triangleBytes: authoritative.triangles.byteLength,
      // A detached buffer reports length 0, which is how a transfer-instead-of-
      // clone bug would announce itself here.
      detached: authoritative.positions.byteLength === 0,
    };
  },

  /** Sends a COPY of the authoritative mesh to a session, never the original. */
  async runOnAuthoritative(sessionId, request) {
    if (authoritative === null) return { ok: false, phase: 'NO_AUTHORITATIVE_MESH' };
    return this.run(sessionId, {
      ...request,
      positions: authoritative.positions,
      triangles: authoritative.triangles,
    });
  },

  async beginLongOnAuthoritative(sessionId, request) {
    if (authoritative === null) return { ok: false, phase: 'NO_AUTHORITATIVE_MESH' };
    return this.beginLongOperation(sessionId, {
      ...request,
      positions: authoritative.positions,
      triangles: authoritative.triangles,
    });
  },

  environment() {
    return {
      userAgent: navigator.userAgent,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      hardwareConcurrency: navigator.hardwareConcurrency,
      origin: location.origin,
    };
  },

  staleMessages() {
    return stale;
  },

  /** Creates a worker and initialises a candidate. Returns phase timings. */
  async open(candidateId) {
    const session = createSession(candidateId);
    const call = send(session, { type: 'init', candidateId });
    const reply = await call.settled;
    if (reply.type !== 'ready') {
      return {
        ok: false,
        sessionId: session.sessionId,
        phase: 'WASM_INITIALIZATION_FAILED',
        message: reply.message,
      };
    }
    return {
      ok: true,
      sessionId: session.sessionId,
      workerCreateMs: session.createMs,
      ...reply.timings,
      initTotalMs: performance.now() - call.startedAt,
    };
  },

  /**
   * Runs one operation.
   *
   * `returnGeometry` decides whether the mesh crosses back to Node for real
   * Stage 2 validation, or whether only a summary is returned. Large scaling
   * runs use the summary — shipping 50 MiB through the Playwright bridge would
   * measure the bridge, not the candidate — and the report says which was used.
   */
  async run(sessionId, request, { returnGeometry = true } = {}) {
    const session = sessions.get(sessionId);
    if (session === undefined || session.terminated) return { ok: false, phase: 'NO_SESSION' };

    const call = send(session, request);
    const reply = await call.settled;
    if (reply.type !== 'result') {
      return { ok: false, phase: 'OPERATION_FAILED', message: reply.message };
    }

    const result = reply.result;
    const summary = summarise(result.outPositions, result.outIndices);
    const payload = {
      ok: true,
      totalMs: performance.now() - call.startedAt,
      kernelStatus: result.kernelStatus,
      ingestMs: result.ingestMs,
      kernelMs: result.kernelMs,
      extractMs: result.extractMs,
      heapBeforeIngest: result.heapBeforeIngest,
      heapAfterIngest: result.heapAfterIngest,
      heapAfterOperation: result.heapAfterOperation,
      heapAfterExtract: result.heapAfterExtract,
      outputVertices: result.outputVertices,
      outputTriangles: result.outputTriangles,
      summary,
      kernelReportedSuccess: result.kernelReportedSuccess ?? null,
      volume: result.volume ?? null,
      kernelComponents: result.kernelComponents ?? null,
      moebiusFacets: result.moebiusFacets ?? null,
      filledHoles: result.filledHoles ?? null,
      unsupportedInput: result.unsupportedInput ?? false,
    };
    if (returnGeometry && result.outPositions !== undefined) {
      payload.positions = Array.from(result.outPositions);
      payload.triangles = Array.from(result.outIndices);
    }
    return payload;
  },

  /**
   * Starts an operation and resolves as soon as the worker CONFIRMS it began,
   * leaving the kernel running. The cancellation tests need a worker that is
   * genuinely inside a synchronous WASM call, not one that might not have
   * started yet.
   */
  async beginLongOperation(sessionId, request) {
    const session = sessions.get(sessionId);
    if (session === undefined) return { ok: false, phase: 'NO_SESSION' };

    const call = send(session, request);
    session.inFlight = call;
    const startedAt = await call.started;
    return { ok: true, opId: call.opId, startedAtMs: startedAt - call.startedAt };
  },

  /** True while the in-flight operation has not produced a result. */
  stillRunning(sessionId) {
    const session = sessions.get(sessionId);
    if (session === undefined) return false;
    return session.pending.size > 0;
  },

  /** Proof the page's own thread is responsive while a kernel runs. */
  mainThreadResponsive() {
    const started = performance.now();
    // A trivial DOM write plus a frame: if the page thread were blocked, this
    // could not complete. It is not a benchmark, it is a liveness check.
    document.getElementById('beat').textContent = String(Math.round(started));
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(performance.now() - started);
      });
    });
  },

  /** Terminates a session's worker and measures how long the call takes. */
  terminate(sessionId) {
    const session = sessions.get(sessionId);
    if (session === undefined) return { ok: false, phase: 'NO_SESSION' };

    const startedAt = performance.now();
    session.worker.terminate();
    const terminateCallMs = performance.now() - startedAt;
    session.terminated = true;
    // Left in the map, marked dead, so a late message from it is classified as
    // stale rather than as an unknown session.
    return { ok: true, terminateCallMs, pendingAtTerminate: session.pending.size };
  },

  /**
   * Time until the terminated worker is observably gone.
   *
   * Measured as "no message from it arrived within a quiet window after the
   * pending operation would otherwise have completed", because the platform
   * offers no termination event. The number is an OBSERVATION BOUND, not a
   * kernel-stop time, and the report says so.
   */
  async observeTermination(sessionId, quietMs) {
    const before = stale.length;
    const startedAt = performance.now();
    await new Promise((resolve) => {
      setTimeout(resolve, quietMs);
    });
    return {
      observedMs: performance.now() - startedAt,
      lateMessages: stale.length - before,
    };
  },

  close(sessionId) {
    const session = sessions.get(sessionId);
    if (session === undefined) return false;
    session.worker.terminate();
    session.terminated = true;
    sessions.delete(sessionId);
    return true;
  },
};
