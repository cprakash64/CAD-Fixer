# Stage 6E — Streaming 3MF import

Stage 6E-A1 (below) is the architecture, security proof and memory prototype.
**Stage 6E-A2 productionised it**; where the two disagree, the A2 section near
the end of this document is current. A1's own statements are kept as the record
of what was measured when.

Stage 6E-A1: architecture, security proof and memory prototype. **Nothing in this
stage reaches a shipped path.** The production import is the whole-buffer
reader exactly as v0.2.0 shipped it, `maxEntryBytes` is still **256 MiB**, and
no fixture, eligibility rule or refusal a user can see has changed.

## Why this exists

BETA-002 is a real 3MF whose single model part inflates to **297 MiB**, past the
256 MiB per-entry ceiling. Stage 6D-B3 measured what admitting that class would
cost as the reader is built — **≈ 2.1 GiB of renderer footprint at 293.7 MiB**
through the real product — and concluded that raising the constant would only
move the failure. It recorded streaming import as the remaining route
(`STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md`, "What this means for
BETA-002"). A1 answers whether that route is real: whether a streamed reader can
be made **exactly** as strict as the whole-string one, and what it actually saves
in Chromium.

A1 does **not** choose the future large-entry ceiling. It returns measurements.

## The whole-buffer path, today

For each model part, `loadModelPart` in `threemf-reader.ts` does:

| Step | What is held                                                          | Size at a 293.7 MiB entry    |
| ---- | --------------------------------------------------------------------- | ---------------------------- |
| 1    | `readZipEntry` → one `Uint8Array` of the declared size                | 293.7 MiB off-heap           |
| 2    | `decodeText` → one JavaScript string                                  | 293.7 MiB on-heap (one-byte) |
| 3    | `describeUnsafeXml` on the string, then `scanXml`                     | + per-element garbage        |
| 4    | `parseModelXml` accumulates `number[]` scratch                        | ≈ 150 MiB (B3)               |
| 5    | `materialiseMeshes` → canonical Float32/Uint32 buffers, scratch freed | geometry                     |

Steps 1 and 2 coexist, and the string cannot be partially released: V8 keeps it
until the last slice of it dies. That is ~2× the entry before a single element
has been read.

### A finding outside A1's scope, recorded and not changed

> **Superseded by Stage 6E-A2 (finding R3): FIXED.** `createSlicedInflater` is
> now the only raw-deflate shape, in both workers and in the tests. The
> measurements are in the A2 section.

Chromium's `DecompressionStream` inflates **an entire input write** into its
readable queue before the reader can pull. Measured in A1 with a 109 MiB entry:
one write of the compressed payload queued **109 MiB** of output. The production
`inflateRaw` writes the whole payload in one call, so today's path holds the
queued chunks **and** the preallocated entry buffer at once — roughly 2× the
entry during step 1 alone. Feeding the input in bounded slices, awaited one at a
time, bounds the queue to about one slice. **Production is not changed by A1**;
this belongs to whichever later stage touches the production inflater, and it is
independent of streaming.

## The architecture

```
ZIP entry bytes (compressed, already resident — the file itself)
    │  streamZipEntry  (slice-fed inflater, every per-entry rule, no allocation of the entry)
    ▼
Uint8Array chunks ──► TextDecoder {stream:true} ──► string pieces
    │
    ├── PASS 1: XmlSecurityStream.push(piece)   … finish() → refusal | clear
    │           (charges the package InflationBudget)
    │
    └── PASS 2: XmlStreamScanner.push(piece)    → applyTag → the SAME handlers
                (re-inflates; not charged again; still held to every per-entry rule)
                   │
                   ▼
           createModelXmlParser(...).handlers  →  finish()  →  materialiseMeshes
```

What is new, all in `packages/file-formats/src/threemf/`:

- `xml-stream.ts` — `XmlSecurityStream`, `XmlStreamScanner`,
  `scanXmlByteStream`, `StreamScanStats`.
- `zip.ts` — `streamZipEntry` and its `ZipEntryChunks` iterator.
- `xml-scan.ts` — `applyTag` extracted from `scanXml`, **behaviour-preserving**:
  `scanXml` now calls it, and every pre-existing XML test passes unchanged.
- `threemf-reader.ts` — `parseModelXml` split into `createModelXmlParser` +
  `scanXml`, so the whole-string and streamed paths feed **one** set of element
  handlers. `ThreeMfReadOptions.ingestion` selects the streamed path; nothing in
  the application passes it.
- `import-errors.ts` — one new code, `XML_TAG_TOO_LONG`, produced only by the
  streamed path (see "Limits").

### Why two passes

`scanXml` refuses an unsafe document **before a single element is scanned for
meaning**, and `describeUnsafeXml` reports with a fixed precedence:

| Precedence | Rule                                   | Where it is searched |
| ---------- | -------------------------------------- | -------------------- |
| 1          | `<!DOCTYPE` (any case)                 | the prolog           |
| 2          | `<!ENTITY` (any case)                  | the whole text       |
| 3          | `\b(SYSTEM\|PUBLIC)\s+["']` (any case) | the prolog           |

The prolog is everything before the first `<` that is not followed by `?` or
`!`. An `<!ENTITY` can appear anywhere — including after millions of vertices —
and a late DOCTYPE outranks an early ENTITY. A single streaming pass could only
either act on elements before the verdict is known (weaker than today) or buffer
events until the end (the memory we are trying not to spend). **Pass 1 reads the
whole part and decides; pass 2 is reached only by a part pass 1 cleared.** The
guarantee is the whole-string one, with the same precedence, not an
approximation.

The price is a second inflate and decode of each model part. It is bounded:
the compressed bytes are already resident (they are the file), each pass holds
about one slice, and the second pass is held to the same per-entry rules as the
first, so it cannot become a different or larger stream. Measured cost is in
"Measurements".

**Each model part is parsed once.** The reachable-part graph still loads a part
at most once, so a child referenced three times costs two inflations, not six
(asserted in `streaming-ingestion.test.ts`).

### The security automaton

`XmlSecurityStream` is `describeUnsafeXml`, incremental:

- Rules 1 and 2 are fixed-length literals. A carry of `length − 1` characters
  from the previous piece is exactly enough: an occurrence spanning a boundary
  has at most that many characters before it, and one lying wholly in the carry
  was already seen. (8 characters for `<!DOCTYPE`, 7 for `<!ENTITY`.)
- Rule 3 has an unbounded `\s+`, so it is an explicit automaton — word boundary,
  word, at least one character of JavaScript's `\s` class, a quote — with state
  that survives any split, including a split inside the whitespace run.
- Case folding is **ASCII only**, which is what `/i` does without the `u` flag.
  A Unicode-aware fold would accept spellings the whole-string rule rejects, or
  the reverse.
- Nothing is reported until `finish()`, because precedence can only be decided at
  the end.

### The scanner state machine

`XmlStreamScanner` reproduces `scanXml`'s tokenisation, **quirks included**,
because the contract is equality with the shipped reader, not with XML:

| Mode      | Entered on                    | Leaves on                | Retains                           |
| --------- | ----------------------------- | ------------------------ | --------------------------------- |
| `text`    | start, or after any construct | `<`                      | nothing (text is never delivered) |
| `open`    | `<`                           | classification completes | at most `<![CDATA[`'s prefix      |
| `tag`     | `<` + anything else           | the **first** `>`        | the tag so far, ≤ `maxTagLength`  |
| `pi`      | `<?`                          | `?>`                     | a 1-character terminator carry    |
| `comment` | `<!--`                        | `-->`                    | a 2-character terminator carry    |
| `cdata`   | `<![CDATA[`                   | `]]>`                    | a 2-character terminator carry    |

Preserved exactly:

- **A tag ends at the first `>`,** quote-unaware, as `scanXml` does. A `>` inside
  an attribute value ends the tag in both readers identically.
- The terminator search for `<?`, `<!--` and `<![CDATA[` starts at the `<`, so
  `<?>` and `<!-->` are complete constructs in both.
- End-tag names are not matched against start tags; depth is counted.
- Text, comment and CDATA content is never delivered to a handler.
- Every "unterminated" refusal at end of input uses `scanXml`'s message for the
  mode the scanner is in.

### Namespaces

Unchanged: prefixes are resolved from the `<model>` element's attributes only,
exactly as the element handlers do today. The handlers are shared, so the
streamed path cannot resolve namespaces differently. Per-element namespace
scoping remains a separate, deferred question — A1 neither adds nor removes it.

### Encoding

UTF-8 only, as v0.2.0. The streamed decoder is `TextDecoder('utf-8', { fatal:
false })` with `{ stream: true }`, so a multi-byte sequence split across chunks
decodes to the same code points as a whole-buffer decode, a leading BOM is
dropped the same way, and invalid bytes become U+FFFD identically. The XML
declaration's `encoding` pseudo-attribute is ignored, as today. Proven at every
byte split of mixed 1-, 2-, 3- and 4-byte sequences (6E-S4).

## Limits

Every whole-path limit applies per model part, unchanged: `maxElements` 80 M,
`maxDepth` 64, `maxAttributeLength` 65,536, `maxNameLength` 1,024, the document
part and object ceilings, and every ZIP rule — per-entry cap checked on the
**declared** size before anything is inflated, package inflation budget,
200:1 ratio, overrun and shortfall.

**One new bound, and why it cannot refuse a file today's reader accepts in
practice:** `maxTagLength`, **1 MiB**, the longest tag held while waiting for its
`>`. The whole-string reader needs no such bound because the string is already
resident. 1 MiB is sixteen maximum-length attribute values; the largest tag in
every fixture measured here is **129 characters**. A tag above it is refused as
`XML_TAG_TOO_LONG`, typed as too-large with the limit in `details`.

## Chunk boundaries

A chunk boundary is invisible by construction: no state assumes a construct is
complete inside one piece. Proof, in `xml-stream.test.ts`:

- **6E-S1** — every split position, one-code-unit pieces, and 25 seeded random
  partitions of valid, quirk-heavy, malformed (end of input in every mode) and
  unsafe documents, each compared with `scanXml`'s events **and** refusal.
- **6E-S3** — 4,000 seeded random documents built from the security markers,
  compared with `describeUnsafeXml`; every marker split at every position.
- **6E-S6** — driver chunk sizes 1–64 bytes; a late `<!ENTITY` is refused
  before any element event is emitted.
- **6E-R** (`streaming-ingestion.test.ts`) — `requiredextensions` split across
  every slice size 1–13.
- **6E-U** — Secure Content and Slice declared required, and an Alternatives
  element under a non-conventional prefix: the same code, reason, message and
  details whole and streamed, at slice sizes 1, 2, 3, 7, 64 and 4,096 bytes.
- **6E-D** — a corrupt deflate stream is the typed `ZIP_MALFORMED` "damaged"
  refusal on both paths, identical, and the next streamed read is unaffected.
- **6E-P** (`mutation-campaign.test.ts`) — every 3MF mutation case read whole and
  streamed (7-byte slices yielding every piece; 64 KiB slices yielding every 16),
  compared by fingerprint: unit, parts, names, material references, mesh
  sharing, transforms, geometry **bytes**, warnings, unsupported features, or
  the refusal's code, reason and message.
- **Real producer files** — seven packages from Prusa (FDM and SLA round trips,
  a wipe tower), OrcaSlicer and a Production-extension sample, left outside the
  repository by an earlier stage, plus three generated fixtures (two dense, one
  text-heavy with CJK text), each read whole and streamed at 7-byte, 4 KiB and 64 KiB
  slices and compared by a SHA-256 over unit, encoding, warnings, compatibility,
  part names, material references, sharing, transforms and geometry bytes:
  **30 of 30 identical.** This is a small corpus; A2 owes the full one.

## Cancellation

Both passes poll cancellation after every piece and yield to the event loop
every 16 pieces, so a cancel message is delivered mid-part; the ZIP iterator
also polls after accounting each chunk. The element handlers keep their
65,536-element poll. On any abrupt exit the `for await` returns the iterator,
which returns the inflater, which cancels the `DecompressionStream` reader —
nothing keeps inflating after a refusal or a cancel.

## Budgets

The package `InflationBudget` is charged **once**, by pass 1. Pass 2 is the same
bytes read again; the budget bounds what the archive expands to, not how often
CAD Fixer chooses to look at it. Pass 2 still enforces the per-entry cap, the
ratio, overrun and an exact-size end, so a replay that differed would be refused.
Proven: a root plus one child referenced three times charges exactly model +
relationship bytes.

The Stage 6D-R3 geometry gate runs unchanged after the read, and is measured by
the harness (`gate admitted` in every run below).

## Geometry scratch

Unchanged. The handlers still accumulate `number[]` and `materialiseMeshes`
still converts and frees it. Streaming removes the entry buffer and the string,
not the scratch — B3 measured the scratch at ≈ 0.5× the entry, and it is the
next target, not this one.

## Privacy

No telemetry, no upload, no new diagnostic that carries model data, token
streams, file names or snippets. `StreamScanStats` holds five integers. The
harness serves a local page from Node's `http` module on `127.0.0.1`, and
fixtures are generated in Node into a temporary directory outside the
repository and deleted on exit.

## Measurements

### Host and method

macOS 27.0 (26A5421a), MacBookPro17,1, Apple M1, **8.00 GiB RAM** — the same
minimum-envelope machine Stage 6D-B3 measured on. Chromium 151.0.7922.34
headless (Playwright 1.62.1), Node v22.22.2. **One browser per run**, because
`phys_footprint_peak` is the kernel's per-process high-water mark and cannot be
reset. Worker and page isolate heaps are read over CDP after a forced
collection. Every series recorded the load average and the count of foreign
headless-Chromium processes at start and end: load 3–7 from ordinary desktop
use, **zero foreign headless processes** in every series reported here.

An earlier series overlapped another project's Playwright run on this host. Its
memory figures agree with the re-run within ±5%, and it is quoted only where no
re-run exists (125.7, 248 and 442.7 MiB). Its whole-mode 248 MiB run 1 took
45.9 s to read and is discarded as a timing. **Durations are indicative
throughout; footprints are the evidence.**

**What `qualify:streaming-import` measures is the WORKER-SIDE import only**:
`read3mf`, the mesh and document gates, the Stage 6D-R3 geometry gate and the
non-indexed render expansion, kept resident. No page render upload, no GPU, no
topology analysis. Its whole-mode figures are therefore **not** B3's ~2.1 GiB
product figure; the product path is measured separately below, through the real
application, on the same bytes.

### Dense geometry — renderer `phys_footprint_peak`, worker-side

| Entry         | Triangles | Whole                             | Stream                    | Saved         |
| ------------- | --------- | --------------------------------- | ------------------------- | ------------- |
| 125.7 MiB     | 713,921   | 515 / 516                         | 374 / 400                 | ≈ 130 MiB     |
| 248.0 MiB     | 1,394,380 | 1,010 / 1,091                     | 593 / 694                 | ≈ 405 MiB     |
| **293.7 MiB** | 1,646,975 | **1,105 / 1,129 / 1,138 / 1,150** | **694 / 706 / 718 / 722** | **≈ 420 MiB** |
| 376.1 MiB     | 2,102,727 | 1,363 / 1,364 / 1,367 / 1,368     | 880 / 923 / 931 / 946     | ≈ 440 MiB     |
| 442.7 MiB     | 2,470,464 | 1,561 / 1,562                     | 984 / 1,160               | ≈ 490 MiB     |

MiB throughout. Every run imported the right triangle count, passed the geometry
gate, and replaced cleanly with a small model afterwards.

Read time, indicative: at 293.7 MiB whole 4.0–5.3 s, stream 3.9–4.4 s; at
442.7 MiB whole 15.9–16.5 s, stream 8.8–12.5 s. **The second pass does not cost
net time at these sizes**: it is paid for by not concatenating, not decoding one
huge string, and far less garbage-collector pressure.

### Other shapes, worker-side

| Case                                                          | Entry     | Whole         | Stream    | Note                                          |
| ------------------------------------------------------------- | --------- | ------------- | --------- | --------------------------------------------- |
| `dense-cjk:250` — dense, ONE object named `模型`              | 248.0 MiB | 1,559 / 1,558 | 596 / 643 | the name makes the decoded string two-byte    |
| `dense-cjk:300`                                               | 293.7 MiB | 1,842 / 1,842 | 724 / 691 |                                               |
| `text:300` — comments, metadata, vendor elements; 4 triangles | 300.0 MiB | 2,197 / 2,197 | 730 / 720 | 184 MiB archive; two-byte text                |
| `objects` — 4,000 objects × 150 triangles                     | 98.6 MiB  | 477 / 477     | 292 / 301 |                                               |
| `placements` — 1 object × 4,000 items                         | 8.6 MiB   | 80 / 79       | 86 / 86   | both refused identically by the document gate |

**The whole-buffer cost is not a function of size alone.** A single character
above U+00FF anywhere in a model part makes V8 store the decoded part at two
bytes per character, so one CJK object name adds ~0.5 GiB at 248 MiB. The
streamed path never holds the part as one string and is indifferent to it.

`placements` is refused as `RESOURCE_LIMIT_EXCEEDED` (20,050,000 placed
triangles) by both paths with the same message; the expansion walk is shared,
so this is expected and is what parity requires.

### Slice size — `dense:300`, stream, two runs each

| Input slice | Peak      | Pieces (pass 2) | Read      |
| ----------- | --------- | --------------- | --------- |
| 16 KiB      | 746 / 781 | 5,447           | 4.0–4.2 s |
| 64 KiB      | 694 – 722 | 4,855           | 3.9–4.4 s |
| 256 KiB     | 737 / 712 | 4,733           | 3.9 s     |
| 1 MiB       | 698 / 800 | 4,711           | 4.0–4.1 s |

Immaterial. Chromium emits decompressor output in chunks of at most 64 KiB
whatever the input slice, so the scanner's largest piece is at most 65,536
characters in every run; what the slice bounds is only the decompressor's queue. **64 KiB is
kept.** Largest tag held: 129 characters (dense), 740 (text). Largest terminator
carry: 2 characters.

### Cancellation — `dense:300`, stream, two runs each

| Cancelled at       | Where           | Peak      | Cancel tail | Worker heap after |
| ------------------ | --------------- | --------- | ----------- | ----------------- |
| 10% (59 MiB read)  | pass 1          | 71 / 72   | 0 / 2 ms    | 1 MiB             |
| 50% (294 MiB read) | end of pass 1   | 114 / 117 | 0 / 0 ms    | 1 MiB             |
| 75% (441 MiB read) | pass 2, parsing | 376 / 465 | 1 / 1 ms    | 1 MiB             |
| 90% (529 MiB read) | pass 2, parsing | 483 / 509 | 1 / 1 ms    | 1 MiB             |

Fractions are of the 2 × entry bytes both passes read. The first series measured
0–28 ms tails at every size up to 442.7 MiB. In every case a small replacement
model then imported normally.

### Retention after the import — and a shipped-path finding (6E-F2)

> **Superseded by Stage 6E-A2 (finding R1): FIXED**, by detaching the one string
> the document keeps and releasing the engine's match state, rather than by
> copying every tag. In the product the geometry worker now holds 1 MiB after a
> replacement import where it held 127–250 MiB. See the A2 section.

After a forced collection the streamed path's worker heap equals the canonical
geometry (189 MiB at 293.7 MiB). The whole path's is **geometry plus about one
entry** (483 MiB), and a 4-triangle `text:300` import keeps **300 MiB**.

The cause is in V8, not in the document. A heap snapshot traced the retained
string to the native context's **RegExp last-match info**: the last successful
`ATTRIBUTE.exec(source)` in `xml-scan.ts` matched a tag that is a _sliced
string_ of the decoded model part, and a sliced string keeps its whole parent
alive. The document holds none of it — dropping the import result releases
nothing — and one successful, unrelated regex anywhere in the worker releases
all of it (64.0 MiB → 0.9 MiB in the Node reproduction).

**This affects v0.2.0.** The geometry worker holds the last imported 3MF's
decoded model part — up to 256 MiB, or twice that if it contains any character
above U+00FF — until some regex next succeeds in that worker. It is bounded (one
string, replaced on the next import), not a growing leak, but it sits under the
resident document for the rest of the session. Stage 6D-R3 read its settled
~1 GiB as "the allocator not returning pages rather than anything the reader
holds"; part of it is this string. The streamed path cannot retain more than one
64 KiB piece this way. **A1 does not change the shipped reader**; the fix is
small and belongs in a stage that is allowed to.

### The product path, on the same bytes

`qualify:import-phases` against `npm run preview`, through the real file
chooser — page, render upload and automatic analysis included. Files written by
`--emit` outside the repository. v0.2.0 admits both, because both are under
256 MiB.

| File                        | Renderer peak     | Whole browser | Outcome                   |
| --------------------------- | ----------------- | ------------- | ------------------------- |
| `dense:128` (125.7 MiB)     | 758 / 758         | 943 / 943     | imported, analysis report |
| `dense:250` (248.0 MiB)     | 1,372 / 1,361     | 1,602 / 1,592 | imported, analysis report |
| `dense-cjk:250` (248.0 MiB) | **1,671 / 1,701** | 1,902 / 1,932 | imported, analysis report |

B3 measured 1,742–1,815 MiB at 248 MiB before Stage 6D-R3; today's Latin-1
figure is lower. **The CJK figure is above the 1,536 MiB working budget B3
adopted, on a file v0.2.0 already accepts** — recorded, not acted on here.

The product adds **≈ 270–360 MiB** to the worker-side whole figure at 248 MiB
(1,361–1,372 against 1,010–1,091): the application itself, the render snapshot
on the page and its upload. Scaled by triangle count to 293.7 MiB that is
≈ 320–430 MiB, which puts a **streamed 293.7 MiB import through the product at
an estimated ≈ 1.0–1.15 GiB** — below what v0.2.0 already reaches at 248 MiB
(1.36 GiB, and 1.7 GiB with one CJK name). The estimate is conservative in one
known respect: the worker-side figure already counts the render expansion, which
the product transfers to the page rather than copying.

**It is an estimate, not a measurement.** The product cannot stream today, and
nothing in A1 wires it in. 6E-A3 must measure it.

### What the numbers support

- The streamed read at the BETA-002 class (293.7 MiB) peaks at **691–724 MiB**
  worker-side across six runs, Latin-1 or not, against **1,105–1,150** whole
  (1,842 with a CJK name). The margin is ~400 MiB and repeatable.
- The product-path estimate for that class sits below the product's own peak at
  today's ceiling.
- Streaming removes the whole-path dependence on character repertoire, and the
  retained-string effect, by construction.
- It does **not** remove the geometry scratch (≈ 0.5× entry, unchanged), the
  canonical geometry, or the render expansion, which are now most of the peak.
  Past ~450 MiB those dominate, and nothing here says where a ceiling should go.

## Stage 6E-A2 — production streaming ingestion, behind a non-default seam

A2 turned the A1 prototype into production code, put it behind a seam the
product does not use, drove it through the real worker and document pipeline,
and dealt with the three memory findings A1 made about the reader v0.2.0 ships.
**The product still reads every 3MF buffered, under the unchanged 256 MiB
per-entry ceiling**; no file became eligible that was not eligible before.

### What changed in the architecture

| Concern                   | A1 prototype                                                                              | A2 production                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Selecting streaming       | `ingestion: StreamingIngestion` — an injected inflater, decoder factory, stats, callbacks | `ingestion: 'buffered' \| 'streaming'`, default buffered; platform primitives arrive through `FormatReadContext` as all others do |
| Streaming UTF-8 decoder   | injected per call                                                                         | `FormatReadContext.createTextDecoder`, supplied by the worker; a streamed read without one is a wiring fault (`INTERNAL_ERROR`)   |
| Instrumentation           | on the production option                                                                  | only on `read3mfForQualification`, which the package index does not export                                                        |
| Inflater                  | a test-only sliced shape beside a one-write production one                                | ONE `createSlicedInflater` for the import worker, the export worker and the tests; 64 KiB input slices                            |
| Two passes                | `openBytes(pass)` and a `charge` flag                                                     | `openTwoPassEntry`: charges pass 1 only, and refuses to open pass 2 before pass 1 reached its verified end                        |
| Security before semantics | handlers passed in, unused until pass 2                                                   | handlers **created** only after the verdict, through a factory; a refused part never instantiates a parser                        |
| Security rules            | a stream class beside the regular-expression function                                     | ONE state machine for both modes; the v0.2.0 expressions became the test oracle                                                   |
| Worker                    | not reached at all                                                                        | `createModelImportHandler(config)`; the product registers `PRODUCTION_IMPORT_CONFIG`, only the harness builds another             |
| Tag limit                 | a 1 MiB literal                                                                           | `16 × maxAttributeLength`, named as a new streaming-only resource policy                                                          |

### The seam, and why it is not a switch

`createModelImportHandler({ threeMfReader? })` is a construction seam in the
pattern `PRODUCTION_COMMIT_WORK` established. The shipped worker registers
`modelImportHandler`, built once from `PRODUCTION_IMPORT_CONFIG =
Object.freeze({})`, which overrides nothing, so every 3MF is read by the
registry's buffered `threeMfReader`. The end-to-end harness builds its own
handler from the same factory with a reader from `createThreeMfReader({
ingestion, zipLimits })`, selected by a harness-only `harness/ingestion` message
the shipped worker has no listener for. There is no flag, query parameter,
setting or storage key, and boundary tests assert each half of that.

**Relaxed limits live only there too.** The 293.7 MiB previews below need a
wider per-entry ceiling; it is an argument to `createThreeMfReader` in the
harness worker, and a boundary test forbids `zipLimits`, `maxEntryBytes`,
`ThreeMfIngestion` and `createThreeMfReader` anywhere under `apps/web/src`. A
browser test proves the SHIPPED application still refuses an entry declared past
256 MiB, and a harness test proves the streamed reader under production limits
refuses it too.

### Two passes: kept

A2 re-examined the second inflate-and-decode and kept it. One pass could only
either act on elements before the security verdict — weaker than the buffered
reader, which refuses a document with a late `<!ENTITY` before interpreting any
element — or buffer events until the end, which is the memory streaming exists
not to spend. The cost is measured: on dense geometry the security pass is
**~8% of the streamed read** (360 ms of 4,276 at 293.7 MiB; 431 of 5,732 at
376.1 MiB); on text-heavy XML, where the element pass has almost nothing to
build, the two passes cost about the same (1,283 + 1,324 ms). The whole streamed
read is no slower than the buffered one at these sizes.

**Why pass 2 is not charged, as a proof rather than a convention.** The archive
bytes are the transferred file and nothing writes them; raw DEFLATE is
deterministic; pass 1 charged the bytes it actually produced, chunk by chunk;
pass 2 is still held to the per-entry ceiling, the ratio, overrun and an
exact-size end, so a different stream would be refused rather than silently
larger; and nothing resets or credits the budget. `openTwoPassEntry` is the only
place that choice is made, and a boundary test pins both calls. The
package-budget boundary is tested at exactly the limit and one byte under it, in
both modes.

### Resource ownership

Every exit releases every stream. `createSlicedInflater` cancels its reader,
aborts its writer and releases both locks on an early return or a throw, and a
recorded pump failure is resurfaced rather than a short stream reported as
complete; the ZIP iterators forward `return()`, which `for await` calls on a
refusal, a cancellation or an internal throw. Unit tests exercise break and
throw against a recording decompressor. `InflatedEntryChunks` holds one step at
a time — there is no array of pending chunks — and
`scripts/inflate-backpressure.test.ts` measures the queue on a real
`DecompressionStream` with the consumer paused: one write queues the whole entry
behind the reader, 64 KiB slices queue a few slices' worth.

### XML stream hardening

The scanner's modes are an exhaustive union with no `default`; every retained
tail has a stated bound (a tag ≤ `maxTagLength`, classification ≤ 7 characters,
a terminator carry ≤ 2); the terminator search no longer concatenates a piece
onto its carry; cancellation is polled after every piece in both passes, with a
yield every 16. The security scan runs **no regular expression**: DOCTYPE and
ENTITY are `LiteralMatcher`s whose single integer of state suffices because `<`
occurs only first in either literal, and `<!` is found by native `indexOf`; the
external-identifier rule is an explicit automaton over `isEcmaWhitespace`, which
a test compares with `/\s/` for all 65,536 code units. The three v0.2.0
expressions live in `xml-stream.test.ts` as the oracle for 4,000 random
documents and every split of every marker.

`maxTagLength` could not be derived from the existing limits — XML bounds no
attribute count, and 3MF's `anyAttribute` points admit any number — so it is
stated in the unit that IS bounded: sixteen `maxAttributeLength` values. A tag
past it is `XML_TAG_TOO_LONG`, a resource refusal whose message names the limit,
and it is the one refusal the streamed path can raise that the buffered path
cannot.

### Namespaces

Resolving prefixes from `<model>` alone is the existing, qualified behaviour,
identical in both modes because both feed one `createModelXmlParser` — and it is
what 3MF Core defines. Its glossary reads **"XML namespace. A namespace declared
on the \<model\> element"**; §2.1 says extensions are used "by declaring the
matching XML namespace in the \<model\> element"; `requiredextensions` holds
prefixes, and vendor metadata names "MUST be prefixed with a valid XML namespace
name declared on the \<model\> element". A supported, valid 3MF therefore does
not need per-element scoping to interpret its geometry, so A2 did not reopen it.
The residual risk is a non-conformant file that declares or re-binds a prefix on
a nested element; the corpus below counts how often that occurs.

### The three memory findings

**R1 — the decoded model part outlived the import. FIXED.** A V8 heap snapshot
found two routes keeping a _sliced_ string of the part reachable, and V8 keeps a
slice's parent alive: the engine's regular-expression last-match state (the
subject of the last successful match — an attribute list — until any other match
succeeds in the realm), and any kept object name of 13 or more characters. In
the shipped application, after replacing a 3MF with a 19-triangle STL, the
geometry worker still held **127 MiB** (125.7 MiB entry), **249 MiB** (248 MiB)
and **250 MiB** (text-heavy 250 MiB) after a forced collection. Both routes are
closed where they open — `detachedCopy` on the stored name, `forgetRegExpMatch`
after every buffered part and in a `finally` around every read — and afterwards
the same measurement reads **1 MiB in every case**.
`scripts/xml-retention.test.ts` measures the heap in both modes, with the
document held and dropped and after a refusal, and fails with 24–46 MiB retained
if either half is removed.

**R2 — one character above U+00FF makes the decoded part two-byte. RESOLVED BY
THE STREAMED PATH, NOT THE BUFFERED ONE.** The buffered path must hold the part
as one string, so it cannot avoid V8's two-byte representation; no Unicode was
rejected or normalised to dodge it. Streamed, the part is never one string: a
CJK-named 293.7 MiB entry peaks at **799–803 MiB** worker-side against
**1,592–1,603 MiB** buffered.

**R3 — one write of the whole compressed entry. FIXED.** Worker-side, same
reader code, one-write inflater against the sliced one:

| Case (worker-side)  | One write     | Sliced        |
| ------------------- | ------------- | ------------- |
| dense 125.7 MiB     | 515 / 516     | 515 / 515     |
| dense 248.0 MiB     | 997 / 1,018   | 953 / 985     |
| dense 293.7 MiB     | 1,101 / 1,129 | 1,097 / 1,101 |
| dense 376.1 MiB     | 1,365 / 1,416 | 1,360 / 1,363 |
| CJK-named 248.0 MiB | 1,559 / 1,559 | 1,339 / 1,355 |
| CJK-named 293.7 MiB | 1,842 / 1,842 | 1,592 / 1,603 |
| text-heavy 300 MiB  | 2,197 / 2,197 | 1,780 / 1,799 |

MiB of renderer `phys_footprint_peak`, two runs each. The buffered reader's
output bytes, refusals, budget accounting and bomb refusals are identical
through either inflater (`inflate.test.ts`, 6E-W).

### The trade-off, stated plainly

Full product, `qualify:import-phases` against production builds on the 8 GiB
host, v0.2.0 against A2 as committed, interleaved, each import followed by a
19-triangle STL:

| Case                             | v0.2.0 peak                   | A2 peak                    | Worker heap after replacement + GC |
| -------------------------------- | ----------------------------- | -------------------------- | ---------------------------------- |
| dense 125.7 MiB                  | 733 / 756 / 758 / 762         | 570 / 571                  | 127 → **1** MiB                    |
| dense 248.0 MiB                  | 1,384 / 1,394 / 1,396 / 1,410 | 1,375 / 1,484              | 249 → **1**                        |
| CJK-named 248.0 MiB              | 1,598 / 1,601 / 1,612 / 1,660 | 1,630 / 1,635              | 249 → **1**                        |
| text-heavy 250 MiB               | 1,874 × 4                     | 1,545 / 1,545              | 250 → **1**                        |
| **package, 2 × 1.2 M triangles** | 1,171 – 1,388 (13 runs)       | **1,539 – 1,641 (5 runs)** | 214–324 → **1**                    |

The worst case across the set falls from 1,874 to 1,635 MiB and nothing is left
behind after an import — but **the two-part package peaks about 300 MiB
higher**. That is a real regression on the shape Stage 6D-A4 named as the one to
re-measure, and it is recorded here rather than hidden.

The bisect, each variant served and measured interleaved with v0.2.0:

| Variant                                    | Package peak  |
| ------------------------------------------ | ------------- |
| v0.2.0, and A1 as committed                | 1,171 – 1,388 |
| both A2 memory changes reverted            | 1,305 – 1,365 |
| only the retention fix, copying every tag  | 1,605 – 1,710 |
| only the retention fix, as committed       | 1,600 – 1,644 |
| only the sliced inflater                   | 1,610 – 1,708 |
| both, as committed                         | 1,539 – 1,641 |
| both, plus off-heap buffers detached early | 1,539 – 1,575 |

**Any** change that makes the import waste less moves this shape's peak up, and
the worker-level harness — the same reader without the page — does not reproduce
it at all (1,070–1,098 against 1,087–1,090 for the one-write inflater). A
peak-footprint timeline places the step at the automatic analysis that follows
the import: the last model part's on-heap garbage is still uncollected when the
analysis allocates its workspace. v0.2.0 was collected earlier _because_ it
wasted more — Stage 6D-A4 had already recorded this shape swinging between 1,285
and 1,730 MiB for a single build — and no deterministic release available to
JavaScript changed it (the last row detaches every inflated chunk and the entry
buffer as soon as they are dead). It is collector scheduling, not retention:
after a collection A2 holds 111 MiB where v0.2.0 holds 324.

**Why A2 ships the fixes anyway**: the retention they remove is permanent and
unconditional (a quarter of a gigabyte held for the rest of a session, on every
large 3MF), the peak they raise is one shape's and stays inside the range this
host already showed for the shipped build, and the streamed path — which the
previews below measure on the same package — does not produce that garbage at
all. Settling it is Stage 6E-A3's first obligation.

### Full-pipeline previews: buffered against streamed

The harness build, `qualify:import-phases` with `--ingestion`, on the same
fixtures and the same host; each import followed by a 19-triangle STL, two runs
each. Everything below 256 MiB runs under the PRODUCTION per-entry ceiling; the
293.7 MiB and text-heavy 300 MiB cases are given a 512 MiB ceiling **in both
modes**, through the harness reader, so the two are comparable.

| Case                                 | Buffered peak | Streamed peak     | Streamed read | Worker heap after replacement |
| ------------------------------------ | ------------- | ----------------- | ------------- | ----------------------------- |
| dense 125.7 MiB                      | 560 / 561     | 629 / 630         | 4.5 s         | 1 MiB                         |
| dense 248.0 MiB                      | 1,344 / 1,375 | **893 / 897**     | 8.5 s         | 1 MiB                         |
| **dense 293.7 MiB — BETA-002 class** | 1,497 / 1,524 | **822 / 896**     | 10.0 s        | 1 MiB                         |
| CJK-named 248.0 MiB                  | 1,598 / 1,632 | **892 / 895**     | 8.4 s         | 1 MiB                         |
| text-heavy 250 MiB                   | 1,508 / 1,545 | **341 / 344**     | 2.6 s         | 1 MiB                         |
| text-heavy 300 MiB                   | 1,826 / 1,835 | **368 / 372**     | 3.0 s         | 1 MiB                         |
| package, 2 × 1.2 M triangles         | 1,542 / 1,607 | **1,139 / 1,265** | 14.8 s        | 1 MiB                         |

Renderer `phys_footprint_peak`, MiB, through the whole product: page, worker,
render upload and the automatic analysis.

**These are exploratory numbers for A3, not a threshold.** What they establish:

- **The BETA-002 class goes through the full product at 822–896 MiB streamed**,
  against 1,497–1,524 buffered and against the ~2.1 GiB Stage 6D-B3 measured
  before any of this. That is comfortably inside the 1,536 MiB working budget,
  with the render upload and the automatic analysis included.
- **Streaming cures the package regression this stage introduced**: 1,139–1,265
  against v0.2.0's 1,171–1,388 and A2 buffered's 1,539–1,641. The garbage whose
  collection the buffered fixes disturbed is garbage the streamed path never
  creates.
- **Text-heavy XML is where it pays most** — 341 MiB for a 250 MiB entry that
  the buffered path reads at 1,508 — because the streamed path never holds the
  decoded part, and never at two bytes a character.
- **Small entries pay a little**: 125.7 MiB costs ~70 MiB MORE streamed. Two
  passes over a part the buffered path could hold comfortably is not free, which
  is an argument for A3's routing threshold rather than for streaming
  everything.
- Nothing is retained afterwards in either mode: 1 MiB of worker heap after the
  replacement import, everywhere, which is the R1 fix holding in the product.

### Corpus differential: every file, both ways

`npm run qualify:streaming-corpus` reads each file twice — buffered, then
streamed — and compares a SHA-256 over the unit, every part's name, material
reference, mesh sharing and transform, every distinct mesh's position and index
bytes, and the encoding, warnings and compatibility report; or, for a refusal,
its category, code, message and every structured detail but the two
chunk-granular ones. The tree is fetched to scratch at the commits Stage 6D-A4
recorded and deleted afterwards; the repository stays dataless.

| Source                                    | Files     | Imported |
| ----------------------------------------- | --------- | -------- |
| Real producers (Prusa, Bambu, Orca, Cura) | 113       | 113      |
| 3MF Consortium `test_suites`              | 2,271     | 403      |
| 3MF Consortium `3mf-samples`              | 80        | 70       |
| 3MF Consortium lib3mf `Tests/TestFiles`   | 96        | 68       |
| **Total**                                 | **2,560** | **654**  |

**2,560 of 2,560 identical, 0 different, 0 untyped errors in either mode.** The
1,906 refusals — 1,859 of them `THREEMF_UNSUPPORTED_EXTENSION`, the rest spread
over fifteen other codes including `XML_DOCTYPE_REFUSED`,
`THREEMF_AMBIGUOUS_ROOT_MODEL_PART`, `ZIP_ENTRY_TOO_LARGE` and
`THREEMF_NON_ROOT_MODEL_PART_PATH` — are the same refusals, field for field,
whichever way the bytes arrived.

Two facts this run exists to record, beyond parity:

- **The longest tag in 2,560 files is 2,517 characters** (a PrusaSlicer
  round-trip fixture's metadata element). `maxTagLength` is 1,048,576 — four
  hundred times that. The next largest is 629.
- **Not one namespace declaration appears below `<model>`** in any model part of
  any of these files. Resolving prefixes from `<model>` alone, which is what 3MF
  Core defines and what both modes do, is what every file in this corpus needs.

### Error parity

`streaming-ingestion.test.ts` (6E-E) builds each case, reads it buffered and
streamed at 7-byte, 4 KiB and 64 KiB slices, and compares category, code,
message and every structured detail:

| Case                                       | Code, in both modes                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| malformed XML                              | `XML_MALFORMED`                                                          |
| DOCTYPE / ENTITY / external identifier     | `XML_DOCTYPE_REFUSED` / `XML_ENTITY_REFUSED` / `XML_EXTERNAL_ID_REFUSED` |
| corrupt deflate                            | `ZIP_MALFORMED_ARCHIVE` ("damaged")                                      |
| part shorter / longer than declared        | `ZIP_DECLARED_SIZE_SHORTFALL` / `ZIP_DECLARED_SIZE_OVERRUN`              |
| child part over 200:1                      | `ZIP_RATIO_EXCEEDED`                                                     |
| unknown required extension, Secure Content | `THREEMF_UNSUPPORTED_EXTENSION`                                          |
| alternatives                               | `THREEMF_MODEL_RESOLUTION_UNSUPPORTED`                                   |
| missing object in a child part             | `THREEMF_MISSING_MODEL_PART_OBJECT`                                      |
| missing child part                         | `THREEMF_MODEL_PART_NOT_FOUND`                                           |
| parts that disagree about the unit         | `THREEMF_INCONSISTENT_MODEL_PART_UNITS`                                  |
| part ceiling                               | `THREEMF_TOO_MANY_PARTS`                                                 |
| cancellation                               | `OPERATION_CANCELLED`                                                    |

Identical in every field but two, by design: `produced` and `atLeast` — the
prospective total at the chunk that crossed a ceiling — move with decompressor
chunk boundaries, as they already did between Node and Chromium. Both modes
report the key; neither mode's value is a property of the file. The one intended
difference is `XML_TAG_TOO_LONG`, above.

**Corruption is classified as it always was.** No CRC is verified, in either
mode, as in v0.2.0: early damage is a decode error ("damaged"), later damage
usually decodes to the wrong length and is a size mismatch. Every case is a
typed malformed-file refusal and is identical in both modes.

### Full-pipeline proofs in Chromium

`e2e-harness/streaming-import.spec.ts` drives the real worker, handler, store,
viewport and automatic analysis, buffered then streamed:

- **Document parity** for eleven packages — dense; a multi-part family whose
  child is placed three times under transforms with CJK names; its Zip64 form; a
  Zip64 production package; the production-extension sample; a six-part package;
  nested components; shared placements; materials; textures; a CJK-named dense
  part — compared as the worker-side digest (every part's position and index
  bytes, transforms, names, unit) AND the page's facts (format, encoding, unit,
  warnings, unsupported features, bounds, vertex counts, validation, the render
  snapshot's parts, vertices and floats, the analysis and self-intersection
  outcome). All identical.
- **Export parity**: STL, OBJ and 3MF written from a streamed import are
  byte-identical (SHA-256) to those written from a buffered import of the same
  file.
- **Late failures** — a malformed token after 150,000 triangles, a late
  `<!ENTITY`, a late alternatives element: no new document, the open one
  byte-identical, the worker usable afterwards, and for the ENTITY case the page
  never saw the element pass begin.
- **Cancellation** in the root's security pass, in its element pass, inside a
  CHILD model part, and after every part but before the commit; and at ~10%, 50%
  and 90% of a measured import. Cancelled or complete-and-whole, never partial;
  the next import lands.
- **Stale race**: a newer file chosen while an older streamed import is still
  reading wins, and stays won.
- **Eligibility**: under production limits an entry declared past 256 MiB is
  refused in both modes, and by the shipped application.

## Staging plan

- **6E-A2 — DONE.** Production-quality streamed ingestion behind a non-default
  seam; see the section above.
- **6E-A3** — the product path: enable streaming through the full-product
  qualification harness, measure page, render upload and diagnostics, compare
  routing strategies, and settle the buffered peak regression A2 recorded.
- **6E-A4** — choose a large-entry ceiling from A3's evidence, as its own
  decision.
- **6E-A5** — release qualification.

Until A4 decides otherwise, **the production limit is unchanged — 256 MiB.**

## Reproduction

```bash
npx vitest run packages/file-formats/src/threemf/xml-stream.test.ts \
  packages/file-formats/src/threemf/streaming-ingestion.test.ts \
  packages/file-formats/src/mutation-campaign.test.ts
npm run qualify:streaming-import -- --cases dense:300 --modes whole,stream --runs 2
npm run qualify:streaming-import -- --cases dense:300 --modes stream --cancel 0.1,0.5,0.9
npm run qualify:streaming-import -- --cases dense-cjk:250,text:300,objects,placements
npm run qualify:streaming-import -- --cases dense:250 --emit /abs/dir/outside/repo

# Stage 6E-A2: the same reader through the whole product, buffered or streamed.
npm run build:harness --workspace @cadfixer/web
npm run preview:harness --workspace @cadfixer/web      # :4175, in another terminal
CADFIXER_QUALIFY_URL=http://localhost:4175/ npm run qualify:import-phases -- \
  file:1646975:/abs/dense-300.3mf --ingestion=streaming --max-entry-mib=512 --worker-heap

# Buffered against streamed over a real corpus, fetched outside the repository.
CADFIXER_CORPUS=<dir> CADFIXER_CORPUS_REPORT=<file.jsonl> npm run qualify:streaming-corpus

npx playwright test -c playwright.harness.config.ts e2e-harness/streaming-import.spec.ts
```
