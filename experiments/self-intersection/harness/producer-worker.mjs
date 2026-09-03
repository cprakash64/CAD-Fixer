/**
 * Stage 3C-1A stand-in for the AUTHORITATIVE geometry worker. RESEARCH ONLY.
 *
 * It owns the canonical buffers, exactly as the production geometry worker does,
 * and it never gives them away. When a diagnostic is requested it makes a
 * DISPOSABLE COPY and sends that, so a terminated diagnostic worker can take
 * nothing authoritative with it.
 */
let authoritative = null;

function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hashes() {
  return {
    positions: fnv1a(new Uint8Array(authoritative.positions.buffer)),
    triangles: fnv1a(new Uint8Array(authoritative.triangles.buffer)),
    vertexCount: authoritative.positions.length / 3,
    faceCount: authoritative.triangles.length / 3,
  };
}

let channelPort = null;

self.addEventListener('message', (event) => {
  const data = event.data;

  if (data?.kind === 'load') {
    authoritative = {
      positions: Float64Array.from(data.positions),
      triangles: Uint32Array.from(data.triangles),
    };
    self.postMessage({ kind: 'loaded', hashes: hashes() });
    return;
  }

  if (data?.kind === 'port') {
    channelPort = data.port;
    channelPort.start?.();
    self.postMessage({ kind: 'port-ready' });
    return;
  }

  if (data?.kind === 'send-geometry') {
    // THE DISPOSABLE COPY. `slice()` allocates new buffers; the authoritative
    // ones are neither transferred nor detached, so this worker still owns
    // intact geometry no matter what happens to the diagnostic worker.
    const positions = authoritative.positions.slice();
    const triangles = authoritative.triangles.slice();
    const started = performance.now();
    channelPort.postMessage({ kind: 'geometry', positions, triangles, limits: data.limits ?? {} }, [
      positions.buffer,
      triangles.buffer,
    ]);
    self.postMessage({ kind: 'sent', postMs: performance.now() - started });
    return;
  }

  if (data?.kind === 'verify') {
    // Proves the authoritative buffers survived the transfer and any terminate.
    self.postMessage({ kind: 'verified', hashes: hashes() });
  }
});
