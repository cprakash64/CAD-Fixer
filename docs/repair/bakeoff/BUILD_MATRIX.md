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
