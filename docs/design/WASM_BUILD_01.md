# WASM-BUILD-01 — reproducible Geogram runtime

## Scope and exposure

The old runtime contained 40 unique developer source paths. Byte-level WASM
section inspection and `strings` agree: all 40 were in section 11 (runtime data),
with no custom, DWARF, name, producer or source-map sections. Geogram's
`geo_assert`, range-check and unreachable macros pass `__FILE__` to diagnostics;
`exact_geometry.cpp:531` provides a representative live safety assertion.
This is build-path / local-environment information disclosure, not evidence of
remote code execution. v0.5.0 shipped the same bytes; that history does not waive
v0.6.0's release hygiene requirement.

## Canonical inputs and command

- Geogram v1.10.0: `c8529bb00838186938ab31d96008a59b6a892dee`, clean checkout
  with its exact recursive submodule revisions.
- emsdk 4.0.16 tag: `526ceebf902920582fc6979fcb65c50f1648aaeb`.
- Emscripten 4.0.16: `09534bba7f0ee767bf6f6f8cb5b7bf9519b8d63a`.
- Clang 22.0.0git: `c4e1bca407f4cca7644937c117890fad157fec4b`.
- Qualification host: Apple M1 macOS, CMake 4.1.2, Node 22.22.2.
- Reproducibility timestamp: `SOURCE_DATE_EPOCH=1755302400`.

Fetch Geogram using the pinned `experiments/repair-kernels/scripts/fetch-candidate.sh
geogram`. Install and activate emsdk 4.0.16 (not latest), then run from repository
root:

```bash
PYBRIX_EMSDK_ROOT=/absolute/path/to/emsdk-4.0.16 \
  bash packages/self-intersection-kernel/build.sh
node scripts/audit-artifact-paths.mjs \
  packages/self-intersection-kernel/artifacts/self-intersection.wasm \
  packages/self-intersection-kernel/artifacts/self-intersection.js
```

The shared `geogram-toolchain.sh` rejects another compiler or source revision,
and modified upstream/submodule files. Production always reconfigures/builds
Geogram before linking: it does not trust a previously compiled research archive.
Build products and SDK remain ignored; no source tree or model ships.

## Flags and assertions

CMake uses the upstream `Emscripten-clang` platform and Release static library:
`-O3 -DNDEBUG`, C++17 and upstream warning flags. TetGen, Triangle, graphics,
Lua, HLBFGS, legacy numerics, Exploragram and non-library targets remain disabled.
The existing library flags, defines (`GEOGRAM_USE_BUILTIN_DEPS`,
`GEOGRAM_VERSION="1.10.0"`, `GEOGRAM_WITH_PDEL`, `NL_WITH_AMGCL`) and license
build-input gates are retained. The binding still links at `-O3 -std=c++17
-fexceptions`, retains the exact C ABI, ES6 modular factory, web/worker runtime,
64 MiB initial memory and memory growth. No safety assertion or numerical
algorithm is changed. `ASSERT_THROW` and the capacity guard remain active.

Both C/C++ library compilation and binding compilation receive
`-ffile-prefix-map`, `-fmacro-prefix-map` and `-fdebug-prefix-map` for each:

| Physical input   | Logical diagnostic prefix |
| ---------------- | ------------------------- |
| repository       | `/src/pybrix`             |
| Geogram upstream | `/src/geogram`            |
| SDK              | `/src/toolchain`          |

More specific mappings follow the repository mapping. CMake arguments are
shell-escaped for paths containing whitespace. Diagnostics retain useful logical
filenames and line numbers. No final-byte replacement or binary patch occurs.
No stripping was added: the existing optimized runtime already has no custom
sections, and there are no debugging sections to remove. The generated loader
and WASM are checked before the build succeeds.

## Qualified outputs

Two clean, independently compiled roots produced identical WASM and glue:
`/private/tmp/pybrix-wasm-build-A` and
`/private/tmp/completely-different-root-B/pybrix`. They share only the pinned
compiler installation, not compiled objects or Geogram archives. A container is
not required for this demonstrated location independence. Cross-platform
compiler equivalence is not claimed; use the recorded toolchain.

| Artifact      |     Bytes | SHA-256                                                            |
| ------------- | --------: | ------------------------------------------------------------------ |
| previous WASM | 1,272,716 | `507ea5e7c9110781e4d90ade507d1b37a7b95b2832b055cb59418bca43399fc3` |
| new WASM      | 1,269,874 | `daf40745eee279df051f90b199b65f7cf26882db065e743bb8631f65d6ffaaa3` |
| new glue      |    78,702 | `b9bf7f2c24ae750cba50e318dda40fd285e02f40c49e280fd2f1378149a255b9` |

Size reduction is from shorter remapped diagnostics, with no assertion removal.
All 57 exported WASM ABI entries match the previous kernel. Old bytes are
retained in Git at `a466058be058b31ad348bc40b3e75be407aaaac6`; historical evidence
and its hashes remain unchanged. Current packager/test pins use only the new hash.

## Artifact audit policy

`scanArtifactPaths` scans every shipped file's bytes, including WASM, fonts and
images, and also checks UTF-16 strings. It rejects recognizable `/Users/`,
`/home/`, `/tmp/`, `/private/tmp/`, `/private/var/folders/`, Windows drive paths,
configured checkout roots and distinctive current usernames. Generic account
names are excluded from username-only checks to prevent false positives.
Deliberate `/src/...` diagnostics and the exact Emscripten virtual home
`/home/web_user` are allowed. The latter is a fixed generated runtime value, not
a developer account; nested checkout paths still fail. Drive letters must not
be a suffix of a word/URL scheme, preventing `data:`/HTTP regex false positives. Arbitrary slashes or binary byte
runs are not rejected. Findings report offset/type, not surrounding potentially
private contents. This is deterministic path hygiene, not a general secret scanner.

The release packager audits before copying any deployable file, and the release
verification scans every shipped file. Existing text checks remain intact.
Fixtures cover text, binary, WASM-like data, UTF-16, temporary/Windows/checkout
roots, usernames and safe logical paths. The old production binary is a negative
control: it must fail the enhanced audit. Source maps remain excluded.

## Behavior and performance evidence

The frozen 27-fixture self-intersection corpus, exact resource-cap outcomes,
sample ordering and partial/degenerate results match the previous production
kernel. Another 256 deterministic seeded soups run under normal and tight
budgets. Existing malformed/non-finite, repeated invocation, cancellation,
patch classification and worker ownership tests remain required.

The real truck's six simple openings receive identical old/new decisions:
two accepted, four geometry refusals. Candidate indices, source preservation,
topology and per-opening verification counters match; elapsed analysis time is
excluded from semantic comparison. Representative real-model region verification
was 111 ms with each kernel. Controlled alternating-process measurements found
startup medians about 3.4 ms old / 3.2 ms new; batches of 1,000 crossing,
coplanar and degenerate checks about 5.9 / 9.6 / 15.4 ms for both. Initial WASM
memory remains 67,108,864 bytes. Timings are host observations, not new budgets;
unchanged full browser timing gates still apply. Pre-existing Geogram duplicate
`sys` registration logging remains separately classified.

Full application qualification, actual worker-loaded hash proof and two clean
release builds are recorded in the stage evidence. No deployment, release SHA,
tag or main integration is authorized in this stage.

## Application qualification

Final unchanged full gates passed: 151 unit/component files, 3,427 tests (no
skips); 320 application tests with two pre-existing opt-in skips; 130 harness
cases; 15 timing cases; 28 release verification cases. Auditor regression has
11 cases, including escaped Windows paths and rejection of nested virtual-home
checkout paths. Initial lint/inventory harness issues and a load-sensitive XML
retention timeout are retained in the evidence; the full final run is green
without relaxing limits, assertions, timeouts or skip configuration.

Hardware Chromium 151 / Apple M1 Metal real-model acceptance verified planning,
preview, Apply, Undo, deterministic retry, original-facet-preserving STL round
trip, cancellation (231 ms), and stale replacement during planning and preview.
The whole session renderer peak was 1,319 MiB. Actual network evidence captured
17 Geogram WASM responses, each with the new qualified hash, and 71 same-origin
requests with zero off-origin transfer or unexpected page errors. No model is
included in this document or the release. Duplicate registration logging is
unchanged and remains classified separately.
