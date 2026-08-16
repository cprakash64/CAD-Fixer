# Geogram licence build gate — audit evidence

Stage 3A-2. **Engineering evidence, not legal advice.**

Stage 3A-1 gated Geogram on proving that its bundled `tetgen` (AGPL-3.0) and
`triangle` (commercial distribution only by direct arrangement with the author)
never enter our build. This records the proof.

## Result

**GATE PASSED.** Neither component was compiled, archived, or linked.

The audit is run **inside `geogram/build.sh`**, before any artifact is produced,
and the script exits with `BLOCKED_BY_BUILD_LICENSE_GATE` on failure. It is not
a step someone has to remember.

## Method — build inputs, not just the artifact

A `.wasm` string scan is secondary evidence: an optimising toolchain strips
symbols, so a clean scan is consistent with forbidden source having been
compiled and linked. The audit therefore reads what the build actually consumed:

| Evidence                | Content                                                |
| ----------------------- | ------------------------------------------------------ |
| `compile_commands.json` | 204,481 bytes, 146 translation units                   |
| Object files            | 146                                                    |
| Static archives         | 1 (`libgeogram.a`)                                     |
| Link inputs             | `link.txt`, `includes_C.rsp`, `includes_CXX.rsp`       |
| CMake cache             | `GEOGRAM_WITH_TETGEN=OFF`, `GEOGRAM_WITH_TRIANGLE=OFF` |
| Artifact                | `geogram-candidate.wasm`, symbol scan (secondary)      |

It **fails closed**: missing compile commands, missing objects, or missing
option values are all failures, because an audit that cannot see the build
inputs has established nothing.

## Positive evidence, not just absence

The audit requires the options to be _recorded as OFF_, rather than merely
failing to find a forbidden path. "I did not find the bad thing" is a weaker
claim than "the build recorded that the bad thing was disabled".

## Third-party components that DID compile

35 translation units from `third_party/`, none of them gated:

| Component      | Units | Licence position                                  |
| -------------- | ----- | ------------------------------------------------- |
| `zlib`         | 15    | zlib licence — permissive; attribution obligation |
| `OpenNL`       | 13    | BSD, © Inria                                      |
| `PoissonRecon` | 4     | permissive (Kazhdan)                              |
| `libMeshb`     | 1     | to audit before production                        |
| `rply`         | 1     | MIT                                               |
| `xatlas`       | 1     | MIT                                               |

`tetgen`: **0 units.** `triangle`: **0 units.**

Each surviving component carries an attribution obligation that must be
discharged before any production use. Recorded here so it is not forgotten;
none of them is a blocker.

## Symbol-level confirmation

- `delaunay_tetgen.cpp.o` — 445 bytes, containing exactly one symbol:
  `dummy_delaunay_tetgen_compiled`. The empty-translation-unit marker; the
  TetGen path compiled to nothing.
- `delaunay_triangle.cpp.o` — 333 bytes, **no symbols at all**.
- `tetgenmesh` / `tetgenio` / `triangulateio`: **0 occurrences** in the archive
  and in the artifact.
- The only `tetrahedralize` symbol is `GEO::mesh_tetrahedralize`, Geogram's own
  BSD-licensed function.

## A false positive the audit produced, and the correction

The first version of this audit **failed a clean build**. Its single finding
was:

```
[link-input] tetgen: //Tetrahedral mesher (Hang Si's TetGen)
```

That line is `CMakeCache.txt` line 335 — the **help text** CMake records above
every option. Line 336 is `GEOGRAM_WITH_TETGEN:BOOL=OFF`. The audit had flagged
the documentation of a disabled option.

Two defects, both in the audit:

1. It scanned CMakeCache comment lines. Comment lines are now skipped.
2. Its `tetgen`/`triangle` patterns were unanchored, so they also matched
   Geogram's own BSD wrapper files (`delaunay/delaunay_tetgen.cpp`) and
   unrelated code (`mesh/triangle_intersection.cpp`). Patterns are now anchored
   to `third_party/<component>/`, which is where the licensed code actually
   lives.

The correction made the gate **stricter overall**, not laxer: it additionally
requires positive option evidence and adds symbol-level artifact checks. A
negative control — the same build tree with `GEOGRAM_WITH_TETGEN` flipped to
`ON` — still fails:

```
[cmake-option] GEOGRAM_WITH_TETGEN is ON, expected OFF
RESULT: FAIL — BLOCKED_BY_BUILD_LICENSE_GATE
```

Being wrong in the permissive direction would have been the dangerous failure;
being wrong in the strict direction would have disqualified a viable candidate
on a comment string. Both are wrong, and the fix addresses both.

## Standing conclusion

The Geogram artifact used in this bakeoff is free of the two gated components.
That statement covers **this build configuration only**. Any change to the
Geogram build — a new option, a new code path, a version bump — invalidates it
and requires re-running the audit, which is why the audit lives inside the build
script.
