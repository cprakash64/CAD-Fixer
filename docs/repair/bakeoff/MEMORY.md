# WASM memory findings

Stage 3A-2. Measured at corpus scale only — see the limitation at the end.

## Observed

| Candidate | Initial heap | Max heap after any operation | Growth events |
| --------- | ------------ | ---------------------------- | ------------- |
| Manifold  | 32 MiB       | 32 MiB                       | none          |
| Geogram   | 64 MiB       | 64 MiB                       | none          |
| PMP       | 32 MiB       | 32 MiB                       | none          |

Heap size was read from the module's `WebAssembly.Memory` buffer immediately
before and after each operation, across all 612 rows.

## Copy amplification — measured structurally, not guessed

Every candidate uses the same marshalling contract, so the copies are known
exactly rather than estimated:

1. **JS → WASM input copy.** The mesh is written into the WASM heap with
   `HEAPF64.set` / `HEAPU32.set`. One full copy.
2. **Candidate-internal representation.** Each kernel builds its own structure
   (`MeshGL64`, `GEO::Mesh`, `pmp::SurfaceMesh`) from that buffer. A second
   copy, in the kernel's own layout.
3. **WASM → JS output copy.** Results are read back with `.slice()`, never as a
   view: a view into the heap is invalidated the moment memory grows.

So a repair holds **at least three representations at once**, on top of the
resident mesh and the render snapshot the application already keeps. A
production integration must budget for that; this stage did not measure it at a
size where it matters.

**A TypedArray view is not zero-copy.** The `HEAPF64` view exists without
copying, but reading through it into JS still copies, and holding it across an
allocation is a use-after-free in slow motion.

## Explicit limitation

The corpus fixtures are tiny — tens to a few hundred triangles. **No candidate
was pushed anywhere near memory pressure, so the absence of growth is a negative
result at this scale and nothing more.** It does not establish that any
candidate behaves well on a 100 MiB model, and it must not be cited as if it
did.

What Stage 3A-2 did **not** measure, and a later stage must:

- heap growth on multi-million-triangle input;
- whether disposal returns memory to the OS or merely to the allocator;
- the 32-bit 4 GiB linear-memory ceiling in practice, and WASM64 availability;
- SIMD and thread behaviour (all builds are sequential and non-SIMD);
- peak resident set of the hosting process, as distinct from WASM heap.
