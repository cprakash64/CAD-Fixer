# 0005 — Validation after geometry operations

- Status: Accepted
- Date: 2026-08-14

## Context

Mesh algorithms fail in ways that do not throw. A boolean can emit a mesh with
orphaned indices. A hollowing pass can produce inverted normals or a shell that
does not enclose a volume. A repair can close a hole by adding a triangle that
intersects the model. In every case the function returns a mesh object, and
every subsequent step treats it as valid.

For a 3D printing tool the cost lands on the user physically: a failed print,
wasted filament, hours of machine time, possibly a ruined part. And the failure
surfaces long after the operation that caused it, which makes it expensive to
diagnose.

Geometry kernels also disagree about what they guarantee. A kernel reporting
success is a statement about its own internal invariants, not about ours.

## Decision

**A geometry operation is not successful because it returned a mesh. It is
successful once its output passes validation.**

This is a fundamental engineering rule of the project, recorded in
[CLAUDE.md](../../CLAUDE.md) and enforced in code:

- `validateMeshStructure(mesh)` returns a `MeshValidationReport` — issues with
  severity, plus derived counts.
- `assertMeshStructure(mesh, context)` is the gate. It throws
  `GEOMETRY_VALIDATION_FAILED`, naming the operation, if any issue has `Error`
  severity.
- **Every geometry operation must pass its output through the gate before that
  output is accepted**, including operations backed by a WASM kernel that
  reports success.

### Severity is a real distinction

- **Error** — a structural invariant is violated. The mesh must not be used.
  Out-of-range indices, non-finite coordinates, mismatched attribute lengths,
  buffer lengths that are not whole triplets, out-of-bounds groups.
- **Warning** — suspicious but usable. Surface it; do not block. Degenerate
  triangles are the current example, and treating them as errors would make
  repair inputs unloadable — which would defeat the product's main workflow.

### Bounded reporting

A pathological mesh can produce one issue per triangle, which makes the report
itself a memory-exhaustion vector. Issue collection is capped (default 64) and
the report carries a `truncated` flag.

### Scope

Stage 0 implements **structural** validation only. Topological and geometric
validation — manifoldness, boundary edges, self-intersection, winding
consistency, volume sanity — arrives with the repair workflow, in its own module,
so the cheap structural gate stays cheap.

Structural validation is O(vertices + triangles) and scans every coordinate. On
a large mesh that is real work and must run in a worker.

## Alternatives considered

**Trust the operations.** Cheapest, and standard practice in many mesh
libraries. Rejected: it is precisely how corrupt geometry reaches a printer, and
the failure surfaces far from its cause.

**Validate only at export.** Cheaper — one check at the end. Rejected because it
loses attribution entirely: with repair, split, and hollow chained together, a
failure at export tells you nothing about which step broke the mesh. Validating
after each operation localises the defect to the operation that caused it.

**Validate only in development builds.** Rejected. A user's real-world file is
exactly the input most likely to break an algorithm, and that is the run where
the check matters most. The structural check is linear and cheap relative to the
operations it guards.

**Return a validation report instead of throwing.** Considered seriously. We do
both: `validateMeshStructure` returns a report for callers that want to inspect
and surface issues; `assertMeshStructure` throws for the gate, so an operation
cannot forget to check a returned value and pass a broken mesh onward.

**Auto-repair invalid output.** Rejected outright: silently fixing an operation's
broken output violates the data integrity principle and hides a genuine defect.

## Consequences

**Positive**

- Corrupt geometry is caught at the operation that produced it.
- `GEOMETRY_VALIDATION_FAILED` is a distinct, actionable error category.
- Kernel bugs surface during development instead of at a user's printer.
- The rule is mechanical and reviewable — a new operation either calls the gate
  or does not.

**Negative**

- A linear scan per operation. Measurable on large meshes; acceptable against
  the operations themselves, but chained operations pay it repeatedly. If it
  becomes a bottleneck, the response is to make validation faster, not to skip
  it.
- Validation code is itself code that can be wrong. A false positive blocks a
  legitimate mesh, so severity assignments need care — hence degenerate
  triangles being a warning.
- Structural validation does not catch topological defects, and must not be
  mistaken for a printability guarantee.
