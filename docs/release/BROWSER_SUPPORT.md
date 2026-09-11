# Browser Support

Qualified in Stage 5B against commit `8a800b5e137602008eced0aef3fd9beee5bcfe9c`,
on macOS 27.0 / Apple Silicon / 8 GiB, serving the production build under the
headers in `PRODUCTION_HOSTING_REQUIREMENTS.md`.

**Every row below is backed by something that was actually run.** Rows with no
evidence say so.

## Support matrix

| Environment                             | Status                                           | Evidence                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chromium 151.0.7922.34**, macOS ARM64 | **RELEASE QUALIFIED**                            | Full MVP flow: 154 E2E, 11 timing, 77 harness, plus the Stage 5B WebGL, DPR, hosting and isolation suites                                                                                |
| **WebKit 26.5** (Playwright build)      | **CAPABILITY COMPATIBLE, NOT RELEASE QUALIFIED** | Capability probe under isolation: every required API present, including `SharedArrayBuffer`, `Atomics.wait`, module workers, WebGL2, `DecompressionStream`. **No product flow was run.** |
| **Safari** (any version)                | **NOT RELEASE QUALIFIED**                        | Not tested. Playwright's WebKit is _not_ Safari — different release cadence, different process model, different WebGL backend. The WebKit row above is encouraging, not transferable.    |
| **Firefox**                             | **NOT RELEASE QUALIFIED**                        | Playwright's Firefox **could not be launched on this host**: `browserType.launch` timed out at 180 s and again at 300 s on macOS 27.0. No capability inventory obtained.                 |
| Touch / mobile                          | **NOT RELEASE QUALIFIED**                        | Out of MVP scope. No touch interaction was qualified.                                                                                                                                    |

## Initial release policy

> **Chromium-based desktop browsers only.**

This is a statement about evidence, not about the other engines' quality. WebKit
looks capable and Firefox is simply unknown on this host. Nothing in the product
or its documentation may claim support for an engine in the lower rows.

## Required browser capabilities

### Required for the application to run at all

| Capability                              | Used for                                              |
| --------------------------------------- | ----------------------------------------------------- |
| Web Workers (ES modules)                | All geometry; the page never parses or repairs a mesh |
| Transferable `ArrayBuffer`              | Moving render buffers without copying                 |
| WebGL (WebGL2 preferred)                | The viewport                                          |
| File API, `Blob`, `URL.createObjectURL` | Reading imports, saving exports                       |
| `ResizeObserver`                        | Viewport sizing                                       |

Without these there is no usable application.

### Required for conservative repair and hole filling

| Capability                                                  | Used for                                                |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| `SharedArrayBuffer` + `Atomics`                             | The cancellation flag a worker reads mid-pass           |
| **Cross-origin isolation** (`crossOriginIsolated === true`) | The precondition browsers impose on `SharedArrayBuffer` |

**These fail closed.** Without them the repair panel is replaced by a refusal
naming the cause; import, Mesh Health and export continue to work. CAD Fixer will
not offer a repair it could not stop.

### Required for specific formats

| Capability                              | Used for                              |
| --------------------------------------- | ------------------------------------- |
| `DecompressionStream('deflate-raw')`    | 3MF import (a 3MF is a ZIP)           |
| WebAssembly (+ streaming instantiation) | The self-intersection diagnostic only |

## Viewport and display

| Property             | Qualified                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device pixel ratio   | **Clamped to 2.** Verified at DPR 1, 2 and 3 by reading the canvas backing store — at DPR 3 the effective ratio stays at 2, which is where an unclamped renderer would be caught |
| Largest viewport     | **3840 × 2160** at ratio 2 ≈ 33.2 M pixels; the qualified envelope is under 40 M pixels                                                                                          |
| Minimum editor width | **900 px.** Below this the workflow was not qualified                                                                                                                            |
| Resize               | 100 cycles across four sizes; backing store tracks the current box, model still drawn, no viewport error                                                                         |

The DPR clamp is the one number here that is a product decision rather than a
measurement: a 4K viewport at an unclamped DPR 3 would be 2.25× the pixels of the
qualified envelope, and no evidence exists that it is safe.

## WebGL context loss

| Behaviour                           | Status                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| Context lost with a model loaded    | Reported as a **display** failure; the document, its revision and Mesh Health are unchanged |
| Automatic renderer restoration      | **Not implemented.** The user is asked to reload                                            |
| Geometry after context loss         | Intact and **still exportable** — it lives in a worker, and export does not touch the GPU   |
| Apply / Undo across a context fault | Exact; the transaction never passes through the renderer                                    |
| GPU resource counters after a fault | No double disposal, no leak                                                                 |

Reload-to-recover is an accepted MVP limitation, recorded as such rather than
presented as seamless recovery.

## Unsupported browsers

A browser missing a **required** capability currently produces feature-level
refusals rather than a single up-front "unsupported browser" screen: the viewport
reports that it could not start, and repair reports that isolation is missing.
Each message is truthful and specific. A consolidated capability gate was
considered and deliberately not added in Stage 5B — see the qualification
document.
