# 0015 — Production OBJ and 3MF import

Status: **Accepted and implemented.** Stage 4A-2B1.

Date: 2026-09-04

Implements the import half of ADR 0013's frozen scope, on top of the document
layer ADR 0014 built. Supersedes nothing; it corrects one factual claim in
ADR 0013, recorded below.

## What changed

CAD Fixer reads three formats. `.stl`, `.obj` and `.3mf` all arrive through one
path and all produce a `GeometryDocument`:

```
bytes + file name
        ↓  identifyFormat            bytes decide; the name only disambiguates
formatId
        ↓  requireReader             one DocumentReader per format
DocumentReadResult                   document + encoding + warnings + compatibility
        ↓  assertMeshStructure       per DISTINCT mesh, not per part
        ↓  commitImportedDocument    the single import transaction
DocumentHandle
```

**Import only.** There is no OBJ writer and no 3MF writer. STL remains the only
format CAD Fixer can produce, the Convert workflow is still unavailable, and the
Model panel states both before the user clicks Export.

## Format identification reads bytes, never the extension

`identifyFormat` looks at the file's first 4 KiB and its length: a `PK`
signature with a readable directory is 3MF; an 80-byte header plus a triangle
count that satisfies `84 + 50n === length` exactly is binary STL; a leading
`solid` with STL keywords following is ASCII STL; OBJ records at line starts are
OBJ.

The file name is used for exactly two things: to disambiguate an otherwise
ambiguous sniff, and to REPORT a mismatch. A `.stl` whose bytes are an OBJ is
refused as `ContentExtensionMismatch` rather than parsed as either. The name is
untrusted text from the user's filesystem, and treating it as evidence is how a
parser gets pointed at the wrong grammar.

## OBJ: triangles only, and a refusal rather than a fan

A face with more than three corners is refused at the first extra token, with a
message that says CAD Fixer will not invent the interior it did not read. ADR
0013 froze this after the research measured what a naive fan does to a concave
pentagon: it produces a triangle of the OPPOSITE orientation, covering area
outside the polygon the file described. Silently emitting geometry the file did
not contain is the exact failure mode the preservation policy exists to prevent.

`o` becomes a part. `g` is recorded as group membership on the part it applies
to, and does not create one — the research corpus showed `g` used for material
zones and for smoothing bands far more often than for separable objects, so
treating it as a part boundary would split single objects apart. A file with no
`o` at all becomes one unnamed part; faces before the first `o` become a leading
unnamed part rather than being attached to the first named one.

An OBJ states no unit, and CAD Fixer says so rather than assuming millimetres.

`mtllib` IS NEVER OPENED. The reference is recorded as an unsupported feature
and reported to the user by name; nothing resolves it, nothing reads a sibling
file, and nothing fetches a URL. A material library is a path chosen by an
untrusted file, and following it is a file-system read the user did not ask for.

## 3MF: bounded container, fail-closed XML

The archive reader is ours, in `threemf/zip.ts`, and it is bounded before it
inflates anything: 512 MiB archive, 4,096 entries, 256 MiB per entry, 512 MiB
total uncompressed, 200:1 ratio, 512-character paths. Encrypted entries and
methods other than store and deflate are refused. Paths are rejected for
traversal, absoluteness, drive letters, backslashes, URL shapes, percent
encoding and ANY control character — the ASCII decoder deliberately preserves
control bytes so that last check can actually fire.

**The ratio and total budgets are enforced DURING inflation, chunk by chunk**,
not against the directory's declared uncompressed size. A declared size is a
claim by the attacker. Checking it and then inflating anyway is a check that
proves nothing; abandoning the stream the moment the running total passes budget
is what keeps peak memory bounded by the limit.

The model part is scanned by our own bounded scanner, never `DOMParser`. Before
a single element is read, `describeUnsafeXml` refuses any DOCTYPE, ENTITY,
SYSTEM or PUBLIC identifier. That is fail-closed by construction: the refusal
does not depend on a parser being configured correctly, and it cannot regress
when a platform default changes.

Build items and component instances are expanded depth-first with transform
composition, a path-set cycle detector and a depth cap of 16. A component graph
that would expand past the part ceiling is refused before the expansion, because
a syntactically tiny file can describe an enormous document.

Textures, materials and other resources CAD Fixer does not model are RECORDED
and reported, never dropped silently, and never fetched.

## Correction to ADR 0013: `unit` is optional and defaults to millimetre

ADR 0013's units table describes 3MF's `unit` as a "required attribute". It is
not: the 3MF core specification makes it optional with a default value of
`millimeter`. Production applies the default (`THREE_MF_DEFAULT_UNIT`), so a
3MF that omits the attribute reports millimetres.

This is not the "never invent a unit" rule being bent. The value comes from the
format's own definition of what an absent attribute means, not from a guess
about the user's intent — which is precisely the distinction that makes STL
different. STL has no unit field at all, so an STL genuinely states nothing and
CAD Fixer continues to say `Unspecified by STL`.

Coordinates are still never rescaled. The unit decides what the numbers mean, not
what they are, and a `<vertex x="1"/>` stores the same canonical value under
`inch` as under `millimeter`.

The research reader under `experiments/format-io/` does not model the default,
and has not been amended: its independence is the reason the differential suite
is worth running. The one deliberate divergence is asserted explicitly in
`format-differential.test.ts` rather than hidden behind a looser comparison.

## Meshes are shared, so identity has to survive the boundary

A 3MF that places one object a thousand times produces a thousand parts holding
ONE `CanonicalMesh` object. That sharing is structural — object identity, not
byte equality — and it survives `postMessage`'s structured clone, which
preserves shared references within a single message.

Everything downstream depends on it: `documentByteLength` counts each mesh once,
the render snapshot builds buffers per distinct mesh, and `SharedPartGeometry`
reference-counts the GPU geometry so disposing one part cannot free a buffer
another is drawing from. `assertMeshStructure` therefore runs per DISTINCT mesh
at import — validating per part would validate the same buffer a thousand times.

## The platform primitives are injected

`packages/file-formats` compiles with `lib: ES2023` and no DOM or Node types, on
purpose. `TextDecoder` and `DecompressionStream` are platform globals, so they
arrive on `FormatReadContext` as `decodeText` and `inflateRaw` instead. A codec
that could reach for them directly would stop being runnable under plain Node,
and the differential suite that compares production against the research readers
would stop being possible.

`inflateRaw` yields chunks rather than returning a buffer, and that signature IS
the bomb defence: a `Promise<Uint8Array>` would mean the allocation had already
happened by the time anything could object.

## One refusal taxonomy

Every refusal carries an `ImportRefusal` code in `AppError.details.reason`,
under the existing `AppErrorCode` categories. Around fifty codes, grouped by
where they arise — identification, OBJ, ZIP, XML, 3MF and shared. The interface
turns them into sentences; the tests assert the CODE, so a message can be
rewritten without weakening what a test proves.

## Untrusted text is untrusted everywhere

Object names, group names, material references, file names and every fragment of
parser text are rendered as text. Nothing uses `dangerouslySetInnerHTML`, and no
error message can carry archive, XML or OBJ content into markup. Browser tests
import an OBJ and a 3MF whose object names are `<img src=x onerror=…>` and
assert the payload appears as a text node and that no element was created.

## What this does not change

- Parsing is still not repair. Import preserves what the file contains: no
  welding, no dropping degenerate or duplicate triangles, no reorientation, no
  rescaling.
- Topology still diagnoses and never repairs, still per part, still from exact
  stored coordinates.
- Self-intersection is still intra-part. Two parts overlapping in world space
  are not self-intersecting and nothing checks whether they do.
- Export still writes one STL of one part and says so before the click.
- Nothing leaves the machine. No MTL fetch, no schema fetch, no texture fetch,
  no relationship resolution, no telemetry of any kind.
