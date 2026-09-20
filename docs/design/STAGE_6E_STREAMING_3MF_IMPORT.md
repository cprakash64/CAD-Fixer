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

## Stage 6E-A3 — automatic per-entry routing

A2 qualified a streamed reader and shipped it switched off, because the two
paths are **not ordered**: streaming is dramatically cheaper for a large model
part and slightly more expensive for a small one. A3's job was to find where
they cross, route each entry automatically, and settle the buffered-memory
trade-off A2 recorded.

**A3 changed no ceiling.** `maxEntryBytes` is still 256 MiB, the package
expansion ceiling is still 512 MiB, the ratio is still 200:1, and the geometry,
topology and boundary-inventory gates are untouched. Routing decides **how** an
eligible entry is read, never **whether** it may be.

### Host and method

Apple M1, 8 GiB, macOS 26A5421a, Node 22.22.2, Playwright 1.62.1, Chromium
151.0.7922.34. Renderer `phys_footprint_peak` from macOS `footprint(1)`, read at
phase boundaries by `qualify:import-phases` driving the real file chooser
against a production build; whole-browser peak summed across processes; the
geometry worker's isolate heap read over CDP after two forced collections. **One
browser per measurement**, because `phys_footprint_peak` is a process-lifetime
maximum.

**Modes are interleaved PER CASE, and the order alternates.** A first attempt
ran all of one mode and then all of the other, and the host's load climbed
monotonically through the sequence — so the second mode was systematically
measured on a busier machine. That run was discarded rather than reported. The
driver now runs a case's two modes back to back with an eight-second cooldown
and alternates which goes first.

**THE HOST WAS NOT QUIET, AND THAT IS STATED RATHER THAN HIDDEN.** A macOS
software update was staging for part of the session (`UpdateBrainService` at up
to 146% CPU) and iCloud Drive was syncing throughout (`fileproviderd` at
60–92%); one-minute load averages during the ladders ranged from 4 to 34, and
swap was in use. Three consequences, each handled:

- **Peak footprint is the robust signal and timing is not.** A process's
  high-water allocation is set by what the code allocates; elapsed time is set
  by what else is running. Every memory figure below is a median of three fresh
  browsers with the min and max quoted beside it; every timing figure is
  reported as an indication and no decision rests on one.
- **The decision needs the SIGN and the MARGIN, not a precise crossover.** The
  differences that decide the threshold are 200–1,200 MiB, one to two orders of
  magnitude above the run-to-run spread, and they reproduce in the same
  direction across all three rounds.
- **The 126 MiB dense result has now been measured three times on three
  different days** — A2's preview, the discarded run and this one — and lands in
  the same place each time, which is what makes it safe to treat the narrow band
  where buffering wins as real rather than as noise.

### Threshold ladder — dense geometry

One object of unshared triangles: the Stage 6D-B3 shape, and the most expensive
one the product supports. Renderer `phys_footprint_peak`, MiB, min / median /
max of three runs; **delta is buffered minus streamed, so positive means
streaming is cheaper**.

| Model entry | Buffered          | Streamed         | Delta | Import ms, buf / str |
| ----------- | ----------------- | ---------------- | ----: | -------------------- |
| 63.21 MiB   | 519 / 519 / 520   | 426 / 427 / 428  |   +92 | 2,524 / 2,455        |
| 95.51 MiB   | 670 / 670 / 672   | 563 / 563 / 563  |  +107 | 3,380 / 3,875        |
| 125.74 MiB  | 561 / 568 / 572   | 650 / 669 / 723  |  −101 | 5,159 / 4,534        |
| 133.86 MiB  | 579 / 579 / 580   | 663 / 667 / 699  |   −88 | 4,679 / 4,870        |
| 137.66 MiB  | 598 / 599 / 600   | 616 / 669 / 670  |   −70 | 4,650 / 4,927        |
| 141.63 MiB  | 865 / 1,024/1,026 | 732 / 732 / 759  |  +292 | 5,023 / 5,304        |
| 150.00 MiB  | 878 / 880 / 1,036 | 667 / 685 / 686  |  +195 | 5,205 / 5,239        |
| 157.52 MiB  | 906 / 907 / 1,073 | 748 / 802 / 820  |  +105 | 6,722 / 5,497        |
| 170.67 MiB  | 954 /1,116/1,116  | 748 / 749 / 793  |  +367 | 6,080 / 6,095        |
| 186.39 MiB  | 766 / 767 / 1,032 | 647 / 738 / 742  |   +29 | 6,473 / 6,583        |
| 202.28 MiB  | 803 /1,095/1,096  | 688 / 691 / 926  |  +404 | 7,509 / 7,940        |
| 218.18 MiB  | 1,413/1,421/1,425 | 839 / 845 / 882  |  +576 | 7,991 / 7,771        |
| 234.07 MiB  | 1,295/1,296/1,330 | 853 / 873 / 979  |  +423 | 8,663 / 8,074        |
| 242.01 MiB  | 1,319/1,320/1,356 | 870 / 870 /1,040 |  +450 | 10,503 / 8,688       |

**THE STREAMED PATH IS FLAT AND THE BUFFERED PATH IS NOT.** Streamed peaks stay
between 427 and 873 MiB across a four-fold range of entry sizes; buffered peaks
climb to 1,421.

**THE CROSSOVER IS BETWEEN 137.66 MiB AND 141.63 MiB, AND THE STEP IS SHARP.**
Buffered moves from 599 MiB to 1,024 MiB across four megabytes of input while
streamed does not move at all. Below the step there is a narrow band — 126 to
138 MiB — where buffering genuinely wins, by 70 to 101 MiB. Below THAT, at 63
and 95 MiB, streaming wins again.

### Threshold ladder — text-heavy XML

Hundreds of megabytes of comments, metadata and vendor elements around one
tetrahedron: a document that is almost entirely not geometry. Two runs each.

| Model entry | Buffered          | Streamed        |  Delta | Import ms, buf / str |
| ----------- | ----------------- | --------------- | -----: | -------------------- |
| 64.00 MiB   | 492 / 503 / 503   | 261 / 263 / 263 |   +240 | 880 / 853            |
| 96.00 MiB   | 661 / 695 / 695   | 259 / 265 / 265 |   +430 | 856 / 1,506          |
| 128.00 MiB  | 862 / 915 / 915   | 270 / 273 / 273 |   +642 | 1,545 / 1,463        |
| 160.00 MiB  | 1,045/1,050/1,050 | 282 / 285 / 285 |   +765 | 1,526 / 1,884        |
| 192.00 MiB  | 1,185/1,220/1,220 | 302 / 302 / 302 |   +918 | 1,979 / 2,356        |
| 224.00 MiB  | 1,391/1,409/1,409 | 325 / 332 / 332 | +1,077 | 1,953 / 2,448        |
| 248.00 MiB  | 1,533/1,543/1,543 | 337 / 341 / 341 | +1,202 | 4,584 / 2,927        |

**THERE IS NO CROSSOVER HERE.** Streaming wins at every supported size, from
64 MiB upwards, and the streamed peak barely moves — 263 to 341 MiB for a
four-fold range of input — because the part is never decoded into a string at
all. **Buffered reaches 1,543 MiB at 248 MiB, which is the 1,536 MiB working
budget.** This is the shape the threshold has to protect, not dense geometry.

### Threshold ladder — one character above U+00FF

The dense fixtures again, identical but for a single object name, `模型`. V8
stores a string with any character above U+00FF at two bytes a character, so one
name decides whether the buffered path's decoded part costs 1× or 2×. Two runs
each.

| Model entry | Buffered          | Streamed        | Delta | Import ms, buf / str |
| ----------- | ----------------- | --------------- | ----: | -------------------- |
| 125.74 MiB  | 907 / 908 / 908   | 631 / 631 / 631 |  +277 | 5,104 / 4,720        |
| 157.52 MiB  | 1,087/1,089/1,089 | 777 / 795 / 795 |  +294 | 5,929 / 6,427        |
| 186.39 MiB  | 1,218/1,273/1,273 | 634 / 797 / 797 |  +476 | 8,012 / 6,958        |
| 218.18 MiB  | 1,665/1,673/1,673 | 846 / 846 / 846 |  +827 | 8,653 / 8,220        |
| 242.01 MiB  | 1,787/1,812/1,812 | 895 / 949 / 949 |  +863 | 9,174 / 8,273        |

**ONE CJK CHARACTER FLIPS THE 126 MiB VERDICT.** The same bytes of geometry that
buffer at 568 MiB with an ASCII name buffer at 908 MiB with a CJK one, and the
streamed figure barely changes (669 → 631). At 242 MiB the buffered path reaches
**1,812 MiB — past the working budget** — for a file that is entirely legitimate.

**NO UNICODE RULE WAS ADDED, AND NONE IS NEEDED.** Routing on content would mean
deciding after decompression, which is the one thing the decision must precede.
The size threshold already covers it: under 128 MiB the worst CJK case measured
buffers at 908 MiB, inside the envelope, and everything above it streams.

### Selected threshold — 128 MiB

`THREEMF_STREAMING_THRESHOLD_BYTES = 128 * 1024 * 1024` (134,217,728 bytes), in
`packages/file-formats/src/threemf/ingestion-route.ts`, the leaf module that also
owns the mode names and the decision. One literal; nothing restates it.

**THE ERRORS ARE NOT SYMMETRIC, AND THAT IS THE WHOLE ARGUMENT.** Streaming a
little too early costs at most the 101 MiB measured at 126 MiB, and it is
bounded, because the streamed peak hardly moves with size. Buffering a little
too late costs 292 MiB at 142 MiB for dense geometry, 642 MiB at 128 MiB for
text-heavy XML, and grows without limit thereafter. The margin therefore goes on
the streaming side.

128 MiB sits about ten megabytes BELOW the sharp buffered step, so **no
supported input depends on buffered behaviour anywhere near it**. Under this
threshold the worst buffered peak any eligible file can reach is about 915 MiB —
text-heavy XML just under the line — against 1,812 MiB with no routing at all.

**IT IS NOT LOWER, EVEN THOUGH STREAMING ALSO WINS AT 63 AND 95 MiB**, for two
reasons that are not about peak memory. Buffered is v0.2.0's path, qualified in
Stage 6D-A4 against 2,130 real and reference files and shipped to users; real
producer output is a few megabytes, so a threshold here leaves essentially every
file anyone actually opens on the proven path. And a second pass is real work —
within run-to-run noise on this host, but never free, and there is nothing to
buy with it below the line, because a buffered import under 128 MiB has never
been near the envelope.

### Real-producer impact

From the committed Stage 6D-A4 manifest,
[`docs/beta/A4_REAL_PRODUCER_CORPUS.tsv`](../beta/A4_REAL_PRODUCER_CORPUS.tsv) —
113 real producer-authored 3MF files that import, from PrusaSlicer, Bambu
Studio, OrcaSlicer and Cura. The manifest records archive bytes and triangles
rather than entry sizes, so the entry is bounded from the triangle count at
72–190 bytes per triangle (welded indexed geometry to unshared soup, the two
ends the generators span):

| Percentile | Triangles | Largest model entry, estimated |
| ---------- | --------: | ------------------------------ |
| median     |     7,126 | 0.49 – 1.29 MiB                |
| p90        |    20,806 | 1.43 – 3.77 MiB                |
| p95        |    55,668 | 3.82 – 10.09 MiB               |
| p99        |   225,154 | 15.46 – 40.80 MiB              |
| max        |   256,568 | 17.62 – 46.49 MiB              |

Archive sizes: median 0.06 MiB, p95 0.93 MiB, max 3.02 MiB.

**AT 128 MiB, ZERO OF THE 113 WOULD STREAM — at either end of the estimate.**

### Corpus differential: every file, three ways

The estimate above is corroborated by measurement. `qualify:streaming-corpus`
gained a THIRD read — `auto`, the shipped configuration — beside the buffered
and streamed ones A2 added, and records every routing decision it makes. The
tree was fetched to scratch at the Stage 6D-A4 commits and deleted afterwards;
the repository stays dataless.

| Source                    | Commit         | 3MF files |
| ------------------------- | -------------- | --------: |
| 3MFConsortium/test_suites | `f483d3beee06` |     2,351 |
| 3MFConsortium/3mf-samples | `665e20dc4d77` |        80 |
| 3MFConsortium/lib3mf      | `bfb5df00057f` |        98 |
| prusa3d/PrusaSlicer       | `6f510128d7c2` |         8 |
| bambulab/BambuStudio      | `77b9dd94d1e3` |         6 |
| SoftFever/OrcaSlicer      | `db91d4b63046` |        11 |
| **Total**                 |                | **2,474** |

**2,474 files — 567 imported, 1,907 refused, 2,474 IDENTICAL, 0 DIFFERENT.**
Every file produces the same document digest or the same typed refusal, field
for field, whether it was read buffered, streamed, or routed. The refusals are
dominated by `THREEMF_UNSUPPORTED_EXTENSION` (1,860) — the conformance suites
exercise extensions CAD Fixer does not implement — and no mode produced an
untyped error.

**THE ROUTE CENSUS: 2,534 model entries opened, 2,534 BUFFERED, 0 STREAMED.**
The largest model entry in the whole corpus is **55,581,229 bytes — 53.01 MiB**,
less than half the threshold.

That is the intended outcome and not an argument for lowering the threshold:
routing exists for the large files A4 will decide about, and for the tail of
legitimate user models between 128 MiB and the ceiling, not for slicer output.
**It is also why auto routing expands no user-facing capability whatsoever** —
for every file in the qualified corpus, the product reads exactly what v0.2.0
read, by exactly the same path.

Two of the user's own real 3MF files were read the same three ways as a spot
check: identical in all three, and one of them — a 30 MiB Hi3D package whose
model entry expands past 256 MiB — is refused as `ZIP_ENTRY_TOO_LARGE` in every
mode. That is BETA-002 met in the wild, and A3 does not change it.

### Routing granularity: the model entry

**PER ENTRY, NOT PER PACKAGE, AND THE DESIGN WAS CHECKED RATHER THAN ASSUMED.**
A production-extension package legitimately holds one large root beside several
tiny referenced parts, or the reverse; a package-wide choice would either make
the small parts pay two passes or make the large one hold a quarter of a
gibibyte. `readThreeMfPackage` therefore asks
`routeModelEntryIngestion(entry.uncompressedSize, mode)` once in `loadModelPart`
— the single place a model part's bytes are ever read — and a boundary test
asserts there is exactly one such call.

What makes mixing safe is that nothing in the package walk is per-mode:

- **One inflation budget for the archive.** A buffered entry charges its bytes
  once; a streamed one charges its SECURITY pass and not its element pass. Both
  charge the same `InflationBudget` object, so a mixed package spends the sum of
  its parts and nothing else. Proven by narrowing the package ceiling to just
  under that sum and requiring the refusal, in all three modes.
- **One part open at a time**, guaranteed by the walk awaiting each load, not by
  anything inside either path. The walk is strictly sequential and a boundary
  test still forbids `Promise.all`.
- **Package-wide counters.** Triangles, vertices, parts and component depth are
  one quantity across every reachable model part and none of them resets at a
  part boundary, whichever way a part was read.
- **Parse-once.** A child referenced several times is loaded once by
  `PackageModelGraph`, so it is routed once — which for a streamed entry is the
  difference between one full decompression of the largest thing in the archive
  and several.
- **Namespaces resolve from `<model>`**, per part, in both paths.

`3D/3dmodel.model` may buffer while `3D/Objects/big.model` streams and
`3D/Objects/small.model` buffers, in one package, in one walk, producing one
document. That is asserted directly, with the routing decisions compared against
the expected list and the resulting document compared against the buffered
oracle.

### The routing input, and what it is not trusted for

The input is the **declared uncompressed size** of the model entry, read from
the ZIP directory. It is the one figure known before a byte is decompressed,
which is what makes the decision precede every allocation that depends on it.

**IT IS ATTACKER-CONTROLLED, AND IT IS A HINT AND NOTHING ELSE.** Every safety
property is enforced by `zip.ts`, on both paths, against the same declaration:

- the per-entry ceiling (256 MiB) and the package ceiling (512 MiB), applied at
  the directory and again where the number becomes an allocation;
- the 200:1 compression ratio, applied to the DECLARATION at the directory —
  which is what bounds how far a declaration can lie upward, because a claim more
  than 200 times the compressed data is refused before an entry is opened and
  before a path is chosen;
- the overrun check, which refuses at the first chunk that would exceed the
  declaration, so the buffered allocation is bounded by the lie;
- the shortfall check at the end of the stream, which refuses an entry that ends
  before its declaration does.

The two routing attacks are tested from both directions. A declaration BELOW the
threshold steers an entry onto the buffered path and the content then tries to
be far larger: `ZIP_DECLARED_SIZE_OVERRUN`, identically in every mode. A
declaration ABOVE the threshold, to reach the streamed path: refused for the
ratio before any route is chosen, and within the ratio, refused for the
shortfall. **No mode is the one that catches a lie, which is why no mode can be
the one that misses it.**

**NOTHING ELSE MAY ENTER THE DECISION**: not available memory, heap estimates,
elapsed time, host load, the file name, the producer, the compression ratio
alone, or whether the part carries characters above U+00FF. A boundary test
holds `ingestion-route.ts` to importing nothing at all and to naming none of
those, so the same file routes the same way on every machine and a refusal stays
reproducible.

### Auto-mode invariants

- **THE PRODUCT'S ONE CHOICE IS `codec.ts`, AND IT IS ONE LINE.**
  `threeMfReader = createThreeMfReader({ ingestion: ThreeMfIngestion.Auto })`.
  Nothing under `apps/web/src` names an ingestion mode, a reader factory or a
  ZIP limit, and the shipped worker still registers exactly one import handler
  built from `PRODUCTION_IMPORT_CONFIG`. Boundary tests hold all of it.
- **`read3mf`'s OWN DEFAULT STAYS BUFFERED.** That is not an inconsistency: it
  keeps v0.2.0's path as the oracle every differential holds the other two to. A
  default of `auto` would mean the suites comparing "the reader" against "the
  streamed reader" were comparing routing against itself.
- **BOTH FORCED MODES SURVIVE, AND THEY ARE HONOURED WHATEVER THE SIZE.** The
  corpus differential, the mutation campaign and the harness suites read the
  same file every way; a `buffered` that quietly resolved to the production
  default would silently stop being a comparison. The end-to-end harness bridge
  gained `auto` for the same reason, and its `buffered` branch no longer aliases
  to the production config — the alias moved to `auto`, where it now belongs.
- **A MODE THAT MAY STREAM NEEDS A TEXT DECODER AND SAYS SO UP FRONT.** `auto`
  raises the wiring fault when it is asked for, not at whichever file happens to
  be first past the threshold. A silent fallback to buffered would undo the
  stage precisely on the entries that need it most, and say nothing.
- **ROUTING IS INVISIBLE.** No message, no warning, no setting, no user choice,
  no progress change. Two paths that produced observably different results would
  not be a routing policy; they would be two readers.
- **THE ONE OBSERVABLE DIFFERENCE IS STILL `XML_TAG_TOO_LONG`**, the refusal only
  the streamed scanner can raise (16 attribute widths, 1 MiB). Under `auto` it
  becomes size-dependent: a megabyte-long tag inside a 100 MiB entry is read,
  and the same tag in a 200 MiB entry is refused. It needs more than sixteen
  maximum-length attributes on one element, the longest tag in every producer
  file Stage 6E has measured is under 1 KiB, and the alternative — imposing the
  streamed limit on the buffered path — would be a new refusal for files the
  product accepts today. Recorded as the known consequence of routing.
- **EXPORT VALIDATION DELIBERATELY DOES NOT FOLLOW THE ROUTE.**
  `exportDocument` reads its own artifact back with `ingestion: Buffered`,
  stated explicitly rather than inherited from a default. What has to be true of
  an exported file is that it survives the production reader's ceilings and
  refusals; making the validator depend on the routing decision would mean a
  routing defect could let an invalid file validate, and making it independent
  means it cannot. It is also why the export worker needs no text decoder.
  **A consequence worth recording for A4**: validating a near-ceiling 3MF export
  still pays the buffered cost that A3 removes from import. It is bounded by
  `maxOutputBytes` (256 MiB) today and was not in A3's scope.

### Route observability

`read3mfForQualification` gained `onRoute`, which reports the entry name, the
declared size and the selected path. **It is qualification-only and it is not
telemetry**: the package index does not export `read3mfForQualification`, a
boundary test keeps it out of `apps/web/src`, `file-formats` compiles with no
DOM and no Node types, and the repository bans every network API. The entry name
is included because a mixed-mode package cannot be checked without knowing which
part is which, and it never leaves the process that read the file. The corpus
differential uses it to count how a real corpus routes; no user-visible surface
consumes it, and nothing in the product could.

### Small files and other shapes

Below the threshold everything buffers, which is the point; these confirm there
is nothing to buy by lowering the line. Three runs each, medians.

| Case                                  | Buffered | Streamed | Delta | Import ms, buf / str |
| ------------------------------------- | -------: | -------: | ----: | -------------------- |
| dense 0.98 MiB                        |      152 |      153 |    −1 | 351 / 482            |
| dense 5.01 MiB                        |      173 |      178 |    −5 | 553 / 485            |
| dense 19.43 MiB                       |      320 |      323 |    −3 | 1,225 / 1,276        |
| dense 50.04 MiB                       |      344 |      397 |   −53 | 1,984 / 2,074        |
| dense 95.51 MiB                       |      670 |      564 |  +106 | 3,392 / 3,455        |
| object-heavy 98.62 MiB, 4,000 objects |      442 |      544 |  −102 | 5,908 / 5,967        |
| placement-heavy 8.62 MiB, 4,000 items |      124 |      129 |    −5 | 274 / 249            |

**Memory is a wash below 50 MiB and time is not free.** A 1 MiB import costs
351 ms buffered and 482 ms streamed — 130 ms, but 37% — and every one of these
routes buffered under the selected threshold.

**OBJECT-HEAVY XML IS THE ONE SHAPE THAT PREFERS BUFFERING NEAR THE LINE**, by
102 MiB at 98.62 MiB, and it buffers. Its cost is dominated by the object table
and the part expansion rather than by the entry, which is why streaming buys
less here than for one large mesh.

**PLACEMENT-HEAVY IS A REFUSAL, AND IT IS THE SAME REFUSAL IN BOTH MODES**:
4,000 placements of 50,000 triangles is 20,050,000 triangles, refused by the
document's triangle ceiling, with identical wording. Routing did not reach it,
because the entry is 8.62 MiB.

### Multi-part packages

Production-extension packages with parts deliberately straddling the threshold.
Two runs each, medians; the routes are what `auto` selects at 128 MiB.

| Package                                            | Routes under `auto`                | Buffered | Streamed |
| -------------------------------------------------- | ---------------------------------- | -------: | -------: |
| M1 — tiny root, 200.8 MiB child                    | buffered + **streamed**            |      800 |      693 |
| M2 — 200.8 MiB root, 19.4 MiB child                | **streamed** + buffered            |    1,221 |      779 |
| M3 — 180.3 MiB root, 180.3 MiB child               | **streamed** + **streamed**        |    1,131 |      846 |
| M4 — 7.7 MiB root, 99.5 MiB and 200.8 MiB children | buffered + buffered + **streamed** |      971 |      631 |
| M5 — tiny root, one 200.8 MiB child placed twice   | **streamed**, loaded ONCE          |      800 |      642 |

Every package imports the same triangle count in both modes — 1,133,595;
1,246,954; 2,040,472; 1,745,735; 2,267,190 — and M5 confirms parse-once: two
placements of a 200.8 MiB child cost the same as M1's one (642 against 693
streamed, 800 against 800 buffered).

**M2 IS THE CASE A PACKAGE-WIDE DECISION WOULD GET WRONG.** Its large part is
the ROOT — the one resolved through the OPC relationship and the only one whose
`<build>` is walked — so a policy that inspected the first entry, or the
smallest, or took the root's answer and applied it to the rest, would pass M1 and
fail here. It is the widest gap in the set: 1,221 MiB buffered against 779
streamed.

**M4 IS A THREE-WAY MIX IN ONE WALK**: two buffered parts and one streamed,
against one inflation budget, one set of package counters and one part open at a
time.

### The buffered-memory trade-off — controlled A/B

A2 recorded a real concern and asked A3 to settle it: `662ed8e` removes the
permanent retention of a decoded model part, but the preview also showed one
shape — a two-part package of 1.2 M triangles each — peaking about 350 MiB
higher with it than v0.2.0 did.

**THAT COMPARISON CONFOUNDED TWO CHANGES.** v0.2.0 predates the whole of Stage
6E; comparing it with A2 as committed measures `662ed8e` AND everything else A1
and A2 landed. A3 isolated the commit instead. Two disposable worktrees at
`54cfd3c`, both built and served as production:

- **FIXED** — `54cfd3c` unmodified.
- **REVERTED** — the same source, the same streaming implementation, with ONLY
  the three functional changes of `662ed8e` undone: the kept object name keeps
  its slice of the decoded part instead of `detachedCopy`, `forgetRegExpMatch`
  becomes a no-op, and `INFLATE_INPUT_SLICE_BYTES` becomes large enough that the
  inflater writes the whole compressed entry in one call.

Neither worktree was committed and `main` was not touched. The two builds were
served on separate ports and measured with the arms **interleaved per case, in
alternating order**, three fresh browsers each. Renderer
`phys_footprint_peak`, MiB, min / median / max; the heap column is the geometry
worker's isolate heap after two forced collections, at the end of the session.

| Case                              | FIXED             | REVERTED          | Δ median | Worker heap, fixed / reverted |
| --------------------------------- | ----------------- | ----------------- | -------: | ----------------------------- |
| B1 — dense 125.74 MiB             | 567 / 568 / 573   | 749 / 755 / 756   | **−187** | **34 / 160 MiB**              |
| B2 — dense 202.28 MiB             | 798 / 1,055/1,055 | 1,057/1,058/1,076 |       −3 | **53 / 256**                  |
| B3 — dense 242.01 MiB             | 1,316/1,317/1,323 | 1,319/1,320/1,320 |       −3 | **64 / 306**                  |
| B4 — text-heavy 248.00 MiB        | 1,521/1,523/1,531 | 1,859/1,860/1,860 | **−337** | **1 / 248**                   |
| B5 — CJK-named dense 242.01 MiB   | 1,782/1,782/1,802 | 1,784/1,785/1,794 |       −3 | **63 / 306**                  |
| B6 — package, 2 × 1.2 M triangles | 1,535/1,539/1,609 | 1,565/1,588/1,605 |  **−49** | **111 / 324**                 |
| B7 — large replaced by large      | 1,316/1,317/1,317 | 1,319/1,319/1,319 |       −2 | **62 / 296**                  |

### Decision: KEEP `662ed8e`

**THE FIX IS BETTER OR EQUAL AT THE MEDIAN IN ALL SEVEN CASES**, by 187 MiB at
125.74 MiB and 337 MiB for text-heavy XML, and within the run-to-run spread
everywhere else. It is never worse.

**THE RETENTION IT REMOVES IS REAL, LARGE AND PERMANENT.** Without it the
geometry worker still holds 160 to 324 MiB after the import has finished and two
collections have run — for the rest of the session, on every large 3MF. With it,
1 to 111 MiB.

**THE REGRESSION A2 RECORDED DOES NOT REPRODUCE WHEN THE COMMIT IS ISOLATED.**
B6 is the exact shape A2 named, and here the fix is 49 MiB BETTER. A2's ~350 MiB
was a difference between v0.2.0 and A2-as-committed — two stages apart — on a
shape Stage 6D-A4 had already recorded swinging between 1,285 and 1,730 MiB for
a single unchanged build. Attributing it to this commit was the cautious
reading; measured against its own base, it is not there.

**AND ROUTING RETIRES THE QUESTION FOR THAT SHAPE ANYWAY.** B6's model parts are
about 222 MiB each, so under `auto` they stream and the buffered path — the only
path `662ed8e` changes — never runs for them at all.

No workaround was added and no collection is forced. Explicit GC is not product
behaviour, and asking for one would be treating a scheduling observation as a
defect.

### Auto mode through the shipped build

The production build as committed — `threeMfReader` registered with `auto`,
nothing forced — driven through the real file chooser by
`qualify:import-phases`. Two fresh browsers per case. The forced columns are the
harness measurements above, for comparison.

| Case                                  | `auto`, run 1 / run 2 | Forced buffered | Forced streamed | Path taken      |
| ------------------------------------- | --------------------- | --------------: | --------------: | --------------- |
| dense 95.51 MiB                       | 666 / 665             |             670 |             564 | buffered        |
| dense 125.74 MiB                      | 572 / 567             |             568 |             669 | buffered        |
| dense 242.01 MiB                      | 1,043 / 957           |           1,320 |             870 | streamed        |
| text-heavy 248.00 MiB                 | **331 / 332**         |       **1,523** |             341 | streamed        |
| CJK-named dense 242.01 MiB            | 1,016 / 883           |       **1,802** |             949 | streamed        |
| M1 — tiny root + 200.8 MiB child      | 897 / 636             |             800 |             693 | mixed           |
| M2 — 200.8 MiB root + 19.4 MiB child  | **665 / 703**         |       **1,221** |             779 | mixed           |
| M3 — 180.3 + 180.3 MiB                | 903 / 845             |           1,131 |             846 | both streamed   |
| M4 — 7.7 + 99.5 + 200.8 MiB           | 673 / 674             |             971 |             631 | three-way mixed |
| M5 — one 200.8 MiB child placed twice | 888 / 631             |             800 |             642 | streamed, once  |

**THE ROUTING IS VISIBLE IN THE NUMBERS AND NOWHERE ELSE.** Below the threshold
`auto` tracks the buffered figure to within a few megabytes (666 against 670,
572 against 568); above it, it tracks the streamed one (331 against 341 for
text-heavy, against 1,523 buffered). M2 is the clearest single case: its large
part is the ROOT, and under `auto` it costs 665–703 MiB rather than the 1,221 a
package-wide buffered choice would have cost.

**THE WORST CASE IN THE SET FALLS FROM 1,802 MiB TO 1,043 MiB**, and every
import returns the same triangle count it returned before.

**REPLACEMENT AND RETENTION.** A 242.01 MiB import followed by a two-triangle
STL peaks at 903–1,035 MiB and leaves **3 MiB** of geometry-worker heap after
two forced collections — the Stage 6E-A2 retention fix holding under routing,
and no monotonic growth across the cycle.

### What A3 did NOT change

- **No resource ceiling moved.** `maxEntryBytes` 256 MiB, package expansion
  512 MiB, ratio 200:1, `MAX_IMPORT_GEOMETRY_BYTES` 768 MiB, the topology and
  boundary-inventory gates, the hole-fill ceilings: all untouched. An entry
  declared past 256 MiB is refused in every mode, before a route is chosen, and
  the end-to-end harness asserts it in the browser.
- **BETA-002 remains unsupported.** Routing makes today's envelope cheaper; it
  does not widen it. **STREAMING IMPORT REQUIRED — ROUTING QUALIFIED,
  PRODUCTION CEILING NOT YET RAISED.**
- **The support matrix is functionally unchanged**, and deliberately: for every
  one of the 113 real producer 3MF files in the A4 corpus, `auto` reads exactly
  what v0.2.0 read, by exactly the same path.
- **No progress UI, no message, no setting.** The two-pass byte progress the
  streamed path already reports is unchanged and still internally monotonic; a
  progress surface remains a later polish task.
- **Main-thread responsiveness is unchanged, and the stall that exists is not
  the import's.** Longest gap between animation frames, shipped build against
  the pre-A3 build, same files, one fresh browser each:

  | Case                                    | A3 (`auto`) | Pre-A3 (buffered) |
  | --------------------------------------- | ----------: | ----------------: |
  | dense 125.74 MiB — 713,921 triangles    |    2,691 ms |          2,336 ms |
  | dense 242.01 MiB — 1,361,499 triangles  |    4,371 ms |          4,484 ms |
  | text-heavy 248.00 MiB — **4** triangles |      139 ms |            161 ms |
  | mixed package M4 — 1,745,735 triangles  |    5,243 ms |                 — |
  | dense 5.01 MiB — 29,786 triangles       |       66 ms |                 — |

  **THE GAP TRACKS TRIANGLE COUNT, NOT ENTRY SIZE AND NOT THE ROUTE.** A
  248 MiB entry holding four triangles blocks the main thread for 139 ms; a
  242 MiB entry holding 1.36 M triangles blocks it for about 4.4 seconds, and by
  the same amount on both builds. It is the non-indexed render snapshot and its
  upload, which is main-thread work by construction and which A3 did not touch.
  Idle gap is 18–26 ms throughout, analysis gap 18–22 ms, and Cancel stays
  actionable — hover latency 43–104 ms at every size.

  **This is a PRE-EXISTING cost, recorded rather than introduced.** Reducing it
  means changing how geometry reaches the GPU, which is neither A3's question
  nor A4's.

### Open questions for A4

- **The new ceiling.** A3 deliberately did not choose one. The streamed path is
  flat to 242 MiB on every shape measured; what it does above 256 MiB, and what
  the render snapshot and automatic analysis do with the geometry that implies,
  is A4's measurement.
- **Export validation still buffers.** `exportDocument` reads its own artifact
  back with `ingestion: Buffered`, for the reason recorded above. It is bounded
  by `maxOutputBytes` (256 MiB) today; if A4 raises the import ceiling, whether
  the export ceiling follows — and whether validation should then route — is a
  question A4 inherits.
- **`XML_TAG_TOO_LONG` is now size-dependent.** Whether the streamed limit
  should be imposed on the buffered path, making it uniform at the cost of a new
  refusal for files the product accepts today, is not decided here.
- **Object-heavy XML prefers buffering at 98.62 MiB** by 102 MiB, the only shape
  that does near the line. It buffers under the selected threshold; whether it
  still prefers buffering ABOVE 128 MiB was not measured, because the fixture
  generator's object ceiling is the document's part ceiling.

## Stage 6E-A4 — the raised ceiling, and the export defect it exposed

A4 had two jobs: choose a production per-entry ceiling above 256 MiB from
full-product measurement, and resolve the export-validation problem A3 recorded
on its way out. The second turned out to be a live defect rather than a
tidiness item, and it had to be fixed before the first could ship.

### The export defect, found and reproduced

**The 3MF writer bounded its model XML by `maxSerialisedBytes` (512 MiB) while
the reader refused a model entry over `maxEntryBytes` (256 MiB).** Every
validated export reads its own artifact back with the production reader, so a
document landing between those two numbers was serialised in full, compressed,
and only then refused — surfacing as `EXPORT_VALIDATION_UNREADABLE`, an INTERNAL
error, after all the work.

Reproduced before anything was changed: a document of 1,500,000 unshared
triangles serialises to about 277 MiB of model XML inside a **22.7 MiB**
archive, and the production reader refuses that archive with
`ZIP_ENTRY_TOO_LARGE`.

**IT WAS REACHABLE ON `main` BEFORE A4.** 1.5 M triangles is an ordinary
multi-part package — Stage 6E-A3's own `pkg-250-250` fixture carries 2,833,988
— so importing a package and exporting it back to 3MF could fail with an
internal error. Raising the import ceiling would have made it commonplace.

### The fix, in three parts

- **ONE SOURCE OF TRUTH.** `threemf/size-limits.ts` is a leaf module importing
  nothing, holding `MAX_THREEMF_MODEL_ENTRY_BYTES` and
  `MAX_THREEMF_PACKAGE_BYTES`. `DEFAULT_ZIP_LIMITS` reads them; so does the
  writer; so do the end-to-end fixtures. Nothing restates either number.
- **THE WRITER IS BOUNDED BY WHAT THE READER WILL TAKE BACK.** Its model XML
  ceiling is now `min(maxSerialisedBytes, MAX_THREEMF_MODEL_ENTRY_BYTES)`. A
  document too large is refused by the WRITER, cleanly and before the work, as
  `EXPORT_SERIALISED_TOO_LARGE`. A resource refusal from the writer is a
  decision CAD Fixer can explain; one from the validator is CAD Fixer saying it
  wrote a file it cannot read.
- **VALIDATION ROUTES LIKE AN IMPORT, REVERSING A3.** A3 pinned parse-back to
  `buffered` so that a routing defect could not let an invalid file validate.
  That was affordable at a 256 MiB ceiling and is not at 320 MiB: buffered
  parse-back holds the whole entry twice over, so validating a maximum-sized
  export would cost more than importing it does — the exact cost Stage 6E
  exists to remove, paid at the end of every large export instead. What replaces
  the pin is stronger: routing is qualified by a 2,474-file three-way
  differential and by `ingestion-routing.test.ts`. **The artifact is still fully
  parsed and fully validated; nothing is trusted because we wrote it.** The
  export worker and `testExportReadContext` now supply `createTextDecoder`.

### Large export, measured through the product

A 297.15 MiB indexed import of 4,458,098 triangles, exported to all three
targets from the real convert dialog:

| Target | Artifact  | Duration  | Result |
| ------ | --------- | --------- | ------ |
| 3MF    | 30.9 MiB  | 16,004 ms | ok     |
| STL    | 212.6 MiB | 2,306 ms  | ok     |
| OBJ    | 133.4 MiB | 6,110 ms  | ok     |

Renderer `phys_footprint_peak` 1,185 MiB after the import, 1,815 MiB after all
three exports. **The 3MF artifact's own model entry is about 297 MiB**, so under
the old validation path this export would have been refused as unreadable — the
defect above, met at exactly the size A4 set out to support.

### Why the first proposed ceiling was withdrawn

A4's first ladder was built from the generator Stage 6E had used throughout:
unshared triangle soup at ~185 bytes a triangle. On that shape a 377 MiB entry
measured 1,295–1,487 MiB renderer, and 384 MiB looked comfortable.

**It was not, and the reason is that 3MF shares vertices.** An indexed grid
carries a triangle every ~70 bytes — roughly twice the density — and the 3MF
Consortium's own large positive cases are exactly that shape. Remeasured on
maximally dense indexed content the same declared size carries 5,438,402
triangles and peaks at **1,990–1,998 MiB renderer and 2,499–2,506 MiB
whole-browser**, back in the region Stage 6D-B3 rejected. The soup ladder had
understated the worst case by about 650 MiB.

The proposal was withdrawn on that evidence and the ceiling set at **320 MiB**,
whose largest admissible file — 319.52 MiB, 4,786,418 triangles — measures
1,513–1,619 MiB renderer and 1,977–2,083 MiB whole-browser over five fresh
browsers. The full ladder, the cliff between 336.60 MiB and 363.94 MiB, and the
8 GiB rationale are in `docs/release/RESOURCE_POLICY.md`.

**The lesson is durable and is recorded in `CLAUDE.md`: any future ceiling
argument must be made on maximally dense INDEXED content.** A soup ladder will
say the ceiling can be higher than it can.

### What this ceiling does and does not reach

- **BETA-002's class is supported**: an indexed 297.15 MiB entry imports at
  1,162–1,184 MiB renderer, and the tester's file class is no longer refused for
  its size. v0.3.0 is the release that carries it.
- **The 3MF Consortium's ~363 MiB positives are still refused**, and
  deliberately. `P_XXX_0909_04.3mf` and `P_XPX_0909_04.3mf` import correctly
  when the ceiling is raised far enough to admit them, at 1,878–1,970 MiB
  whole-browser; they are simply larger than this ceiling should allow on the
  supported machine. Supporting them needs a ~384 MiB ceiling, which measures
  2,506 MiB.
- **Corpus regression: 2,474 files, ZERO changed outcomes** against the 256 MiB
  ceiling, and 2,474 identical across buffered, streamed and routed reads.

### Responsiveness is bounded by triangles, and STL already permits more

Longest gap between animation frames, shipped build, one fresh browser each:

| Case                                     | Triangles | Longest gap   |
| ---------------------------------------- | --------- | ------------- |
| Text-heavy 294 MiB                       | 4         | 139 ms        |
| BETA-002 indexed 297 MiB                 | 4,458,098 | 13,663 ms     |
| Largest admissible 3MF, 319.52 MiB       | 4,786,418 | 14,591 ms     |
| **250 MiB binary STL — supported TODAY** | 5,242,878 | **15,184 ms** |

The gap is the non-indexed render snapshot and its upload, which is main-thread
work by construction and which A4 did not touch; it tracks TRIANGLES, not entry
size or route. **A 250 MiB STL, fully supported before this stage and unchanged
by it, stalls longer than anything the new 3MF ceiling admits**, so A4
introduces no new class or magnitude of main-thread stall. Idle gap is
18–23 ms throughout and Cancel stays actionable (hover 38–119 ms). Reducing the
stall itself means changing how geometry reaches the GPU, which is not this
stage's question.

## Staging plan

- **6E-A2 — DONE.** Production-quality streamed ingestion behind a non-default
  seam; see the section above.
- **6E-A3 — DONE.** Automatic per-entry routing at 128 MiB; see the section
  above.
- **6E-A4 — DONE.** Per-entry ceiling raised to 320 MiB; large-export
  validation fixed and routed. See the section above.
- **6E-A5** — release qualification and controlled deployment as **v0.3.0**.

The per-entry limit is **320 MiB**, and v0.3.0 is the release that carries
it.

## Reproduction

```bash
npx vitest run packages/file-formats/src/threemf/xml-stream.test.ts \
  packages/file-formats/src/threemf/streaming-ingestion.test.ts \
  packages/file-formats/src/mutation-campaign.test.ts
npm run qualify:streaming-import -- --cases dense:300 --modes whole,stream --runs 2
npm run qualify:streaming-import -- --cases dense:300 --modes stream --cancel 0.1,0.5,0.9
npm run qualify:streaming-import -- --cases dense-cjk:250,text:300,objects,placements
npm run qualify:streaming-import -- --cases dense:250 --emit /abs/dir/outside/repo

# Stage 6E-A3: the shipped build, which routes; and either path forced.
npm run build --workspace @cadfixer/web
npm run preview --workspace @cadfixer/web                # :4173, in another terminal
npm run qualify:import-phases -- file:1361499:/abs/dense-248.3mf --worker-heap
npx vitest run packages/file-formats/src/threemf/ingestion-routing.test.ts

# Stage 6E-A2: the same reader through the whole product, buffered or streamed.
npm run build:harness --workspace @cadfixer/web
npm run preview:harness --workspace @cadfixer/web      # :4175, in another terminal
CADFIXER_QUALIFY_URL=http://localhost:4175/ npm run qualify:import-phases -- \
  file:1646975:/abs/dense-300.3mf --ingestion=streaming --max-entry-mib=512 --worker-heap

# Buffered against streamed over a real corpus, fetched outside the repository.
CADFIXER_CORPUS=<dir> CADFIXER_CORPUS_REPORT=<file.jsonl> npm run qualify:streaming-corpus

npx playwright test -c playwright.harness.config.ts e2e-harness/streaming-import.spec.ts
```
