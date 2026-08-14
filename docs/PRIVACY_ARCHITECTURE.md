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

**File reading happens in exactly one place.** `runtime/import-service.ts` is
the only module in the application that calls `File.arrayBuffer()`. That is a
privacy control as much as an architectural one: "does this application read
your file anywhere unexpected?" is answerable by reading one file. A unit test
asserts a refused file is never opened at all.

**Model bytes are moved, never broadcast.** The file buffer goes to the worker
by transfer and comes back as canonical geometry by transfer. It is never
serialised to text, never put in a URL, and never attached to an error.

**Export is a local `Blob`.** `runtime/download.ts` builds a `Blob` from bytes
already in memory and hands it to the browser's own download mechanism. No
request is made, no server is involved, and the object URL is revoked afterwards
so the buffer is not pinned for the life of the document.

**Exported files carry no user-supplied text.** The binary STL header is a fixed
string and the ASCII solid name is a constant. The source filename is never
written into an exported file, so a model shared onward cannot leak the name of
the project it came from. Tests assert this for both writers.

**An end-to-end test asserts network silence, twice over.** The Playwright suite
records every request the page makes across a full import AND export cycle. One
test fails if anything targets a foreign origin; a second fails if any request
carries a body or uses a method other than GET/HEAD — because "no external
requests" alone would not catch a POST back to our own origin.

**No third-party runtime dependencies that fetch.** The runtime tree is React,
React DOM, and Three.js. Only system fonts are used, so no font is fetched.

## 6. Data at rest

Nothing is persisted — no localStorage, no IndexedDB, no cookies, no service
worker cache of user data. An imported model lives in memory only and is gone
when the tab closes. When local persistence is added it must be visible to the
user and clearable by them.

## 7. Threat model note

The screening step at the import boundary is a **usability filter, not a
security control**. It checks a filename extension and a declared size. It reads
no bytes and establishes no trust.

The real boundary is the STL parser, which handles untrusted, potentially
hostile files. It runs in a worker, treats every declared value as adversarial,
preflights every allocation against a typed budget, and rejects rather than
repairs what it cannot represent. Its requirements are recorded in
[ARCHITECTURE.md](ARCHITECTURE.md) §4, and the adversarial cases it is tested
against are in `packages/file-formats/src/stl/stl-reader.test.ts`.

Note what this does and does not protect against. It protects the tab from
malformed and hostile files: no unbounded allocation, no unchecked offset, no
catastrophic backtracking, no silent corruption of coordinates. It does **not**
make an untrusted model safe to trust as geometry — a structurally valid file
can still describe a nonsensical part. That is a diagnostics problem, not a
security one.
