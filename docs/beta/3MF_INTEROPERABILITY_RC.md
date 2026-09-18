# 3MF interoperability — v0.1.1 RC1

> **SUPERSEDED IN PART BY STAGE 6D-A2.** The decision recorded below — Policy A,
> strict `requiredextensions` — was right while CAD Fixer implemented none of
> the production extension. A2 implements the reachable cross-part subset, so a
> required PRODUCTION declaration no longer refuses; every other extension still
> does, and the corpus was re-run with zero compatibility regressions.
> `production_ext.3mf` now imports. See the Stage 6D-A2 section of
> `docs/design/STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md`. The
> structural findings and the source-code evidence below stand unchanged.

Evidence for the one release-blocking question raised by Stage 6B-C1: does
refusing an unsupported `requiredextensions` declaration break real slicer files
that v0.1.0 accepted?

**Answer: no.** Across the corpus below there is no file that v0.1.0 imports and
the candidate refuses. There is one file that both refuse, where the candidate's
refusal is truthful and v0.1.0's was not.

Candidate `db57364e899c61411f9993383d45c1ada6cb5bfb`. Released product remains
`v0.1.0 → 2800cec482d57fabafc74678785e2dd37eb4b9db`.

---

## What was and was not tested

**No slicer is installed on the qualification machine**, so nothing here was
exported by driving an application. That distinction is kept sharp on purpose.

| Producer     | Application driven | Real files tested | Source code analysed |
| ------------ | ------------------ | ----------------- | -------------------- |
| PrusaSlicer  | NOT TESTED         | 6                 | yes                  |
| OrcaSlicer   | NOT TESTED         | 1                 | yes                  |
| Bambu Studio | NOT TESTED         | 0 — NOT TESTED    | yes                  |
| Cura         | NOT TESTED         | 0 — NOT TESTED    | no                   |

The files are real 3MF packages authored by the producers and carried in their
own public source repositories, five of them stamped with a PrusaSlicer version
in their own metadata. They are **not** fresh exports from installed
applications, and no file in this corpus is claimed to be a Bambu Studio export.

Nothing from the corpus is committed to this repository. The regression tests
derived from it are tiny synthetic equivalents.

---

## Structural findings

| File                   | Producer metadata | `.model` parts | `requiredextensions` | `path` attributes |
| ---------------------- | ----------------- | -------------- | -------------------- | ----------------- |
| `prusa_fdm_roundtrip1` | PrusaSlicer-2.9.6 | 1              | absent               | none              |
| `prusa_fdm_roundtrip2` | PrusaSlicer-2.9.6 | 1              | absent               | none              |
| `prusa_sla_roundtrip1` | PrusaSlicer-2.9.2 | 1              | absent               | none              |
| `prusa_sla_roundtrip2` | PrusaSlicer-2.9.2 | 1              | absent               | none              |
| `prusa_wipe_tower`     | PrusaSlicer-2.9.0 | 1              | absent               | none              |
| `production_ext`       | (repo fixture)    | 2              | **`p`**              | **1, on an item** |
| `orca_buechse`         | (none)            | 1              | absent               | none              |

**Every real file is either Case A (declares nothing, uses nothing) or Case B
(declares and uses).** No file declared the production extension without using
it. That is the case the release blocker was about, and the corpus contains none.

---

## Why that is structural, not luck

The producers couple the declaration to the use, in code:

- **Bambu Studio** and **OrcaSlicer** write `requiredextensions="p"` only when
  `m_production_ext` is set, and `m_production_ext` is only ever set through
  `SaveStrategy::SplitModel` — `SplitModel = 0x1000 | ProductionExt`, so
  splitting implies the extension but not the reverse. No call site in either
  codebase passes `ProductionExt` on its own. When `SplitModel` is set, every
  object is given a non-empty `sub_path` of `3D/Objects/object_N.model`, and the
  component writer emits `p:path` for exactly those non-empty paths.

- **PrusaSlicer** writes the same attribute under `use_production_extension`,
  and guards mesh storage with `if (!param.use_production_extension)` — so when
  the extension is declared, the meshes are deliberately _not_ in the root
  model, and a `path` is the only way to reach them.

So in all three, declaring the extension means the geometry has actually moved
out of the root model part. A file that declares it and is still readable as
baseline 3MF is not something these producers emit.

This is source-code evidence about what the producers _can_ emit, which is
stronger than a sample in one respect and weaker in another: it shows the
conditions rather than one outcome, but it is only as current as the branches
read (BambuStudio `master`, OrcaSlicer `main`, PrusaSlicer `master`).

---

## v0.1.0 versus candidate

| File                   | v0.1.0                                                                 | Candidate                                        | Verdict      |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ | ------------ |
| `prusa_fdm_roundtrip1` | imports, 2 parts                                                       | imports, 2 parts                                 | unchanged    |
| `prusa_fdm_roundtrip2` | imports, 2 parts                                                       | imports, 2 parts                                 | unchanged    |
| `prusa_sla_roundtrip1` | imports, 1 part                                                        | imports, 1 part                                  | unchanged    |
| `prusa_sla_roundtrip2` | imports, 1 part                                                        | imports, 1 part                                  | unchanged    |
| `prusa_wipe_tower`     | imports, 1 part                                                        | imports, 1 part                                  | unchanged    |
| `orca_buechse`         | imports, 1 part                                                        | imports, 1 part                                  | unchanged    |
| `production_ext`       | **refused `MALFORMED_FILE`** — "builds an object which does not exist" | refused `UNSUPPORTED_FILE` — names the extension | **improved** |

**Compatibility regressions: 0.**

`production_ext` is the finding that matters. v0.1.0 did not import it either —
it refused it _and told the user their file was broken_. That is BETA-001,
reproduced on a real producer-authored package rather than on a constructed
case, and it is what the candidate fixes.

---

## Truth table, measured against the candidate

| Case | `requiredextensions` | Production semantics used | Candidate outcome                             |
| ---- | -------------------- | ------------------------- | --------------------------------------------- |
| A    | absent               | none                      | imports                                       |
| B    | production           | `p:path` used             | refuse `THREEMF_UNSUPPORTED_EXTENSION`        |
| C    | production           | none                      | refuse `THREEMF_UNSUPPORTED_EXTENSION`        |
| D    | absent (declared)    | none                      | imports                                       |
| E    | absent (declared)    | `p:path` used             | refuse `THREEMF_MULTI_MODEL_PART_UNSUPPORTED` |
| F    | unknown extension    | unknown                   | refuse `THREEMF_UNSUPPORTED_EXTENSION`        |
| G    | unresolvable prefix  | unknown                   | refuse `THREEMF_UNSUPPORTED_EXTENSION`        |

Case C is the only one the corpus does not exercise, because no real file has
that shape.

---

## Decision

**Policy A — strict required-extension semantics. No code change.**

The concern was real enough to test and did not survive testing. Keeping the
strict behaviour also keeps the rule simple: what the file says it needs is what
CAD Fixer honours, with no per-extension exception list to maintain and no
judgement about which declared requirements are safe to ignore.

**Policy B is not adopted**, and would have been a narrowing of a safety
property bought with no demonstrated compatibility gain.

### What would reopen this

A real file that declares the production extension and carries no `path`
attribute — Case C — from any producer. If one appears, Policy B becomes the
right answer for the production extension specifically, and unknown extensions
stay fail-closed regardless. The shape to check for is recorded above so the
question can be settled from structural metadata alone.
