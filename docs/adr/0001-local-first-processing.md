# 0001 — Local-first geometry processing

- Status: Accepted
- Date: 2026-08-14

## Context

CAD Fixer processes 3D models that users are preparing for printing. Those files
are frequently confidential: prototypes under NDA, medical devices, client work,
unreleased products. Uploading them to a server is a meaningful disclosure, and
for some users it is disqualifying regardless of how the server behaves.

Browsers can now do this work locally. Web Workers give us threads,
WebAssembly gives us near-native geometry kernels, and WebGL/WebGPU give us GPU
access. The capability gap that historically forced server-side processing has
largely closed for mesh-scale work.

Server-side processing would also mean bandwidth costs proportional to file
size, upload latency measured in minutes for large meshes, a data breach surface
holding customers' intellectual property, and data-residency obligations.

## Decision

**All geometry processing happens on the user's machine, inside the browser.**
Raw user geometry stays local by default.

Specifically:

- No server-side geometry processing.
- No file upload API.
- No transmission of imported or produced models to any third party, including
  analytics, logging, crash reporting, and storage.
- Parsing, validation, repair, boolean operations, subdivision, displacement,
  hollowing, and export all execute in the browser.

This is a product promise, not an implementation detail. It is stated in the
interface and enforced by lint rules, type constraints, and an end-to-end test —
see [PRIVACY_ARCHITECTURE.md](../PRIVACY_ARCHITECTURE.md) §5.

## Alternatives considered

**Server-side processing.** Simplest path to powerful geometry kernels: run
CGAL or OpenCascade natively, no WASM porting, no browser memory ceiling.
Rejected because it destroys the core promise, creates a breach surface holding
customer IP, and makes large files slow and expensive.

**Hybrid — local by default, optional cloud for heavy operations.** Attractive
for very large meshes that exceed browser memory. Rejected _for now_, not
forever: introducing it in Stage 0 would mean building an upload path we have
promised not to have, and the architecture would drift toward assuming a server
exists. If it is ever added it must be explicit, opt-in per operation, and
clearly disclosed. Nothing in the current architecture prevents it later.

**Local desktop application (Electron/Tauri).** Removes browser memory and
threading limits entirely. Rejected as the starting point: distribution and
update friction is high, and it forecloses the zero-install web reach. The
architecture does not prevent packaging the same code later.

## Consequences

**Positive**

- The privacy promise is architectural, not a policy statement.
- No per-file infrastructure cost; hosting is a static site.
- Works offline once loaded.
- No upload wait; large files are read from disk at local speed.

**Negative**

- We are bound by browser memory limits. Very large meshes may hit
  `RESOURCE_LIMIT_EXCEEDED` where a server would not. This must be surfaced as a
  clear, honest failure.
- Geometry kernels must be WASM-portable, which narrows the field and rules out
  some mature C++ libraries that do not compile cleanly to WASM.
- Performance depends on the user's hardware and varies widely.
- Multithreaded WASM requires cross-origin isolation, constraining hosting and
  every future third-party resource — see
  [ADR 0003](0003-worker-and-wasm-boundary.md) and
  [DEPLOYMENT_REQUIREMENTS.md](../DEPLOYMENT_REQUIREMENTS.md).
- We cannot debug a user's failing file by looking at it. Diagnostics must be
  designed to work from structured, non-sensitive reports the user chooses to
  send.
