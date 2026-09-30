# EXPORT-RC-01 — actual native save acceptance

**BLOCKED: `showSaveFilePicker` truncates an existing target before returning its
handle. Cancellation cannot preserve its pre-picker contents. Main is not merged.**

Starting main: `5e7b19290d582102a4407be535e5cbc8b69d44c5`.
Qualified serializer: `88c815c17dd51750d2a3f952d4ca2b189e34e0aa` on
`export-core-01`, pushed normally for durability before acceptance. No serializer,
worker protocol, validation, routing threshold or native writer was redesigned.
The inspector's incorrect “Browser downloads” destination for large OBJ is
corrected to “File you choose,” using the same estimate as the Export click.

## Actual hardware and destination

Apple M1, MacBookPro17,1, 8 GiB; macOS 27.0 (26A5421a); regular persistent
hardware Chromium 151.0.7922.34; ANGLE Metal Apple M1. Secure localhost:4191,
real `showSaveFilePicker`, actual OS Save/Replace/Cancel dialogs, real local
file handles. No OPFS picker substitute. Starting system memory free percentage
was 33%; the data filesystem reported 17 GiB free. The test used disposable
files in `/private/tmp/export-rc-01-native`; one initially user-approved save
went to Downloads and was identified by exact name, size and hash.

The source `~/Downloads/Hitem3d-1785766060812.stl` has SHA-256
`3b9d3aaa3523f75c8e1a079e3aa3e50086d0f2cf9c5abbf78b8790df0a143e73`.
No model or OBJ data is committed. Exact acceptance outputs are deleted after
recording their hashes; the source and unrelated Downloads files are preserved.

## Native acceptance

- Valid click activation opens the picker; approval precedes export-worker
  creation. Picker cancellation creates zero export workers and zero writes,
  leaves the model usable and shows neutral “Export cancelled — nothing saved.”
  The observer's generic `convert-failure` element count includes this neutral
  cancellation footer; it is not an error toast.
- Three consecutive complete native exports without page reload each produce
  **267,988,767 bytes**, SHA-256
  `0496d4853c9fd7528ed76af4add3eb64a3d95e28ef3faf5ed8349ec9e3756bbc`.
  Each transaction closes once; the only remaining worker is the geometry
  worker. Settled renderer memory is 401, 409 and 413 MiB at +30 seconds.
- Repair fills two openings and adds six triangles. Native repaired output is
  **267,988,923 bytes**, SHA-256
  `2703b61892ee17b0add2ede213dae1a3a21b9f22e50baff197bf3206ba055b96`.
  Actual re-import confirms 1,988,883 triangles, 11 boundaries, 155 non-manifold
  vertices and 39 components. Unchecked self-intersections remain unchecked.
- Existing-target successful overwrite ends with the correct original OBJ
  hash, but **fails pre-commit preservation**: disk observation sees sentinel,
  zero bytes, then complete OBJ. Replacement is not atomic relative to the
  pre-picker contents.
- Existing-target cancellation acknowledges in **119 ms**, aborts the writable,
  never claims success, but leaves the target **empty**, destroying the sentinel.
- A new target cancelled at 300 px acknowledges in **110 ms**; a zero-byte
  placeholder remains, with no success or partial OBJ. The Convert CTA is
  reachable at x=14, y=213.586, width=256, height=36 in a 1440×300 viewport.
- A safe injected write rejection through the real native writable adapter
  aborts, reports failure and leaves no completed output. The next real native
  export succeeds with the expected original hash.
- Model-derived suggestions are preserved; edited destination names appear in
  the OS file and the saved message. Corrected progress observation records
  monotonic real original/repaired exports. No export upload or off-origin
  request occurs. Native export requests are same-origin GETs only.

## Isolated blocking proof

A separate picker-only button selected a recognizable existing sentinel. It
never invoked `createWritable`, never serialized, started zero export workers,
and made zero writes. Immediately after the actual OS picker returned,
`handle.getFile().size` was zero and the disk SHA was the empty-file SHA.
Therefore the truncation predates Pybrix's stream transaction.

[Chromium's implementation](https://chromium.googlesource.com/chromium/src/+/main/content/browser/file_system_access/file_system_access_manager_impl.cc)
explicitly creates/truncates a save-picker target before returning its handle.
`createWritable({keepExistingData:true})` cannot recover bytes already lost.
The prior OPFS picker substitute omitted this destructive acquisition step, so
its existing-file cancellation result is not native preservation evidence.

A new destination-acquisition contract must preserve existing contents before
serialization. Qualify that contract separately, retaining this serializer and
mandatory semantic validation. The current requirement to choose an existing
file through this destructive save-picker flow and preserve its original bytes
on cancellation cannot pass on the tested Chromium implementation. No arbitrary
refusal, full Blob fallback, OPFS staging, cloud processing or speculative
redesign was introduced to hide the failed gate.

## Formal memory invariant

For the large file-backed route:

`M_extra ≈ M_fixed_serializer + M_source_snapshot + N_inflight × C + M_sink_fixed + allocator/GC variance`

Here `C = 256 KiB`, `N_inflight = 1`. The real input's existing geometry/source
snapshot is 95,466,096 bytes, approximately 91 MiB. It is source geometry, not
serialized output. Total additional process footprint need not be a uniformly
small percentage of file size; that former criterion is explicitly superseded.

Live serialization is `O(C + L)`, where production OBJ line length `L` is
bounded to 65,536 characters. Pending text is bounded by C UTF-16 code units;
encoding allocates at most 3C bytes; delivery pieces are at most C bytes. A
partial view may allocate one exact C-sized transferable piece, while its
bounded parent remains in the worker. Decoder/parser text and numeric records
are bounded; EOF validation accumulates counters, not reconstructed output.
All these constant factors belong to fixed serializer workspace. None is a
complete serialized string, complete UTF-8 array, Blob, retained chunk list or
page-side duplicate artifact. Source descriptors/snapshot remain separately
attributable source costs.

The production worker transfers owned delivery buffers and awaits the controller
ACK. The controller awaits native write completion before ACK. The rendezvous
validator consumes records incrementally before each sink write; final semantic
validation precedes close. Large success returns metadata and selected name,
with no final page-owned bytes. Existing controller tests assert this explicitly.

A new production-core regression uses a larger-than-C output and a deliberately
blocked sink. Every emitted buffer detaches through real `structuredClone`
transfer, outstanding delivery bytes never exceed C, and write count cannot
advance until release/ACK. It stores no output chunk collection. Native runs
observe the same maximum **262,144 outstanding bytes**, including 1,023 writes
for each real output. Existing Unicode/partial-view, validation/corruption,
controller blocked-write and finalization tests remain mandatory.

## Native memory measurements

All memory values are MiB. Peak below is sampled current footprint during the
export interval, including its pre-export baseline; lifetime peaks are reported
separately because earlier import/repair may set them. Medium samples share a
browser after the cancellation/recovery lifecycle; allocation history affects
baselines. Measurements are supporting evidence, not a replacement for the
residency proof.

| Model/run             |  Output | Before | Sample peak | Extra | Browser peak | +5 s | +30 s |
| --------------------- | ------: | -----: | ----------: | ----: | -----------: | ---: | ----: |
| 250k                  |  13.602 |    319 |         381 |    62 |           79 |  345 |   344 |
| 500k                  |  28.419 |    511 |         573 |    62 |           79 |  532 |   515 |
| 1M                    |  58.775 |    628 |         739 |   111 |           79 |  665 |   638 |
| Real original 1       | 255.574 |    648 |         648 |     0 |           79 |  401 |   401 |
| Real original 2       | 255.574 |    403 |         573 |   170 |           79 |  428 |   409 |
| Real original 3       | 255.574 |    412 |         584 |   172 |           79 |  462 |   413 |
| Real repaired         | 255.574 |    570 |         776 |   206 |           79 |  583 |   568 |
| Real failure recovery | 255.574 |    391 |         576 |   185 |           79 |  416 |   401 |

Original repeated-run renderer lifetime peak is **734 MiB**; repaired lifecycle
lifetime peak is **970 MiB**, including Repair. Both are safely below 1.5 GiB.
The medium sequence reaches 810 MiB lifetime peak; none exceeds the ceiling.
Output grows 18.8× across the primary large samples; extra footprint is
nonmonotonic (62, 62, 111, 0 MiB). Supporting OLS slope is −0.311 MiB per output
MiB; this is allocator/GC variation, not a physical negative-memory bound.
Other real runs have 170–206 MiB extra, including the permitted source snapshot
and runtime/GC costs; they do not establish an output-proportional retained
representation. Browser peak is constant and repeated settled memory is stable.
The existing EXPORT-CORE matrix independently supports the same conclusion.
The formal live-output invariant passes; native destination preservation fails.

## Regression, evidence and separate debt

Routing regression brackets the one-part integer estimate at 32 MiB −4 bytes
and +36 bytes: the former uses Blob, the latter requires a native sink. Exact
threshold equality is unreachable for integer descriptor counts under this
estimator; the implementation's rule remains `estimate > 32 MiB`. Small downloads,
early explicit missing-capability refusal, no full-buffer large fallback,
backpressure and cancellation/finalization race behavior stay in full regression.
After close is submitted, cancellation cannot falsely report cancellation of a
committed file; deterministic controller tests cover both commit success and
failure. Actual native close events are recorded; no destructive OS fault is used.

Full gate results are recorded separately in bounded `verification-summary.json`:
check:node, typecheck, format:check, lint, verify, build, release:build,
release:verify, test:e2e, test:e2e:harness and test:e2e:timing. Automated success
cannot override the independently reproduced native preservation blocker.
An initial verification attempt lacked sandbox permission for its localhost
monitor test and overlapped native work; its unchanged timeout/permission failures
are retained alongside the subsequent authorized quiet run. No skip or timeout
limit is weakened. Earlier observer picker-wait timeouts and a hidden responsive
workspace-tab click are also retained as observer failures, not exporter results;
corrected observers provide the accepted native traces.

Compact committed data: [qualification.json](export-rc-01/qualification.json).
Raw bounded evidence and verification logs are outside shipping artifacts at
`/Users/cprakash/.codex/visualizations/2026/09/30/01a0f19f-aa61-78d3-8ed8-dfc5864441d4/pybrix-export-rc-01-evidence`.
Huge OBJ outputs and browser profiles are excluded. Native output cleanup uses
exact recorded paths with hash checks.

The approximately 2,175 MiB historical buffered OBJ re-import cost is separate
import debt, not export failure. [IMPORT-CORE-01](IMPORT_CORE_01.md) documents
bounded/streaming large OBJ import as a future stage; it is not implemented here.

Main remains `5e7b19290d582102a4407be535e5cbc8b69d44c5`. No merge, tag,
production change or deployment occurs in this stage. Resolve native destination
preservation and repeat EXPORT-RC-01 before restarting RELEASE-06.
