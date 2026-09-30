# EXPORT-CORE-02 — preservation-safe large OBJ destination

**EXPORT-CORE-02 PASS — PRESERVATION-SAFE LARGE OBJ DESTINATION QUALIFIED**

Qualified on `export-core-02`, based on the preserved
`export-core-01` commit `f75bde15d596b0ef55c878d01b7f0df691778074`.
Main remains `5e7b19290d582102a4407be535e5cbc8b69d44c5`. No deployment.

## Destination acquisition

Large OBJ uses a filename and directory separately. A synchronous Choose folder
click, or the first Export click without a selected folder, invokes
`showDirectoryPicker({mode: 'readwrite'})`. The interface displays only the
handle's folder name, never an inferred absolute path. Small OBJ keeps automatic
Blob download. The unchanged conservative estimate routes at 32 MiB: at or below
uses Blob; above uses this native path. There is no large-output fallback.

The filename defaults from the source. An existing `.obj` extension is preserved
case-insensitively; otherwise `.obj` is appended. Empty/whitespace-only names,
`.`/`..`, separators and NUL are rejected. Ordinary Unicode is preserved.
Underlying filesystem name restrictions remain errors from `getFileHandle`.
Filename/folder edits reclassify with `create:false`, invalidate the lookup's UI
callback and start no worker. Changes are disabled during a live transaction.

Lookup obtains only name, size and lastModified through `getFile()`. It never
reads the whole existing file, hashes it, stages it, or opens a writable.
An existing target requires explicit Replace file confirmation. The directory is
looked up again afterward; entry identity, size or timestamp changes require a
new confirmation. After acquiring the writer these facts are checked again.

## Transaction and commit

A qualified writer uses `createWritable({mode:'exclusive', keepExistingData:false})`.
It starts with an empty transaction without copying the existing file. A second
no-write writer probe must fail with `NoModificationAllowedError`; a browser
ignoring the option aborts and fails capability before serialization. There is no
save-picker, giant Blob, cloud, OPFS staging, experimental rename/move, or browser
filesystem flag in production. The service refuses a second application export
while a writer, cleanup or submitted close is active.

The unchanged worker serializer retains C=256 KiB, N=1, mandatory production
record parsing and source-semantic validation. Every disk write is awaited before
ACK. No export worker or geometry snapshot begins before destination acquisition
and overwrite authorization complete.

Successful native `close()` is the commit point. The controller accepts Cancel
until close is submitted. A submitted close cannot be reliably cancelled; its
actual result determines success or failure, and a committed file never becomes a
Cancelled outcome. No success precedes successful close.

## New-file ownership and cleanup

An absent target is rechecked immediately before `getFileHandle({create:true})`.
Creation occurs only when the writable is needed. The acquisition closure owns its
unique request/signal, directory, normalized name, file handle, original absence,
empty-file size/timestamp evidence, writable and successful-close flag.
Unexpected nonempty or older metadata after creation is treated as a racing
existing file and requires confirmation; it is never classified as owned.

Cancellation terminates the export worker immediately. UI settlement and service
release wait for abort and guarded cleanup. Owned new targets are removed with
`removeEntry` only after looking up the target without creation and comparing
`isSameEntry`, size and lastModified to the original empty placeholder. Changed
metadata or entry identity forfeits removal ownership. Existing files are never
removed. Cleanup failures become failures, not a false Cancelled acknowledgement.

The API has no atomic exclusive-create result or conditional removeEntry. A zero
byte racing file created in the same timestamp interval can be indistinguishable
from our new placeholder. `isSameEntry` can identify the same filesystem path,
not necessarily a durable inode identity. Metadata and identity checks narrow
these races but cannot eliminate an external replacement between the final check
and removal, or edits preserving both size and timestamp. Native exclusive locks
coordinate browser writers; they do not lock arbitrary OS applications. This
residual API limitation is explicit; no blind deletion or synthetic ownership
marker is claimed. Permission loss can prevent cleanup; the error is surfaced
and no alternate destination or unsafe delete is attempted.

## Qualification

See `export-core-02/qualification.json` for the final acceptance matrix. Hardware
scope remains desktop Chromium on an unlocked Apple M1 / 8 GiB Mac with secure
localhost and actual native directory selection and disk files. Automated
provider tests use controllable directory/file handles and OPFS-backed test
adapters; they are regression tests, not substitutes for native acceptance.

No source model or complete OBJ is committed or uploaded. Raw scalar evidence
is retained outside Git; only exact disposable acceptance outputs are removed.

## Native acceptance results

Actual macOS Chromium 151.0.7922.34 on Apple M1 / 8 GiB used the native
read/write directory picker, real disk files and hardware Metal rendering.
Existing targets retained their SHA through cancellation and injected write/close
failures. Final-build fault tests preserved a 310,000-byte sentinel with SHA
`18407d9c01e3e8c940194defe9ab5f57abcbdb95b727609cc4f9ff041894dd95`.
Failures were safely injected in native stream adapters before write/close, or as
Worker error/message events; no actual OS corruption or process crash is claimed.

A 300 MiB sentinel was replaced with exactly 267,988,767 bytes. During 569 stat
samples only the original and final sizes appeared, never zero. Successful
original exports, including three repetitions without reload, had SHA
`0496d4853c9fd7528ed76af4add3eb64a3d95e28ef3faf5ed8349ec9e3756bbc`.
Repair filled two openings, adding six triangles. Its 267,988,923-byte OBJ had SHA
`2703b61892ee17b0add2ede213dae1a3a21b9f22e50baff197bf3206ba055b96`.
Re-import reported 1,988,883 triangles, 11 boundaries, 155 non-manifold vertices
and 39 components; self-intersections remained unchecked.

New-file cancellation, write/close/worker/serialization failures and stale
revision left no partial file. Existing cancellation settled in 40–44 ms;
new-file and 300px cancellation settled in 63–65 ms, including abort/cleanup.
Native exclusive access rejected a second writer with NoModificationAllowedError.
Two actual Pybrix tabs targeting one existing file refused the second export
before it started a worker. Directory cancellation started no worker or write.
Both overwrite choices and the Export button were visible at 1440×300.

## Memory and regression verification

Original native export peaks were 790–893 MiB; repaired export peaked at 962 MiB.
The longer import/fault/stale/repair/export session reached 1,505 MiB before OBJ
re-import, within the 1,536 MiB gate. RC-01's shorter run reported about 734 MiB;
the larger lifetime maximum was investigated through individual export peaks and
repeat settlement, not dismissed as a uniform percentage allowance. Three
30-second settled readings were 647, 642 and 648 MiB, showing no retained growth.
The supplemental oversized-sentinel helper sampled a spare renderer; that memory
sample is excluded. The primary renderer matrix is the memory evidence.

Large OBJ re-import still uses the existing buffered import path and belongs to
IMPORT-CORE-01 debt; the export memory gate does not claim a post-reimport lifetime
under 1.5 GiB. Serialization retains O(C+L) bytes, with C=262,144 and one chunk in
flight; the permitted geometry source snapshot is 95,466,096 bytes. Each success
awaited 1,023 writes and one close. Maximum native export frame gap was 83.335 ms,
below 250 ms; repaired export was 49.56 ms. No model upload, off-origin request or
non-GET request occurred during the native export rows.

Full verification passed 149 test files / 3,409 unit tests, format, lint,
typechecking and production build. Application E2E passed 320 tests with two
pre-existing opt-in skips; all 12 destination cases passed. Harness passed 130;
timing passed 15; release mechanism passed 28. The first harness attempt had a
dense-texture frame-gap failure (415.845 ms); an isolated diagnostic and unchanged
full retry passed at 116.7 ms. No limit, assertion, timeout or skip was weakened.
One full unit attempt also timed out in the existing XML-retention auto ASCII
case (5,000 ms). Its isolated diagnostic and unchanged full rerun passed; that
failed attempt remains in the evidence archive. The last explicit “File changed”
reconfirmation message received full application
regression coverage. A test-double typing error was corrected before final verify.

Precommit release artifact checks used the supported `--allow-dirty` mechanism
qualification only. Normal clean-tree release build and verification must pass
at the committed HEAD before branch push. No deployment or merge is authorized
by this qualification. Seven exact disposable native outputs were deleted only
after matching size/hash; the source SHA remained unchanged and the destination
was empty. Scalar evidence, scripts, logs and two UI screenshots are archived
outside Git at the location recorded in the qualification JSON. No models,
complete OBJ files or browser profiles are committed or uploaded.
