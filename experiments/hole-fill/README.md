# Stage 4B-1A — hole-filling qualification

**RESEARCH ONLY.** Nothing here is imported by `apps/**` or `packages/**`, and
nothing here is in any product bundle. Run it with plain `node`.

```bash
node experiments/hole-fill/run-matrix.mjs     # Candidate B, in-house
node experiments/hole-fill/run-pmp-all.mjs    # Candidate A, PMP, one process per fixture
```

Recorded output is in `results/`.

## What this stage had to decide

Hole filling is the first CAD Fixer repair that **manufactures geometry that
was not in the user's file**. Everything conservative repair does is
subtractive or a relabelling; a patch is new surface, and a patch that looks
plausible can be wrong in ways no boundary-edge count will reveal.

So the question was never "can a library close a loop". It was: which openings
can be closed _provably_ safely, by what, and how do we know afterwards.

## Files

| file                              | what it is                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `boundary-loops.mjs`              | ordered boundary-loop extraction, eligibility refusals, stable loop identity                                                 |
| `ear-clip.mjs`                    | Candidate B — in-house triangulation for proven-planar loops, plus the planarity policy                                      |
| `validate.mjs`                    | independent post-fill validation: provenance, topology, orientation, connectivity, patch-attributed self-intersection, Euler |
| `fixtures.mjs`                    | HF01–HF30, analytic where possible                                                                                           |
| `run-matrix.mjs`                  | Candidate B over the corpus                                                                                                  |
| `run-pmp.mjs` / `run-pmp-all.mjs` | Candidate A over the corpus, one process per fixture                                                                         |

## The three findings that decided the recommendation

**1. PMP traps, and a trap is not catchable.** On HF11 — a legal, planar,
simple 512-vertex boundary loop — `pmp::fill_hole` raised
`RuntimeError: memory access out of bounds` inside the WASM module. The
binding's `catch (...)` does not run, the module's linear memory is left
undefined, and an attempt to recover in-process aborted Node outright. That is
why `run-pmp-all.mjs` spawns one process per fixture: it is the same
containment argument that decides the production worker architecture.

**2. PMP is not append-only, and refines heavily.** It preserved the source
prefix on small fixtures and **lost it** on HF10 and HF23. It also adds
vertices at a rate that grows fast with loop size: a 32-vertex loop gained 69
vertices and 168 faces; a 128-vertex loop gained 1,193 vertices and 2,512
faces. `pmp::fill_hole` is triangulate-plus-refine, not minimal triangulation.

**3. The independent validator catches what topology cannot.** HF25 is a
boundary loop that is flat, simple, manifold and completely ordinary — and
whose correct-looking two-triangle patch passes straight through an internal
wall. Every topological postcondition passes, Euler is right, the patch is
wound correctly. Only the patch-attributed intersection test rejects it. Its
neighbour HF26 puts the same wall 0.001 below the patch and is correctly
accepted, so the check is not simply "refuse anything nearby".

## Two mistakes worth recording

Both were mine, and both were caught by measurement rather than by reasoning.

**A sinusoid around a circle is not a warp.** HF06 and HF07 were built with
`z = A·sin(theta)` and were meant to be non-planar. Around a circle of radius
`r` that is exactly `z = (A/r)·y` — a **tilted plane**. The planarity policy
measured 8e-9 relative deviation and accepted them, correctly. They now use the
second harmonic, which genuinely leaves the plane.

**Orientability is a kernel precondition CAD Fixer must check itself.** The
prism fixtures were first built with a cap wound the same way as the skirt
along shared edges, so the surface was not consistently orientable. PMP refused
every one of them with a topology exception. CAD Fixer's own boundary walk
accepted them and produced a geometrically correct patch — because an
orientation conflict on an _interior_ edge does not disturb the boundary loop.
The two disagreed, and the kernel was right about its own precondition. A
production path must validate orientability before handing anything to a
kernel; the boundary walk will not notice.
