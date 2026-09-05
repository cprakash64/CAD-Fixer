# 0017 — The format conversion workflow, and export-time unit assertion

Status: **Accepted and implemented.** Stage 4A-2B3.

Date: 2026-09-05

Completes the format track. ADR 0015 made three formats readable, ADR 0016 built
a validated export engine, and this makes both reachable: a user opens an STL,
an OBJ or a 3MF, chooses what to save it as, reads what that format will keep,
states a unit if the target needs one, and gets a validated file.

## What changed

```
Open STL / OBJ / 3MF
        ↓
Export / Convert                    ONE primary entry point
        ↓
Choose STL / OBJ / 3MF
        ↓
Compatibility report                derived from THIS document, not from the format's name
        ↓
Unit assertion, when required       3MF only, no default, no inference
        ↓
Review losses and transformations
        ↓
Validated export                    parse-back, unchanged from ADR 0016
        ↓
Local download
```

Three things are new: a whole-document STL writer, a deterministic conversion
compatibility policy, and an export-local unit assertion.

## Whole-document STL is a different operation from `model/export`

`model/export` writes ONE part — the selected one — and returns a warning naming
what it left out. That operation is unchanged and still exists, because nothing
else can extract a single part from a multi-part document.

`writeStlDocument` writes the WHOLE document, flattened into one triangle
stream, and goes through `exportDocument` with the same parse-back validation
OBJ and 3MF get. Flattening is exactly the kind of bug that produces a
well-formed file full of geometry in the wrong place, so it is validated rather
than trusted.

Two operations, two names in the interface. `Export / Convert…` is the primary
action; `Export active part as binary STL` is the smaller one, and it says
"part" in the heading, the note and both buttons. Two controls both called
"Export STL", one writing three parts and one writing a third of them, is the
ambiguity this stage exists to remove.

### The numeric contract

```
canonical Float32 local coordinate
    → Float64 applyPartTransform
    → Math.fround                (the single narrowing setFloat32 performs)
    → IEEE754 binary32 in the file
```

The facet normal is derived from the TRANSFORMED corners, never carried over: a
reflection reverses a triangle's geometric orientation, and a copied normal
would point into the solid. A degenerate triangle gets a ZERO normal — it has no
plane, and inventing a plausible direction would conceal a defect the file
should carry.

### The preflight is exact

Binary STL is fixed width, so `84 + n × 50` is the artifact's real size rather
than an estimate. The ceiling is `min(⌊(maxOutputBytes − 84) / 50⌋, 2³² − 1)` —
5,368,708 triangles at the 256 MiB output ceiling — and it is checked before the
single allocation, because that allocation is the whole file.

OBJ keeps a genuine LOWER bound (≈30 bytes per triangle) and 3MF gets no
preflight at all: its size depends on how well the XML compresses, and a
made-up bound would either refuse files that would have fitted or promise ones
that will not. The writers' incremental ceilings stay authoritative in every
case; a preflight only ever moves a refusal earlier.

## The compatibility report describes the DOCUMENT, not the target

`analyseConversion` is a pure function from a `DocumentFeatureProfile` — counts,
flags and short tokens, no geometry — plus a target and an optional unit
assertion, to a report of machine-readable FACTS.

"OBJ loses units" is a fact about OBJ. Whether THIS conversion loses a unit
depends on whether this document has one. A report that warned about flattened
parts on a one-part model, or about dropped names on a document with no names,
would teach a user that the list is noise — and the one time it mattered they
would not read it.

The verdict is a summary; the facts are the truth. Precedence is frozen and
total:

```
BLOCKED > UNSUPPORTED_INPUT_FEATURE > LOSSY_STRUCTURE > LOSSY_METADATA
        > LOSSLESS_FOR_SUPPORTED_FEATURES
```

`UNSUPPORTED_INPUT_FEATURE` is deliberately narrow: per-vertex attributes the
current document carries and no writer can write. A source-import warning does
NOT go there and does not touch the verdict — a texture that was never imported
is not something this conversion is doing, and letting it push a 3MF-to-3MF save
out of "lossless" would blame the target for a loss that happened on import.

### It is derived, never stored

The report is recomputed from the current model on every render. That is the
whole staleness answer: there is no stored report, so there is no window in
which one built at revision N can authorise an export at revision N+1. A repair,
an undo or a replacement import moves the document and the report recomputes
with it.

The profile comes from `PartDescriptor`s the page already holds — which is why
`PartDescriptor` gained `materialRef`, `groupCount`, `groupMaterialRefCount`,
`hasNormals` and `hasUvs`. All scalar; a thousand-part document pays a few
kilobytes.

### Source import warnings survive the import that produced them

Before this stage `ImportCompatibility.unsupported` reached a status entry and
then existed nowhere, so by the time a user opened Export the fact that their
3MF's textures were never imported was unrecoverable. It now lives on
`ModelSource` for the life of the model, is shown in its own section, and stays
put when the target changes. It is SOURCE metadata: not part of the document,
not part of any handle comparison, replaced wholesale by the next import.

The 3MF reader also now records `COMPONENT_HIERARCHY` when a part actually came
from inside a `<component>`. Every placement is imported in the right position;
the nesting is not retained and cannot be rebuilt on export. Recorded only when
it happened — a flat file gets no such note.

## Unit assertion is export-local and never rescales

3MF declares a unit for everything it contains. A document derived from an STL
or an OBJ declares none, and CAD Fixer will not choose one:

```
document.unit === undefined  ∧  target === 3MF  →  BLOCKED, REQUIRES_USER_ASSERTION
```

Nothing defaults to millimetres, and nothing infers a unit from a filename, from
the model's dimensions, from the source extension, from the viewport scale or
from what a printer usually expects. Six choices are offered — micron,
millimeter, centimeter, inch, foot, meter — with **no preselection**: the
`<select>` holds the empty string and its first option is a disabled
placeholder, because a select with no explicit value reports its first option
and that would be CAD Fixer asserting microns on the user's behalf.

Choosing a unit LABELS the numbers; it does not resize anything. A model 25
wide recorded as millimetres is 25 mm and as inches is 25 in — the same 25.

The assertion travels on the disposable snapshot and dies with it:

```
authoritative document   unit = undefined, revision unchanged
export snapshot          unit = millimeter, unitAsserted = true
artifact                 <model unit="millimeter">
```

`exportSnapshotOf` applies it ONLY when the document states no unit, and the
AUTHORITATIVE worker makes that decision — not the page, which holds a mirror
rather than the document. A document's own unit came from a file; a
conversion-time choice came from a person about a document that stated nothing,
and letting the second overwrite the first would silently relabel a known model.

The 3MF writer stays fail-closed: called without a unit it still refuses with
`BLOCKED_UNIT_REQUIRED`, whatever the interface believed. The UI is not the
guard.

Nothing in this stage converts scale. Inches to millimetres, "normalise for
printer" and automatic physical-size correction are all absent, deliberately:
this is format conversion, and a coordinate that changed to preserve a label
would be invented data.

## Exporting is a read

For every target: the revision does not move, the geometry bytes do not change,
transforms and part order do not change, shared geometry stays shared, and the
document's unit is whatever it was. There is no undo entry, because there is
nothing to undo. A download is not a document edit.

## One fact, one approved meaning

`analyseConversion` produces facts and says nothing about them.
`apps/web/src/state/conversion-presentation.ts` is the ONE place a fact becomes
a sentence, and its switch is exhaustive with no `default` — a new feature fails
to compile until someone words it.

Wording is a correctness concern here. The engine can emit a dropped-unit fact
while one screen says "Scale preserved" and another says "Units converted":
three statements, one truth, two of them false. The banned list includes both of
those by name, because:

> "The numbers are unchanged" and "the scale is preserved" are not the same
> statement.

The approved sentence says both halves — the file will not record the unit, AND
nothing was resized — because either half alone misleads.

Severity is proportionate. Only a blocker gets the strongest register; rendering
every expected format limitation as an alarm teaches people to dismiss the panel
unread, and then the one case that mattered is dismissed too. Every section
states its meaning in words, so nothing depends on colour.

## The serialisers stay behind the worker boundary

Making the engine reachable does not make it part of the page. The export worker
is constructed only when an export actually starts — opening the dialog,
choosing a target and picking a unit create no worker — and the writers live in
its chunk.

This was got wrong once and is worth recording: the compatibility policy needed
`84 + n × 50` and imported it from the STL writer, which imports `stl/detect.ts`,
whose ASCII keyword tables are built at module scope and therefore survive
tree-shaking. Kilobytes of parser shipped to every user so a dialog could
multiply by fifty. The constants now live in leaf modules that import nothing —
`export/stl-layout.ts` and `threemf/units.ts` — and a boundary test asserts both
that no main-thread file imports a codec by name and that those two leaves stay
importless.

Measured, production build:

| chunk                | before (4A-2B2)                 | after (4A-2B3)             |
| -------------------- | ------------------------------- | -------------------------- |
| `index.js`           | 866.80 kB (231.26 kB gzip)      | 895.32 kB (238.99 kB gzip) |
| `index.css`          | 15.13 kB                        | 18.43 kB                   |
| `geometry.worker.js` | 125.21 kB                       | 126.03 kB                  |
| `export.worker.js`   | not built — nothing imported it | 64.14 kB                   |

The +28.5 kB in the main bundle is the dialog, the hook, the policy, the copy
and the profile builder. The 64 kB of serialisation and parse-back is in the
export worker's own chunk, loaded when someone exports.

## 3MF property references

**Added in Stage 4A-2B3-R1**, which corrected a conformance defect this stage
shipped.

The writer emitted `<object pid="…">` carrying the document's opaque
`materialRef`. 3MF core defines `object@pid` as an `ST_ResourceID` — a positive
integer naming a property-group resource that must exist in `<resources>` — and
CAD Fixer writes no property resources at all. So:

```xml
<resources>
  <object id="1" type="model" name="Bracket" pid="5">   <!-- resource 5: absent -->
```

Every such file carried a dangling reference. Worse, a `materialRef` is an
opaque string, so a reference that did not originate as a number was not even
lexically an id — `pid="steel-brushed"` was real output.

**It survived every gate this stage had**, which is the part worth remembering.
The writer's own observations said `MATERIAL_REFERENCES_PRESERVED`. Parse-back
validation passed, because the reader accepted a dangling `pid` as an opaque
string and handed it back unchanged — writer and reader sharing one blind spot,
which is exactly the failure the independent oracles exist to catch, and the
oracle checked only ZIP structure, CRCs and XML well-formedness.

### The decision: drop it, and say so

Fabricating a `<basematerials>` to make the reference resolve was rejected. A
`materialRef` is an import-level string, not a material definition, so any
resource invented for it would state a colour and a name the user never gave —
substituting one falsehood for another. CAD Fixer has no qualified property
writer, so the honest MVP behaviour is:

- **no `pid` is emitted, ever** — for any target, from any document;
- geometry, placement, name and unit are unaffected;
- the compatibility report states the loss BEFORE the export, for all three
  targets;
- the verdict is at least `LOSSY_METADATA`, so a 3MF holding a material
  reference is no longer reported as lossless as 3MF.

### What now enforces it, at four independent points

1. The **writer** emits no property attribute and records
   `MATERIAL_REFERENCES_OMITTED`.
2. **Parse-back validation** asserts the reference's ABSENCE. It previously
   asserted its presence, which is how a malformed file passed.
3. The **independent oracle** validates the resource id space: ids are lexically
   positive integers, unique across the whole space, and every `object@pid`,
   `triangle@pid`, `item@objectid` and `component@objectid` resolves — a `pid`
   pointing at an OBJECT is rejected too, which a naive "does this id exist"
   check would not catch. A deliberately mutated fixture proves it rejects.
4. The **reader** distinguishes an unsupported property resource from a dangling
   one. `pid="7"` with a `<basematerials id="7">` is a valid file whose materials
   are not imported; `pid="7"` with no such resource is
   `THREEMF_DANGLING_PROPERTY_REFERENCE`, and a `pid` that is not a positive
   integer is `THREEMF_MALFORMED_RESOURCE_ID`. Both are checked lexically rather
   than by coercion, because `Number` accepts `7`, `0x7` and `1e3`.

References are resolved AFTER the scan, so declaration order cannot refuse a
valid file.

### Sharing no longer splits on it

The 3MF object plan keyed on (mesh, name, material reference) — correct while a
`pid` was written. Now that nothing is written, the key is (mesh, name): the rule
is exactly "the key holds what the `<object>` element will carry". A thousand
placements of one mesh under one name remain one object even if every one of
them names a different material.

## Name sanitization is disclosed

**Added in Stage 4A-2B3-R1.** OBJ has no escape mechanism — a control character
in a name would end the record and turn the rest into geometry — and XML cannot
carry most control characters at all. Both writers already removed them
correctly; neither told the user, and this stage originally recorded that as a
known limitation because the profile deliberately holds no names.

It is now disclosed as a COUNT. `namesUnwritableAsObj` and
`namesUnwritableAsXml` are computed with the writers' OWN predicates —
`objNameChangesOnWrite` and `xmlTextChangesOnWrite`, from leaf modules that
import nothing — so the disclosure cannot disagree with the file. The
compatibility fact is `NAME_CHARACTERS`, carrying a number and nothing else: a
fact holding a name would put untrusted text one render away from markup and
create a second place display copy lived.

STL is excluded deliberately. It writes no names and already says so; a warning
that some of them would have been adjusted describes a change to something that
is not written.

## Consequences

- The nine source/target combinations are all supported, and the three-format
  MVP conversion matrix is complete.
- `ExportRefusal.UnsupportedTarget` moved from `exportDocument` — where every
  `MeshFormatId` is now writable and the guard was type-dead — to
  `resolveExportTarget`, which is where an untrusted target STRING arrives.
- STL export exists twice on purpose, named apart. If a later stage finds the
  active-part export unused, it can go; it is kept because nothing else extracts
  one part.
- Group data is dropped by the 3MF writer as well as by STL, and the report says
  so. That is a fact about this writer rather than about the format, and
  claiming "3MF keeps everything" would be exactly the false lossless claim this
  report exists to prevent. Part material references are the same case, and were
  the one this stage got wrong before R1.
- An independent oracle only helps where it looks. The 3MF oracle was thorough
  about the container and silent about semantics, so it passed a file with a
  reference to nothing. When a defect gets through, the question worth asking is
  which oracle should have caught it — not only how to fix the writer.
