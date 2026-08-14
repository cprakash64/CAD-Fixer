# Privacy Architecture

CAD Fixer's central promise is that a user's model never leaves their machine.
This document defines what that means concretely, what network traffic is
permitted, and how the constraint is enforced rather than merely intended.

## 1. The promise

**Raw user geometry stays local by default.** Files are read, parsed, repaired,
and exported entirely within the browser, using Web Workers, WebAssembly, and
the machine's own CPU and GPU. There is no server-side geometry processing and
no upload path.

The application header states this to the user. That statement is a factual
claim about the build, and it must be removed or qualified the moment it stops
being true.

## 2. Allowed network traffic

Only these are permitted, and only the first exists today.

| Traffic                                                             | Status                        | Notes                                                                      |
| ------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| Static application assets (HTML, JS, CSS, WASM) from our own origin | **Present**                   | The application bundle itself. Same-origin only.                           |
| Application update checks                                           | Not implemented               | Version metadata only. Must never carry document state.                    |
| Anonymous aggregate telemetry                                       | Not implemented, not approved | Would require an ADR, a user-facing disclosure, and the constraints in §4. |
| Authentication and billing                                          | Not implemented, out of scope | When added, must not touch the geometry pipeline.                          |

## 3. Forbidden by default

These are prohibited. Introducing any of them requires an explicit, recorded
product decision — not a code review nod.

- **Uploading an imported model**, in whole or in part, to any destination.
- **Uploading a repaired, converted, split, textured, or hollowed model.**
- **Sending geometry to analytics** in any form, including derived data such as
  vertex positions, bounding boxes, or mesh hashes that could fingerprint a
  design.
- **Sending filenames** anywhere. A filename is user data — `client-acme-
prosthetic-v4.stl` leaks a business relationship on its own.
- **Binary model contents in error reports.** No buffer, no slice of a buffer,
  no base64 excerpt, no "first 64 bytes for debugging".
- **Third-party embeds** — fonts, CDN scripts, tag managers, session replay,
  heatmaps. Session replay is called out specifically: it would capture the
  viewport, which means capturing the user's model.

## 4. If telemetry is ever introduced

Not approved. Recorded here so the bar is known in advance:

1. Counters and enumerations only — never free text, never identifiers derived
   from user content.
2. A filename, path, or file size is never an acceptable field. File **format**
   and a coarse size **bucket** may be, and only with disclosure.
3. Error reports carry the `AppErrorCode` and our own `details` — which are
   restricted by the type system to primitives — never a `cause` chain that may
   embed user data.
4. Off by default, with a visible control.
5. An ADR recording the decision.

## 5. How this is enforced

Intent is not a control. These are the actual mechanisms:

**Lint-level ban on network APIs.** `eslint.config.js` makes `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, and `navigator.sendBeacon` errors
across the codebase. An accidental network call fails CI. Removing the ban is a
visible diff in a config file, not a quiet line in a component.

**Error details are typed as primitives.** `ErrorDetailValue` is
`string | number | boolean | null`. An `ArrayBuffer` or a mesh cannot be attached
to an `AppError` without a type error, so geometry cannot reach a log through
the normal error path.

**File contents are not read at all in Stage 0.** The import surface touches
`File.name` and `File.size` only. A unit test asserts that neither
`File.arrayBuffer()` nor `File.text()` is called on a dropped file.

**An end-to-end test asserts network silence.** The Playwright suite records
every request the page makes, including during a worker round trip, and fails if
anything targets an origin other than the application's own.

**No third-party runtime dependencies that fetch.** The runtime tree is React,
React DOM, and Three.js. Only system fonts are used, so no font is fetched.

## 6. Data at rest

Nothing is persisted in Stage 0 — no localStorage, no IndexedDB, no cookies, no
service worker cache of user data. When local persistence is added it must be
visible to the user and clearable by them.

## 7. Threat model note

The screening step at the import boundary is a **usability filter, not a
security control**. It checks a filename extension and a declared size. It reads
no bytes and establishes no trust.

The real boundary is the future parser, which will handle untrusted, potentially
hostile files. Its requirements are recorded in
[ARCHITECTURE.md](ARCHITECTURE.md) §4 and are not satisfied by anything in
Stage 0, because no parser exists.
