# EXPORT-CORE-01 — Permanent large OBJ export architecture

Development and qualification only. No merge, deployment, production configuration
change, or release-tag mutation is authorized by this stage.

Starting main and origin/main: `5e7b19290d582102a4407be535e5cbc8b69d44c5`.
Branch: `export-core-01`. Production remains v0.5.0 at
`302721e27a5013e40a28852a0267a0eec88162bc`.

## Baseline allocation chain

The exact source is `Hitem3d-1785766060812.stl`: 99,443,934 bytes,
1,988,877 triangles, 5,966,631 STL-imported vertices. Source SHA-256:
`3b9d3aaa3523f75c8e1a079e3aa3e50086d0f2cf9c5abbf78b8790df0a143e73`.

The pre-fix v0.6 OBJ output is 267,988,767 bytes. SHA-256:
`0496d4853c9fd7528ed76af4add3eb64a3d95e28ef3faf5ed8349ec9e3756bbc`.

Canonical STL geometry carries no retained facet-normal array in the export
snapshot. The viewport's existing flat-normal buffer is approximately 71,599,572
bytes (three Float32 values per imported vertex, calculated from the measured
counts); it is not an additional export representation.

The old pipeline:

```text
canonical geometry → copied worker snapshot → bounded text accumulation
→ retained UTF-8 chunks → concatenated complete Uint8Array
→ complete decoded text → parser number arrays
→ per-part vertex-remapping Map and typed geometry
→ expected baked geometry and two corner-comparison arrays
→ transferred complete artifact → Blob copy → object URL → download
```

The writer does not build a whole-file line array or call whole-file `Array.join`.
Its text accumulation was already approximately 64 KiB, but its byte sink retained
all chunks and concatenated the entire output. Transfer uses an ownership transfer,
not a structured clone of all bytes. Validation, rather than transfer, drives the peak.

| Representation                        | Approximate bytes / behavior                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Canonical/snapshot positions, each    | 71,599,572                                                                                |
| Canonical/snapshot indices, each      | 23,866,524                                                                                |
| Stored/generated normals              | Not exported; render normals are part of existing viewport residency                      |
| Writer text                           | Approximately 64 KiB; bounded ropes, not a whole-file string                              |
| Retained encoded chunks               | 267,988,767                                                                               |
| Concatenated output                   | Another 267,988,767                                                                       |
| Decoded text                          | 267,988,767 characters; UTF-16 upper bound 535,977,534 bytes; V8 may use one-byte storage |
| Parser coordinates                    | 17,899,893 JS numbers plus array capacity/overhead                                        |
| Parser corners                        | 5,966,631 JS numbers plus array capacity/overhead                                         |
| Remapping Map                         | Up to 5,966,631 entries                                                                   |
| Rebuilt, expected and corner geometry | Multiple additional geometry-sized typed arrays                                           |
| Worker-to-page artifact               | Full buffer transferred; no second structured-clone copy                                  |
| Blob/object URL                       | Blob owns complete file; URL revoked on the next task after click                         |

## Measured baseline timeline and CPU

Hardware Chromium profiling on Apple M1, 8 GiB, Metal ANGLE. Phase instrumentation
adds short observation delays; its 15.2-second elapsed time is not a throughput
benchmark. The prior uninstrumented release journey took about 8.2 seconds.

| Phase                                  | Renderer current MiB | Observed peak MiB |
| -------------------------------------- | -------------------: | ----------------: |
| Before export                          |                  644 |               732 |
| Serializer start                       |                  480 |               732 |
| 25% serialization                      |                  578 |               732 |
| 50% serialization                      |                  686 |               732 |
| 75% serialization                      |                  774 |                 — |
| Before complete concatenation          |                  838 |                 — |
| After concatenation                    |                  930 |             1,094 |
| Complete text decoded                  |                1,186 |                 — |
| Parser number arrays built             |                1,595 |                 — |
| Parsed document rebuilt                |                1,735 |             1,816 |
| Expected geometry built                |                1,826 |                 — |
| Semantic validation complete           |                1,963 |             1,963 |
| Before transfer                        |                1,962 |                 — |
| After transfer / before Blob           |                1,699 |             1,977 |
| After Blob / download / URL revocation |                1,293 |             1,977 |
| Worker terminated / five seconds later |                1,293 |             1,977 |

The release journey's larger starting footprint raised its renderer peak to
2,329–2,342 MiB. The export source is identical between v0.5.0 and release-prep
v0.6; `git diff v0.5.0 5e7b192 --` on OBJ writer, export transaction, semantic contract
and browser export controller is empty. The earlier release qualification supplied
the v0.5 comparison. Identical source does not imply identical allocator residency;
this instrumented baseline and the full release journey are reported separately.

The captured export-worker CPU profile is mapped through the baseline source map.
Dominant sampled work includes numeric formatting (1,035 samples), production
record parsing (~957), `buildPartMesh` (~714), token iteration (~412), finite-number
validation (~393), writer iteration (217), face parsing (~200), corner-array
construction (174), TextEncoder (166), TextDecoder (154), decimal-regex matching
(144), GC (131) and byte-sink concatenation (123). Idle samples reflect the explicit
observation pauses. No whole-file `Array.join` or structured-clone bottleneck appears.

## Native sink research

A 256 MiB isolated hardware run compared the native browser alternatives:

| Alternative                       | Renderer baseline / peak MiB | Observation                                      |
| --------------------------------- | ---------------------------- | ------------------------------------------------ |
| Native transactional writable     | 103 / 137                    | Awaited writes provide real backpressure         |
| OPFS file → file-backed download  | 100 / 138                    | Delivery did not recreate a full renderer buffer |
| Retained chunks → Blob → download | 194 / 590                    | Blob construction materially raises the peak     |

These initial tests used Playwright's private context. Subsequent repeated truck
exports showed that OPFS can be memory backed there, charging complete files to
the browser process. That distinction matters: low renderer memory alone is not
proof of disk-backed storage. Regular-profile qualification is recorded separately.
Production consequently uses no OPFS staging or OPFS download fallback.

The chosen native stream has transactional overwrite behavior: changes publish
on close, and abort retains an existing file. The save picker needs a user gesture
and a secure context. Browser behavior is grounded in the
[File System Standard](https://fs.spec.whatwg.org/) and Chromium's
[File System Access documentation](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).
No browser-native streaming-download technique already existed in this repository.

## Permanent pipeline

```text
Export click → conservative scalar routing
small → shared serializer → buffered production parse-back → automatic Blob download
large → save picker → native transactional writable
      → worker-only disposable geometry snapshot
      → shared bounded serializer → incremental UTF-8
      → shared production record parser + source-semantic comparison
      → one transferable byte chunk → awaited native write → ACK
      → mandatory EOF validation → live revision/token guard → atomic close
```

`ExportSink` separates writing, closing and aborting from serialization.
`exportObjDocumentStream` lives in the platform-independent format package.
The browser worker supplies encoder/decoder and transfer adapters. The controller
owns publication and cancellation. The serializer is the same formatter used
by buffered OBJ export.

The independent parser sees the actual encoded bytes, including UTF-8 seams.
It checks every Float32 coordinate, global corner index, object name/order,
group boundary/extent and material reference. It validates EOF and final counts.
No expected-coordinate array, rebuilt mesh, remapping Map or corner array is
allocated for large export. Buffered import still builds its ordinary document
from the same production records. Fixture differentials exercise both consumers.

Read-back here means parsing generated bytes before publication, as in the
existing buffered export contract. It does not claim to verify user-disk sectors;
native filesystem write integrity is the browser's responsibility. No validation
switch, shortcut or lenient second parser exists.

## Routing, memory and lifecycle

The 32 MiB small-path threshold is a conservative upper bound, not an output-size
refusal. The estimate counts each placement's vertices × 80 bytes, faces × 40
bytes, and worst-case UTF-8 names/material switches/run ends. Both page descriptors
and authoritative worker snapshots use the same estimator. Existing 256 MiB
output and 512 MiB serialized/import ceilings are unchanged. Exact running encoded
bytes remain authoritative. Preflight's genuine lower bound counts vertex and face
records separately so indexed vertex sharing cannot cause a false refusal.

Production delivery chunks are at most 256 KiB. Text uses at most C UTF-16 code
units; encoding uses at most 3C bytes; the decoder retains only its UTF-8 tail
and bounded record text. A partial view is copied to an exact-sized transferable
buffer, while a whole buffer transfers directly. Length accounting happens before
detachment. Parser consumption and disk writes each have a single-item rendezvous.

Total memory includes the existing copied geometry snapshot (91.0 MiB on the truck),
viewport/canonical residency and V8 heap/GC overhead. The serialized-output working
set is O(C), independent of total output bytes; these different costs must not be
confused in the measured process footprint.

Progress is monotonic, weighted by vertices plus faces, yielded every 32,768 work
units and throttled to at most one ordinary report per 50 ms. Mandatory record
checking runs within the writing pipeline; final validating/saving phases finish
EOF checks and commit. Cancel terminates only the disposable worker and aborts
the native transaction. Picker cancellation starts no worker or snapshot. A missing
qualified file API reports a capability failure without a large-Blob fallback.

A new target can have an empty picker-created placeholder after abort; an existing
target retains its prior bytes. Native atomic close is the publication point.
Cancel is accepted until close is submitted; a commit already submitted resolves
as success or failure rather than falsely claiming a saved file was cancelled.
Repair commit/undo is blocked while exporting. Replacement and revision changes
cancel the session, with another live token check before disk write and close.

STL binary, STL ASCII and 3MF keep their format behavior. OBJ units remain unstated,
opaque `usemtl` references remain supported without writing an MTL, numeric text,
header/stamp, source-derived suggested filename and group/object ordering are unchanged.
No network/CSP policy, dependency or off-origin data path is added.

## Qualification results

Hardware: Apple M1, 8 GiB, headful desktop Chromium with ANGLE Metal. The
qualification browser uses an isolated **regular persistent profile**, not a
private context. Only the OS picker is substituted: it returns a native OPFS
handle; the shipped UI, serializer, mandatory validator, transfers, ACKs and
`FileSystemWritableFileStream` run unchanged. No production OPFS code is present.
A real OS picker/save to a user-selected pathname is **not yet qualified** because
the Mac is locked. API parity is not a claim that this missing UX gate was tested.

### Final production matrix

All memory values are MiB, frame gaps/cancel times are milliseconds. Peak is the
largest sampled current footprint; the separate process lifetime high-water mark
can include import or repair and carries across repeated exports. Sampling cannot
resolve every short-lived allocation; the lifetime peak is also retained in evidence.
Time includes the automated Export click, native writes, validation and close.

| Triangles / run | Bytes | Path | Time ms | Renderer baseline / sampled peak / lifetime peak | Browser peak | Additional sampled MiB | Frame gap | Cancel ms |
| --------------- | ----: | ---- | ------: | ------------------------------------------------ | -----------: | ---------------------: | --------: | --------: |

| 10,000 / 10000 | 484,325 | blob | 346 | 123 / 127 / 142 | 69 | 4 | 18.36 | — |
| 100,000 / 100000 | 5,278,847 | blob | 827 | 251 / 333 / 344 | 73 | 82 | 18.00 | 29 |
| 250,000 / 250000 | 14,263,022 | file | 1320 | 306 / 337 / 362 | 68 | 31 | 18.59 | 34 |
| 500,000 / 500000 | 29,799,568 | file | 2335 | 398 / 501 / 501 | 72 | 103 | 18.54 | 30 |
| 1,000,000 / 1000000 | 61,630,031 | file | 4873 | 493 / 555 / 624 | 70 | 62 | 18.66 | 44 |
| 1,988,877 / real-1 | 267,988,767 | file | 7447 | 641 / 641 / 732 | 73 | 0 | 33.32 | 46 |
| 1,988,877 / real-2 | 267,988,767 | file | 7402 | 488 / 596 / 732 | 78 | 108 | 18.66 | — |
| 1,988,877 / real-3 | 267,988,767 | file | 7440 | 414 / 583 / 732 | 82 | 169 | 18.65 | — |
| 1,988,883 / real-repaired | 267,988,923 | file | 7393 | 549 / 751 / 939 | 82 | 202 | 35.04 | — |

### Chunk-size comparison

Each trial exported all 267,988,767 real-model bytes through the production core
and mandatory validation. Trials share one page and differ only in the test-only
chunk adapter. GC comes from Chromium tracing; cancel latency here measures the
API acknowledgement, whereas the matrix measures a real Cancel-button click.

| Chunk    | Time ms | Writes | Renderer baseline / sampled peak MiB | GC events / total ms | API cancel ms |
| -------- | ------: | -----: | ------------------------------------ | -------------------- | ------------: |
| 64 KiB   |    6899 |   4091 | 639 / 839                            | 401 / 134.12         |         0.675 |
| 256 KiB  |    5992 |   1023 | 475 / 629                            | 326 / 189.75         |         0.080 |
| 1024 KiB |    6244 |    256 | 522 / 751                            | 309 / 434.86         |         0.115 |
| 4096 KiB |    7250 |     64 | 600 / 858                            | 317 / 1369.41        |         0.135 |

256 KiB is the fastest measured candidate and has the lowest sampled renderer
peak. Increasing to 4 MiB increases GC work substantially. Every trial observes
at most one in-flight write and a maximum delivered chunk equal to its configured
bound. Manual bounded TextEncoder encoding was measured; TextEncoderStream was
not needed or claimed faster.

### Memory scaling calculation

For 250k, 500k, 1M and the first real export, output grows from 13.60 to
255.57 MiB (18.8×), while sampled additional memory is
31, 103, 62, 0 MiB. The ordinary least-squares slope is
-0.275 MiB additional renderer memory per MiB output. These points do not
show retained whole-output copies; a negative slope is allocator/GC variation,
**not** a physical negative memory requirement. The three equal-size real runs
show 0, 108 and 169 MiB additional footprint. Repaired output shows 202 MiB.
Consequently total process overhead is not universally a small fraction of the
file size. The proven O(C) invariant applies to serialized-output residency;
existing geometry copies and GC/accounting remain visible costs.

The complete real export is below the 1.5 GiB target, including the 1,020 MiB
lifetime peak in the repeated lifecycle check, versus 2,329–2,342 MiB in the earlier release journey.
This is a material reduction, not a raised ceiling. The 256 MiB output ceiling
remains unchanged; the motivating output is 255.57 MiB and succeeds.

### Equivalence, cleanup and recovery

All three original real outputs match the baseline SHA-256 exactly. Repaired
output is 267,988,923 bytes, SHA-256
`2703b61892ee17b0add2ede213dae1a3a21b9f22e50baff197bf3206ba055b96`.
The fresh-page repaired re-import confirms 1,988,883 triangles, 11 open boundaries,
155 non-manifold vertices and 39 components, with no degenerate/duplicate faces,
winding conflicts or non-manifold edges. Self-intersection checking was not run;
its displayed dash is not a zero count.

Original exports return to 488, 414 and 355 MiB after 30 seconds, respectively,
with no monotonic leak. Cancellation acknowledges in 46 ms and retains the
existing 267,988,767-byte destination. No application staging file or download
is produced. Repair after the three exports succeeds and adds six triangles.

The corrected lifecycle runner waits for the newly imported filename before
reading analysis. A prior runner could observe the old model immediately after
replacement; that capture is superseded. The corrected repaired re-import again
confirms the topology above. Direct export → replacement with a 10k-triangle model
measures 537 / 504 / 501 MiB immediately / +5 s / +30 s and a responsive analysis.
The additional original export takes 6,877 ms; repaired export takes 6,918 ms,
peaks at 732 MiB sampled (1,020 MiB process lifetime including repair), has a
50.15 ms maximum frame gap, and returns to 499 MiB at +30 s. Cancel takes 47 ms.

Separately, full buffered OBJ re-import → replacement measures 2,173 / 2,140 /
906 MiB immediately / +5 s / +30 s, with a 2,175 MiB lifetime peak. That is an
existing large **import** allocation cost, not serialized-output residency in
this new export path. This stage does not rewrite OBJ import assembly.

### Regression result and decision

`npm run verify` passes formatting, lint, all workspace/worker type checks, 148
unit-test files (3,374 passed, 10 existing skips), and the production build.
The clean application suite passes 317 tests with its two existing opt-in
benchmark skips. The never-shipped harness passes 130 tests. The isolated timing
suite passes 15 tests. All nine new OBJ browser cases pass. The prior repaired-OBJ
round-trip test now captures the closed native file for its unchanged geometry
assertions. One initial small-import timeout passes unchanged both in isolation
and in the subsequent clean full run. No acceptance threshold was relaxed.

Release packaging and its verification are executed after committing this report
so the manifest can name a clean source commit. Their logs remain with the raw
qualification evidence; packaging is local and does not authorize deployment.

Decision: **EXPORT-CORE-01 PARTIAL**. The bounded output architecture, exact real
model, repeated exports, mandatory round-trip, hardware renderer ceiling and
complete automated regressions are qualified. Two limitations remain explicit:
actual OS picker/user-selected pathname acceptance is blocked by the locked Mac,
and total process additional memory is not universally demonstrated to be a
small fraction of output size. The serialized-output invariant is bounded; source
snapshot copies and GC footprint need separate acceptance of the measured costs.
The branch is kept local because publication was requested after qualification.
No merge or deployment is performed. Complete the remaining acceptance checks
before declaring PASS, publishing the branch, or restarting RELEASE-06 from a
new frozen SHA.
No user geometry is committed or uploaded. Raw profiles, timelines, hardware
results and synthetic matrices are kept outside the repository.

### Reproducing hardware qualification

Build the application, serve its production preview locally, and run:

```sh
CADFIXER_EXPORT_URL=http://localhost:4191 \
CADFIXER_EXPORT_REAL_MODEL="$HOME/Downloads/Hitem3d-1785766060812.stl" \
CADFIXER_EXPORT_EVIDENCE=/private/tmp/pybrix-export-qualification \
npm run qualify:obj-export
```

For the four chunk candidates, build/serve the never-shipped harness and set
`CADFIXER_EXPORT_HARNESS_URL` and the same model/evidence environment variables
before `npm run qualify:obj-chunks`. The macOS runner uses `/usr/bin/footprint`;
its headful Metal browser is deliberately isolated from personal profiles.
The runner makes no model network request. Run hardware measurements serially,
without competing browser/test jobs. Evidence includes native write sizes,
backpressure checks, process footprints, frame gaps and Chromium GC traces.

## EXPORT-RC-01 follow-up

The percentage-of-output memory criterion in this historical qualification is
superseded by bounded live serialized-output residency, independent of total
output bytes. Actual OS picker acceptance is now exercised and is blocked by
pre-return truncation of an existing destination in Chromium's save picker.
The prior OPFS picker substitute did not test that behavior. See
[EXPORT-RC-01](EXPORT_RC_01.md) and the native acceptance addendum to ADR 0019.
