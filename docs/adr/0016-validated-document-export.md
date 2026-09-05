# 0016 — Validated OBJ and 3MF export

Status: **Accepted and implemented.** Stage 4A-2B2.

Date: 2026-09-05

Builds the export ENGINE that ADR 0013 designed, on the readers of ADR 0015 and
the document layer of ADR 0014. It does not build the user-facing conversion
workflow; that is Stage 4A-2B3's, and this ADR deliberately decides nothing
about how a loss is worded.

## What changed

`GeometryDocument` can now be written as OBJ or 3MF bytes, and no such export
succeeds until the bytes have been read back and compared.

```
document (worker-resident)
        ↓  exportSnapshotOf           one copy per DISTINCT mesh
ExportDocumentSnapshot
        ↓  MessageChannel             worker → worker, never through the page
export worker
        ↓  writeObjDocument / write3mfDocument
bytes
        ↓  readObj / read3mf          the PRODUCTION reader, production limits
parsed document
        ↓  validateObjRoundTrip / validate3mfRoundTrip
WrittenDocument  →  the page  →  Blob  →  download
```

STL export is untouched. It writes ONE part and states what it left out; that is
a different operation with a different contract, and folding it into this path
would mean either flattening a document silently or teaching the document
exporter a special case that is not about documents.

## The page never holds geometry; it does hold the artifact

Two hops, the same shape the self-intersection channel uses. The controller
creates a `MessageChannel`, hands one port to the authoritative worker and one
to a disposable export worker, and the snapshot travels between them. What comes
back to the page is the finished FILE.

That is not a weakening of ADR 0008. A serialised artifact is what the user
asked to save; it cannot be edited back into the model, and holding it is
exactly as risky as holding the file they already had on disk.

The snapshot is a COPY, not the authoritative arrays. Transferring would detach
them, leaving the worker holding empty buffers and making a terminated export
worker take the user's model with it.

## Cancellation is termination

Serialising, compressing and reading back are long allocating passes, and part
of that time is inside `CompressionStream`, which polls no flag of ours. A
Cancel button backed only by a cooperative token would be honest for the writer
loops and a lie for the compressor. So the export worker is disposable and
Cancel kills it; the writers still yield between batches, which is what keeps
the thread able to be killed promptly.

One export at a time, deterministically. Two concurrent fifty-megabyte
serialisations would compete for exactly the memory the ceilings were sized
against, and both would publish into the same slot.

## Output ceilings, derived rather than chosen

`maxSerialisedBytes` is 512 MiB — `DEFAULT_ZIP_LIMITS.maxTotalUncompressedBytes`
and `DEFAULT_OBJ_LIMITS.maxBytes`. An export our own reader would refuse to open
is not an export: parse-back runs the production reader, so anything past the
reader's intake ceiling could never be validated and must not be produced.

`maxOutputBytes` is 256 MiB, half of that. During a validated export the
artifact, the snapshot and the parsed-back document are all live at once, so the
artifact gets half the intake ceiling and the rest is headroom.

Both are enforced INCREMENTALLY. `createByteSink` checks the prospective total
before retaining an encoded chunk, and the ZIP writer checks before retaining a
compressed one — accounting first and refusing afterwards makes the real peak one
buffer larger than the ceiling claims. The OBJ writer also runs a preflight from
a genuine LOWER bound (thirty bytes a triangle, shorter than any triangle can be
written), so an obvious impossibility is refused before anything is built.

## OBJ bakes transforms, and says so

OBJ has no structural transform, so a placement survives only by being applied to
the coordinates. Baking happens in the export representation; the authoritative
mesh is not even in that worker.

The numeric contract is exact rather than approximately right:

```
Float32 local  →  Float64 applyPartTransform  →  Math.fround  →  9 significant digits
```

`Math.fround` is the same single narrowing that assignment to a `Float32Array`
performs, which is what the reader will do to the decimal text. Nine significant
digits is ADR 0013's measured value: across 200,019 finite Float32 values
`toFixed(6)` failed to round-trip 50.7% of them. Negative zero is written
explicitly, because `(-0).toPrecision(9)` returns `+0` and `-0` is observable.

`expectedObjRoundTrip` states the losses precisely — transforms baked, unit
unknown, an unnamed part given `o part-N` — so the validator compares against
what an OBJ export IS rather than against a document it cannot be. Claiming
local-coordinate equality would fail for every placed part, and loosening the
comparison to make that pass would stop the validator noticing a dropped
placement at all.

## 3MF preserves what it can, and splits only when it must

One distinct mesh becomes one `<object>`; every part that uses it becomes a
`<build><item>`. A thousand placements serialise the geometry once — measured at
7 ms and 40 KiB, against OBJ's 1,355 ms and 38 MiB for the same document.

The grouping key is (mesh, name, material reference), because all three live on
the `<object>` in 3MF rather than on the `<item>` that places it. Two placements
of one mesh under two different names are, in 3MF's own model, two objects: the
geometry is written twice and both names are kept, because dropping a name the
user gave is the larger loss. The split is recorded as
`STRUCTURAL_SHARING_SPLIT_BY_METADATA`.

The imported nested component graph is NOT reconstructed. A `GeometryDocument`
holds leaf placements and mesh identity; the hierarchy above them is not
retained, and inventing a plausible one would describe a structure the user never
wrote. Output is canonical — mesh objects plus build items — and reads back as
the same document.

Transforms are Float64 in and Float64 out, written with the shortest
exactly-reparsable decimal form. Narrowing them to Float32 on the way through
text would add an error the source never had.

## A 3MF needs a unit, and CAD Fixer will not invent one

`document.unit === undefined` is `BLOCKED_UNIT_REQUIRED`, never `millimeter`.

This is not in tension with the reader's millimetre default. A 3MF that omits the
attribute HAS stated millimetres, because the specification defines what an
absent attribute means. A document derived from an STL or an OBJ has said nothing
at all — one is reading a fact, the other would be inventing one. Stage 4A-2B3
lifts the block by ASKING.

OBJ has the mirror-image case: it can state no unit, so a known unit is lost.
The coordinates are NOT rescaled to compensate; changing the numbers to preserve
a label the file cannot hold would be changing the user's model to protect a
claim about it.

## Validation is mandatory and has no switch

Every successful export has been read back by the production reader, under
production limits, and compared. There is no "skip validation for faster export"
option and there is not going to be one: the whole value of an exporter is that
the file opens somewhere else, and the only evidence obtainable locally is that
it opens here. It costs roughly 37–45% of an export, measured.

The comparison is on SEMANTICS. For 3MF that is full equality — unit,
coordinates, indices, transforms, names, material references and the sharing
between parts — because 3MF loses nothing this layer holds, so any difference is
a writer bug. For OBJ it is against `expectedObjRoundTrip`, and it compares
triangle-corner COORDINATES rather than position arrays, because a reader
renumbers a part's vertices in first-use order and drops any vertex no face
refers to — both correct, and both change the array without changing the model.

## Independent oracles, because agreement is not correctness

Parse-back uses our reader on our writer. That is the right check and it is not
sufficient: a shared misunderstanding is invisible to it. A writer emitting
zero-based face indices and a reader accepting them would round-trip perfectly
and produce a file no other tool could read.

So the test suites also inspect the artifacts structurally with code that shares
nothing with production. `obj-oracle.ts` counts records with a deliberately dumb
line scan and checks that every face index is positive, integral and in range.
`threemf-oracle.ts` re-derives the archive from its CENTRAL DIRECTORY, verifies
each entry's CRC against its inflated bytes, checks the local and central headers
agree, and checks the model XML for balance, escaping and the absence of DOCTYPE,
entities and external identifiers. A test corrupts a CRC to prove the oracle is
not vacuous.

## Machine-readable observations, not sentences

`ExportObservation` records what a writer did: transforms baked or preserved,
unit omitted or preserved, sharing flattened, preserved or split, names
preserved or generated, normals and texture coordinates omitted, component
hierarchy not reconstructed, material library omitted.

Stage 4A-2B3 turns these into a compatibility report a user reads before
deciding. Deciding the wording here would put the same copy in two places and
guarantee they drift, which is the mistake `repair-presentation.ts` exists to
prevent.

## Normals and texture coordinates are omitted

CAD Fixer recomputes normals for display and stores none it trusts — the same
reason STL facet normals are dropped on import. Writing `vn` records would claim
a fidelity the product does not have, and would additionally need a normal-matrix
argument for non-uniform scale that nothing here has made. UVs are not stored
reliably either. Both omissions are recorded rather than passed over.

## No user-facing export yet

The service and the writers exist and are fully tested; the only caller is the
end-to-end harness bridge, which is not in the application build. There is
deliberately no production URL, query parameter or hidden control that reaches
them. The existing STL export is unchanged, and the Convert workflow is still
visibly unavailable.

## What this does not change

Import in every respect, the document layer, repair, topology,
self-intersection, STL export, the absence of any network call, and the rule
that raw geometry stays local. The artifact is created as a `Blob` on the user's
own machine and handed to the browser's own download mechanism.
