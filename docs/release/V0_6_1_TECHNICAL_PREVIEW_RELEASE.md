# Pybrix v0.6.1 Technical Preview

**Live product:** <https://pybrix.com>

A patch release. It changes how Pybrix describes the result of a repair. It does
not change what Repair does to a model.

## Clearer Repair results

In v0.6.0 every applied repair was headed "Conservative repair applied", in
green, even when the repair could fix only part of a model. Beside a Health line
that still showed errors, that read as a repair which claimed to have fixed the
model and had not.

- **Repair now says whether it was complete or partial.** "Repair completed"
  appears only when the checks Pybrix runs detect nothing further in the
  repaired mesh. If anything is still detected the result is headed "Partial
  repair completed".
- **What was fixed and what still needs attention are shown separately.** Each
  remaining condition is listed with its own count and with what Pybrix can do
  about it. Unlike quantities are never added into one total.
- **Health says when errors or warnings remain.** After a partial repair it
  reads, for example, "1 error · 2 warnings remaining". Health always describes
  the model as it is now; it does not turn green because a repair ran.
- **The Repair button explains itself.** When Pybrix has made every safe
  automatic repair it currently supports, the disabled button says so, and its
  ⓘ names what is still detected.
- **Undo, or opening another model, clears all of it.**

The Activity log no longer reports a single "issues found" number that added
different kinds of thing together; it uses the same wording as Health.

## What did not change

Repair geometry is exactly as in v0.6.0: the same operations, the same
eligibility rules, the same checks and the same results. On the ~2M-triangle
model used to qualify v0.6.0 the repair still fills two eligible openings
(1,988,877 → 1,988,883 triangles) and still leaves 11 open boundaries, 155
non-manifold vertices and 39 separate components. v0.6.1 reports that as a
partial repair.

Import, Convert, Split, Surface Texture, large OBJ export and the geometry
kernel are unchanged. The kernel WASM SHA-256 remains
`daf40745eee279df051f90b199b65f7cf26882db065e743bb8631f65d6ffaaa3`.

## Known limitations

Unchanged from [v0.6.0](V0_6_0_TECHNICAL_PREVIEW_RELEASE.md). In particular:

- Large OBJ **import** remains buffered and memory-heavy. Bounded large OBJ
  export does not imply bounded import; see
  [IMPORT-CORE-01](../design/IMPORT_CORE_01.md).
- Non-manifold vertices are detected and are not repaired automatically.
- Branched or complex boundaries are not filled automatically, and non-planar
  openings are not reconstructed.
- Some simple-looking openings are refused because their fill would conflict
  with existing geometry.
- Disconnected components are reported and never joined or removed.
- Printer fit and printability are not guaranteed.

Model processing runs locally in your browser. Models are not uploaded.

## Deployment

The immutable exact-SHA artifact, a verified manifest and an atomic symlink
switch, with no nginx, DNS, TLS or Certbot change. A fresh Hostinger snapshot
must be confirmed before production mutation. The immediate rollback release is
v0.6.0; v0.5.0 is retained as the deeper fallback.
