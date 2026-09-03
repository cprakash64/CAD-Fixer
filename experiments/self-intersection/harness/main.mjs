/**
 * Stage 3C-1A harness control surface. RESEARCH ONLY.
 *
 * Everything a test needs is exposed on `window.si`. The page itself NEVER
 * reads coordinate contents: it creates workers, wires a MessageChannel between
 * them, and reads back scalar reports. That is the architectural claim under
 * test — the UI must not become a geometry holder — so the harness is written to
 * make violating it visible rather than convenient.
 */
const state = { diagnostic: null, producer: null, channel: null };

function grid(side) {
  const positions = [];
  for (let y = 0; y <= side; y += 1) {
    for (let x = 0; x <= side; x += 1) positions.push(x, y, 0);
  }
  const triangles = [];
  const at = (x, y) => y * (side + 1) + x;
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      triangles.push(at(x, y), at(x + 1, y), at(x, y + 1));
      triangles.push(at(x + 1, y), at(x + 1, y + 1), at(x, y + 1));
    }
  }
  return { positions, triangles };
}

const once = (target, predicate) =>
  new Promise((resolve) => {
    const handler = (e) => {
      if (predicate(e.data)) {
        target.removeEventListener('message', handler);
        resolve(e.data);
      }
    };
    target.addEventListener('message', handler);
  });

function newDiagnosticWorker() {
  state.diagnostic?.terminate();
  state.diagnostic = new Worker('/harness/diagnostic-worker.mjs', { type: 'module' });
  return state.diagnostic;
}

window.si = {
  env: () => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    wasm: typeof WebAssembly,
  }),

  grid,

  /** Option A-style: geometry created in the page and posted to the worker. */
  async runDirect(fixture, limits) {
    const w = newDiagnosticWorker();
    const positions = Float64Array.from(fixture.positions);
    const triangles = Uint32Array.from(fixture.triangles);
    const started = performance.now();
    w.postMessage({ kind: 'geometry', positions, triangles, limits }, [
      positions.buffer,
      triangles.buffer,
    ]);
    const msg = await once(w, (d) => d?.kind === 'result');
    return { ...msg.report, roundTripMs: performance.now() - started };
  },

  /** OPTION B: producer worker -> MessageChannel -> diagnostic worker. */
  async setupChannel(fixture) {
    state.producer?.terminate();
    state.producer = new Worker('/harness/producer-worker.mjs', { type: 'module' });
    const diag = newDiagnosticWorker();

    state.producer.postMessage({
      kind: 'load',
      positions: fixture.positions,
      triangles: fixture.triangles,
    });
    const loaded = await once(state.producer, (d) => d?.kind === 'loaded');

    state.channel = new MessageChannel();
    state.producer.postMessage({ kind: 'port', port: state.channel.port1 }, [state.channel.port1]);
    diag.postMessage({ kind: 'port', port: state.channel.port2 }, [state.channel.port2]);
    await once(state.producer, (d) => d?.kind === 'port-ready');
    await once(diag, (d) => d?.kind === 'port-ready');
    return loaded.hashes;
  },

  async runOverChannel(limits) {
    const started = performance.now();
    state.producer.postMessage({ kind: 'send-geometry', limits });
    const sent = await once(state.producer, (d) => d?.kind === 'sent');
    const msg = await once(state.diagnostic, (d) => d?.kind === 'result');
    return { ...msg.report, postMs: sent.postMs, roundTripMs: performance.now() - started };
  },

  /** Starts a run and resolves as soon as the worker is known to be busy. */
  async startOverChannel(limits) {
    state.producer.postMessage({ kind: 'send-geometry', limits });
    await once(state.producer, (d) => d?.kind === 'sent');
    return performance.now();
  },

  /** CANCELLATION: kill the diagnostic worker only. */
  terminateDiagnostic() {
    state.diagnostic?.terminate();
    state.diagnostic = null;
    return performance.now();
  },

  /** Proves the authoritative worker is alive and its geometry intact. */
  async verifyAuthoritative() {
    state.producer.postMessage({ kind: 'verify' });
    const msg = await once(state.producer, (d) => d?.kind === 'verified');
    return msg.hashes;
  },

  /** Rebuilds a diagnostic worker and rewires the channel: the retry path. */
  async recreateDiagnostic() {
    const diag = newDiagnosticWorker();
    state.channel = new MessageChannel();
    state.producer.postMessage({ kind: 'port', port: state.channel.port1 }, [state.channel.port1]);
    diag.postMessage({ kind: 'port', port: state.channel.port2 }, [state.channel.port2]);
    await once(state.producer, (d) => d?.kind === 'port-ready');
    await once(diag, (d) => d?.kind === 'port-ready');
    return true;
  },

  memory: () => (performance.memory ? performance.memory.usedJSHeapSize : null),
};

document.getElementById('state').textContent = 'ready';
