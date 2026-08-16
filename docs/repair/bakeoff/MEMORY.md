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

---

## Stage 3A-3A

**No new memory evidence.** Stage 3A-3A ran the same tiny corpus (≤ 200
triangles), so the Stage 3A-2 negative result stands unchanged and remains a
negative result **at that scale only**: no heap growth was observed because
nothing here is large enough to cause any.

All of that was deferred to Stage 3A-3B, which has now run it.

---

## Stage 3A-3B — measured WASM memory at 1 / 10 / 50 MiB

**These are `WebAssembly.Memory` buffer lengths observed inside the candidate
Worker. They are NOT process RSS**, and the browser does not expose physical
reclamation, so no claim about RAM returning to the operating system is made
anywhere in this document.

| Candidate | Operation      | Input    | WASM heap before → after | Amplification       |
| --------- | -------------- | -------- | ------------------------ | ------------------- |
| manifold  | Boolean Add    | 0.86 MiB | 32 → 32 MiB              | within initial heap |
| manifold  | Boolean Add    | 11.0 MiB | 32 → 288 MiB             | ~26×                |
| manifold  | Boolean Add    | 45.0 MiB | 32 → **1,116 MiB**       | **~25×**            |
| geogram   | repairTopology | 1.16 MiB | 64 → 64 MiB              | within initial heap |
| geogram   | repairTopology | 10.4 MiB | 64 → 64 MiB              | within initial heap |
| geogram   | repairTopology | 50.8 MiB | 64 → 207 MiB             | ~4×                 |
| pmp       | ingest         | 1.01 MiB | 32 → 32 MiB              | within initial heap |
| pmp       | ingest         | 9.69 MiB | 32 → 80 MiB              | ~8×                 |
| pmp       | ingest         | 52.1 MiB | 32 → 353 MiB             | ~7×                 |

### Copy amplification, measured rather than assumed

Stage 3A-2 assumed "three copies". The live representations at peak, per
operation, are actually:

1. the page's authoritative mesh (Float32 canonical, retained),
2. the Worker's structured-clone copy (Float64 transfer form),
3. the WASM ingest copy inside linear memory,
4. the candidate's own internal working representation,
5. the WASM output buffer,
6. the extracted `Float64Array`/`Uint32Array` result.

All six coexist at the extraction moment. (1) is not freed because the page owns
it — that is the safety property, not waste. (2) is not freed until the Worker
dies, which is one more reason the disposable-worker model is attractive.

**Manifold's (4) dominates everything else** at ~25× input, which is where the
1,116 MiB comes from. Geogram at ~4× and PMP at ~7× are unremarkable by
comparison.

### Consequence for production

Extrapolating Manifold linearly, a 100 MiB boolean would want ~2.4 GiB of WASM
heap. A browser tab cannot be relied on to provide that. **A production boolean
must estimate before it starts and refuse above a ceiling** rather than
discovering the limit by aborting. Refusing is an acceptable product behaviour;
crashing the tab is not.

### Reclamation

After `Worker.terminate()` the entire Worker and its WASM heap **become
unreachable from application state**. That is the accurate statement. Whether
the browser returns those pages to the operating system is not observable from
the page, and is not claimed.
