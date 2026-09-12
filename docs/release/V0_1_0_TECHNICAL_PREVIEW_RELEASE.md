# CAD Fixer v0.1.0 — Technical Preview

**Public URL:** <https://fixcad.thelunai.com>

**Status:** Technical Preview. Not a 1.0, and not a beta with broad browser
support. Everything below describes what has actually been qualified.

## What CAD Fixer does

CAD Fixer inspects and repairs 3D printing meshes **entirely inside your
browser**. It reads and writes **STL, OBJ and 3MF**, and covers:

- **Mesh health analysis** — boundary edges, non-manifold edges and vertices,
  winding conflicts, degenerate and duplicate triangles, reported separately
  rather than collapsed into one verdict.
- **Conservative repair** — four named, deterministic operations, each with a
  stated decision and reason, shown as a before/after preview you Apply or
  discard.
- **Planar opening fill** — closes one selected opening at a time, proven simple
  and planar, adding no vertices.
- **Self-intersection diagnostics** — a read-only check using an exact-predicate
  geometry kernel.
- **Format conversion and export** — with a compatibility report that states
  what a target format cannot carry, before you export.
- **Preview, Apply and Undo** on every change that touches geometry.

## Privacy

**Your model never leaves your browser.**

CAD Fixer is a static site. There is no upload endpoint, no server-side
geometry processing, no account and no database. Parsing, analysis, repair and
export all run locally in Web Workers on your own machine.

This is measured rather than asserted: a representative session — load, import,
analyse, export — issues **six requests, all `GET`, all to this site's own
origin, none carrying a request body**. No analytics, no telemetry, no session
replay, no third-party script.

The web server keeps ordinary access logs (URL, IP, user agent), as any web
server does. That is categorically different from transmitting geometry, and no
model data appears in them.

## Supported environment

Qualified and supported:

- **Chromium-based desktop browsers** (Chrome, Edge, and similar)
- **8 GiB minimum** system memory
- **One large workspace at a time** per browser
- **Minimum editor width 900 px**
- Display scaling capped at **2×**

Not release-qualified: **Firefox**, **Safari**, and **mobile or touch devices**.
They are not blocked, but they have not been qualified and are not supported in
this preview.

CAD Fixer requires cross-origin isolation to use `SharedArrayBuffer`. This site
serves the necessary headers; a mirror that does not will fail closed rather
than silently degrade.

## Known limitations

Stated plainly, because a preview that oversells itself is worse than one that
does not:

- **Repair is conservative and bounded.** Four specific operations — not
  arbitrary mesh repair. It never welds by tolerance, never fills boundary loops
  as if they were defects, and never removes reversed duplicate faces, which can
  encode intentional zero-thickness features.
- **Opening fill is planar and one at a time.** Non-planar openings are refused
  rather than approximated, and there is deliberately no "fill everything"
  action — that would close intentional openings too.
- **Self-intersection is a diagnostic, not a repair.** CAD Fixer reports
  crossings; it does not resolve them.
- **Mesh health is exact-coordinate topology only.** Wall thickness, printability
  and manufacturability are **not** assessed. CAD Fixer will never tell you a
  model is "printable" or "watertight", because it does not check those things.
- **Undo is one step** per model, and there is no redo.
- **No unit conversion.** Units are reported, never invented or rescaled.
- **A recovered WebGL context requires a page reload.**
- Not implemented in this preview: splitting, hollowing, drainage holes,
  texturing, booleans, remeshing.

## Release provenance

|                  |                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release tag      | `v0.1.0`                                                                                                                                                                      |
| Public URL       | <https://fixcad.thelunai.com>                                                                                                                                                 |
| Package versions | unchanged at `0.0.0` — every workspace package is `private`, none is published, and no version string is user-visible. **The Git tag is the authoritative release identity.** |

The release artifact is **8 files, 2,569,581 bytes**: the HTML shell, one
application bundle, one stylesheet, four browser Web Workers, and the geometry
kernel WebAssembly module. Source maps are built but deliberately not published.

Provenance is verified end to end at release time:

```
Git tag  →  release commit  →  release manifest source SHA
         →  immutable SHA-named server release directory
         →  the `current` symlink
         →  the bytes actually served over HTTPS
```

Every runtime file's SHA-256 is compared at each step, and the shipped kernel
hash is pinned.

## How this was qualified

- **Cross-origin isolation measured on the live site** at seven resources
  including the WebAssembly module and two 404 responses — not inferred from
  configuration.
- **Full end-to-end suite run against the deployed origin**, not only locally.
- **Byte identity** between the reviewed commit and the bytes served.
- **Rollback rehearsed** on the real server before launch.
- **Reboot recovery proven** by an actual reboot: the web server returned
  automatically and every site recovered.

## Operational notes

Deployment is an immutable, SHA-named release directory activated by an atomic
symlink switch, so rollback is a pointer change with no rebuild and no
re-upload. The previously qualified release is retained as the immediate
rollback target.

## Feedback

This is a Technical Preview. If CAD Fixer refuses something it should handle, or
reports something you believe is wrong, the refusal reason and the model that
produced it are the most useful things to report.
