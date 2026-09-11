# Resource Policy

Two different things get called "limits" and conflating them is how a product
ends up either refusing work it could do or attempting work it cannot finish.

- **Structural ceilings** are architectural. They are enforced in code, before the
  dangerous allocation, and they are frozen — Stage 5B may not raise them.
- **Release-qualified operating policy** is what has actually been measured to
  work on a supported host. It is smaller, and it is a statement about evidence.

Qualified in Stage 5B at commit `8a800b5e137602008eced0aef3fd9beee5bcfe9c`.

## Structural ceilings (frozen)

All enforced **before** the allocation they protect against.

| Subsystem                        | Ceiling                                         | Enforced in                                    |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| Input bytes, any format          | 512 MiB                                         | `budget.ts`, `obj/limits.ts`, `threemf/zip.ts` |
| STL triangles                    | 20,000,000                                      | `checkAllocation`                              |
| STL import peak                  | 1,536 MiB → **binds first, at ≈12M triangles**  | `checkImportPeak`                              |
| OBJ line / objects / groups      | 65,536 each                                     | `obj/limits.ts`                                |
| OBJ vertices                     | 40,000,000                                      | `obj/limits.ts`                                |
| OBJ face vertices                | 3 — n-gons refused, never fanned                | `obj-reader.ts`                                |
| 3MF archive / entries            | 512 MiB / 4,096                                 | `zip.ts`                                       |
| 3MF expanded total               | 512 MiB, charged **per chunk during inflation** | `InflationBudget`                              |
| 3MF compression ratio            | 200:1                                           | `zip.ts`                                       |
| 3MF objects / component depth    | 65,536 / 16                                     | `threemf-reader.ts`                            |
| XML elements / depth             | 80,000,000 / 64                                 | `xml-scan.ts`                                  |
| Document parts                   | 4,096                                           | `document.ts`                                  |
| Document triangles / vertices    | 20,000,000 / 60,000,000                         | `document-validation.ts`                       |
| Document geometry bytes          | 768 MiB                                         | `document-validation.ts`                       |
| Topology workspace               | 1,024 MiB → **≈4.8M faces**                     | `requestAnalysisWorkspace`                     |
| Self-intersection automatic band | 25,000 faces                                    | `policy.ts`                                    |
| Self-intersection hard ceiling   | 250,000 faces                                   | `policy.ts`                                    |
| Conservative repair peak         | 1,024 MiB                                       | `requestRepairPeak`                            |
| Hole-fill boundary vertices      | 512                                             | `mesh-hole-fill/limits.ts`                     |
| Hole-fill part faces             | 250,000                                         | `mesh-hole-fill/limits.ts`                     |
| Export output / serialised       | 256 MiB / 512 MiB                               | `export-contract.ts`, incrementally            |
| Render device pixel ratio        | **2**                                           | `create-viewport.ts`                           |

**These are not all the same number, and that is correct.** Different operations
have different memory profiles, so a model can legitimately be importable,
renderable and exportable while being too large for the self-intersection check or
for a hole fill. Feature-level refusal is the honest answer; rejecting an
otherwise useful model is not.

## The host question, answered

**Can an 8 GiB machine be a supported MVP host? YES**, for one active workspace,
with the feature-level limits above.

The evidence is specifically about _what kind of pressure_ matters. A 900,000-
triangle STL import:

| Condition                                                     | Result                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| **Four parallel Playwright browsers**, 65 MiB free, load > 30 | Fails; once the Chromium renderer was killed outright        |
| **One browser, one tab** (`--workers=1`)                      | **3 / 3 passed**, free RAM rising to 1.4 GiB during the runs |

So the failures Stage 5A recorded were **test-runner concurrency**, not normal
single-user behaviour — four simultaneous heavyweight browser jobs on an 8 GiB
machine is a CI condition, not a product condition. That distinction is the whole
finding, and it is why no ceiling was lowered on the strength of it.

### Selected model: **C — documented minimum host requirements**

Not A (a single fixed conservative ceiling) and not B (capability tiers), for a
reason that is about what browsers will tell us rather than about preference:

- **There is no reliable free-memory signal.** `navigator.deviceMemory` reported
  `8` in Chromium — deliberately coarsened — and is **not exposed at all** in
  WebKit. Nothing in a browser can measure available RAM.
- **A tiered policy needs a trustworthy signal to select a tier.** Without one,
  tiers would be a guess wearing a number.
- **Lowering the structural ceilings would need cross-machine evidence** that
  Stage 5B does not have, and guessing them downward would refuse work that
  demonstrably succeeds.

So: keep the enforced ceilings, state the host expectation plainly, and let the
existing pre-allocation refusals do their job.

### Minimum host expectation

- A desktop or laptop with **8 GiB RAM or more**
- A Chromium-based browser (see `BROWSER_SUPPORT.md`)
- **One active CAD Fixer workspace at a time** for large models. Independent tabs
  are fully isolated — separate workers, documents, revisions and histories — but
  two large models in two tabs double every buffer, and that was not qualified.

## Release-qualified reference workloads

| Workload                           | Status                                                              |
| ---------------------------------- | ------------------------------------------------------------------- |
| STL, 900,000 triangles             | Qualified, one tab. Import, render, topology, export                |
| Indexed OBJ, 160,801 V / 320,001 F | Qualified through repair, including the candidate representation    |
| 3MF, 1,000 shared placements       | Qualified: one canonical mesh, one GPU geometry, 240 bytes resident |
| Viewport 3840 × 2160 at ratio 2    | Qualified, ≈33.2 M pixels                                           |

## What a user sees at a limit

Refusals name the model and the operation, never the internals. The rule is that
copy must not claim knowledge the product does not have:

- **Allowed:** "This model exceeds CAD Fixer's limit for this check."
- **Not allowed:** "Your computer does not have enough memory." A browser cannot
  know that, so saying it would be a guess presented as a fact.

An operation refused on resource grounds leaves the document loaded, viewable and
**exportable**. A self-intersection refusal never prevents an export.

## Known boundary

A browser tab killed by the operating system under genuine memory exhaustion
cannot be caught by the application — no in-page code runs after the renderer
dies. Every ceiling above exists to make that outcome unreachable through normal
use, and the enforcement is pre-allocation so a refusal arrives before the
allocation that would cause it. But it is a boundary, not a guarantee, and it is
recorded here rather than glossed.
