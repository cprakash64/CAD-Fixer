# Candidate build matrix

Stage 3A-2. All three candidates built from pinned commits with one shared
toolchain, so build-mode differences cannot be mistaken for algorithmic ones.

## Toolchain

|             |                                                     |
| ----------- | --------------------------------------------------- |
| emsdk       | 4.0.16                                              |
| emcc / em++ | 4.0.16 (`09534bba7f0ee767bf6f6f8cb5b7bf9519b8d63a`) |
| wasm-ld     | LLD 22.0.0                                          |
| CMake       | 4.1.2                                               |
| Host        | Apple Silicon, 8 GB, macOS 27                       |

No candidate required a different compiler version.

## Results

| Candidate       | Commit     | Build   | Duration                | Patches to upstream | wasm      | JS glue |
| --------------- | ---------- | ------- | ----------------------- | ------------------- | --------- | ------- |
| Manifold v3.5.2 | `11235e6b` | success | 31 s                    | **none**            | 296,885   | 9,846   |
| Geogram v1.10.0 | `c8529bb0` | success | 16 s (after lib cached) | **none**            | 1,319,496 | 71,046  |
| PMP branch head | `af4725cc` | success | 11 s                    | **none**            | 246,095   | 15,379  |

**No upstream source was patched.** Every fix was to our own build scripts or
bindings, so all three artifacts represent unmodified upstream code.

## Artifact hashes (SHA-256, first 16 hex)

| Candidate | wasm               |
| --------- | ------------------ |
| Manifold  | `579f373858869a0b` |
| Geogram   | `057ac90d8b4e69d5` |
| PMP       | `a4e1263cb8f41abc` |

## Build configuration

**Manifold** — `MANIFOLD_PAR=OFF` (sequential; upstream warns parallel
Emscripten builds risk memory corruption), `MANIFOLD_TEST=OFF`,
`MANIFOLD_CROSS_SECTION=OFF` (avoids pulling Clipper2 for 2D work the bakeoff
never does), `BUILD_SHARED_LIBS=OFF`, Release.

**Geogram** — `GEOGRAM_WITH_TETGEN=OFF`, `GEOGRAM_WITH_TRIANGLE=OFF` (the
licence gate), plus `GRAPHICS`, `LUA`, `HLBFGS`, `LEGACY_NUMERICS` and
`EXPLORAGRAM` off. Platform `Emscripten-clang`, upstream's own.

**PMP** — examples, tests, docs, viewers and regressions all off. Algorithms
only: the bakeoff measures the library, not its demo application.

## Build-integration issues encountered

Each is a fix to _our_ scripts, categorised per the Stage 3A-1 patch policy.
None is an algorithm modification.

| Issue                                                                 | Category          | Fix                                                                                             |
| --------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Geogram requires `VORPALINE_PLATFORM`                                 | build integration | Named upstream's own `Emscripten-clang` platform                                                |
| Geogram's `find_path(EMSCRIPTEN_DIR emcc.py)` predates emsdk's layout | build integration | Exported `EMSCRIPTEN` and passed `-DEMSCRIPTEN_DIR`                                             |
| Binding failed on `<zlib.h>`                                          | build integration | Added Geogram's bundled zlib include path                                                       |
| `mesh_reorient` returns void, not bool                                | binding           | Used its `moebius_facets` out-vector, which is also the correct way to detect non-orientability |
| PMP vendors Eigen as `eigen-3.4.0`, not `eigen`                       | build integration | Discover the directory instead of guessing                                                      |
| PMP branch head uses C++20 `operator<=>`                              | build integration | Compile the binding as C++20, matching the library                                              |
| `pmp::VertexProperty` is a namespace template, not nested             | binding           | Corrected the qualified name                                                                    |

`MAJOR_FORK_REQUIRED`: **not triggered for any candidate.**

---

## Stage 3A-3A rebuilds

Both WASM candidates were rebuilt from the **same pinned commits** — no upstream
source was modified, and the licence gate ran and passed on every build.

| Artifact                  | Change                                                                           | Bytes                     | New SHA-256 (prefix) |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------- | -------------------- |
| `geogram-candidate.wasm`  | binding now imports `algo` + `sys` argument groups; `cf_g_set_init_mode` added   | 1,368,082 (was 1,319,496) | `73cabc53caeb3d85…`  |
| `manifold-candidate.wasm` | `cf_merge_changed` export; `CF_OP_SELF_UNION` renamed `CF_OP_SELF_UNION_INVALID` | 296,938 (was 296,885)     | `8bd72c68df6d2785…`  |
| `pmp-candidate.wasm`      | **unchanged**                                                                    | 246,095                   | `a4e1263cb8f41abc…`  |

### New: native Geogram reference

`experiments/repair-kernels/geogram/build-native.sh` builds a native executable
from the **same** pinned commit `c8529bb0` with the **same** CMake options, so
the compiler target is the only variable when comparing against WASM.

|              |                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Platform     | `Darwin-aarch64-clang`, Release, static                                                          |
| Options      | identical to the WASM build, including `GEOGRAM_WITH_TETGEN=OFF` and `GEOGRAM_WITH_TRIANGLE=OFF` |
| Licence gate | **runs and passed** — a research binary is not exempt from the obligation                        |
| Artifact     | `geogram-reference`, 4,832,368 bytes, `d6b0e5c930a395e1…`                                        |
| Build time   | 152 s                                                                                            |

**`documented capability` versus `compiled and verified capability`:** everything
in the two tables above is _compiled and verified_. PMP's double-precision build
option (`-DPMP_SCALAR_TYPE=64`) is **documented capability only** — it exists in
`CMakeLists.txt:167` and has not been built or measured here.

---

## Stage 3A-3B — no rebuild was required for the browser

**Every browser result used the Stage 3A-3A artifact, byte for byte.** No
candidate needed a browser-specific build, no artifact SHA changed, and no new
manifest was created.

| Artifact                  | SHA-256             | Bytes     | Browser load            |
| ------------------------- | ------------------- | --------- | ----------------------- |
| `manifold-candidate.wasm` | `8bd72c68df6d2785…` | 296,938   | instantiated in 23.6 ms |
| `geogram-candidate.wasm`  | `73cabc53caeb3d85…` | 1,368,082 | instantiated in 16.9 ms |
| `pmp-candidate.wasm`      | `a4e1263cb8f41abc…` | 246,095   | instantiated in 6.0 ms  |

That the same `-sENVIRONMENT=web,worker,node` artifacts run unmodified under
Node, in a module Worker, and under cross-origin isolation is itself a build
finding: the build mode chosen in Stage 3A-2 was correct for the product target.

**Serving matters as much as building.** The artifacts are served as raw bytes
by a plain `node:http` server. Passing them through Vite destroys Emscripten's
ES6 glue — the defect that fabricated 321 "crashes" in Stage 3A-2 — so any
future production integration must treat the glue as an asset, never as a
bundler input.

`documented capability` vs `compiled and verified capability` vs **`browser
verified`**: all three artifacts above are now browser verified. PMP's
double-precision build option remains `documented capability` only.
