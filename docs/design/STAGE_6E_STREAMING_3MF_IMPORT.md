# Stage 6E — Streaming 3MF import

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

## Staging plan

- **6E-A2** — production-quality streaming ZIP/XML ingestion with semantic
  parity, **still behind a non-default seam**: the production slice-fed inflater,
  the reader option promoted from research-only to a reviewed seam, corpus parity
  against the real-producer corpus, and the full browser suites.
- **6E-A3** — the product path: the worker and page sides of a streamed import
  measured end to end, including render upload and the automatic analysis gate.
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
```
