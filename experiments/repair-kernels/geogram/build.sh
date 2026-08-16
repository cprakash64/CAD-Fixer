#!/usr/bin/env bash
#
# Builds the experimental Geogram WASM candidate at its pinned SHA.
#
# THE LICENCE GATE IS PART OF THE BUILD, not a step someone might remember to
# run afterwards. `GEOGRAM_WITH_TETGEN=OFF` and `GEOGRAM_WITH_TRIANGLE=OFF`
# exclude the AGPL and non-free components at configure time — but a CMake
# option that silently did nothing would leave the obligation in place while
# looking satisfied, so this script runs the build-input audit and REFUSES to
# produce an artifact if the audit fails.
#
# Also off: graphics (viewers we do not use), Lua, HLBFGS, and the legacy
# numerics — every component that survives into the artifact is another licence
# to track and another attack surface, and none of them is needed to evaluate
# repair and intersection.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$HERE/upstream"
BUILD="$HERE/build"
ARTIFACTS="$HERE/artifacts"

# shellcheck disable=SC1091
source "$ROOT/.toolchain/emsdk_env.sh" >/dev/null 2>&1

# Geogram's platform file locates Emscripten with `find_path(EMSCRIPTEN_DIR
# emcc.py HINTS ENV EMSCRIPTEN ...)`, and the hint list predates emsdk's current
# layout, so it finds nothing. Exporting EMSCRIPTEN points it at the SDK we
# actually pinned. This is BUILD INTEGRATION, not an algorithm change: no
# Geogram source is modified, and the compiler it selects is the same emcc the
# other candidates use.
EMSCRIPTEN_DIR_PATH="$ROOT/.toolchain/upstream/emscripten"
export EMSCRIPTEN="$EMSCRIPTEN_DIR_PATH"

mkdir -p "$BUILD" "$ARTIFACTS"
STARTED=$(date +%s)

# Geogram does not accept a bare CMake invocation: it expects its own
# configure script to have selected a "vorpaline platform". `Emscripten-clang`
# is the platform upstream ships for this target, so it is named explicitly
# rather than reproduced by hand — using upstream's own platform file is what
# keeps this a build of Geogram rather than a build of our guess at Geogram.
emcmake cmake -S "$SRC" -B "$BUILD" \
  -DVORPALINE_PLATFORM=Emscripten-clang \
  -DEMSCRIPTEN_DIR="$EMSCRIPTEN_DIR_PATH" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGEOGRAM_WITH_TETGEN=OFF \
  -DGEOGRAM_WITH_TRIANGLE=OFF \
  -DGEOGRAM_WITH_GRAPHICS=OFF \
  -DGEOGRAM_WITH_LUA=OFF \
  -DGEOGRAM_WITH_HLBFGS=OFF \
  -DGEOGRAM_WITH_LEGACY_NUMERICS=OFF \
  -DGEOGRAM_WITH_EXPLORAGRAM=OFF \
  -DGEOGRAM_LIB_ONLY=ON \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  > "$BUILD/configure.log" 2>&1 || { echo "CONFIGURE FAILED"; tail -30 "$BUILD/configure.log"; exit 1; }

cmake --build "$BUILD" --target geogram -j2 > "$BUILD/compile.log" 2>&1 || {
  echo "COMPILE FAILED"
  tail -40 "$BUILD/compile.log"
  exit 1
}

# THE GATE. Runs before any artifact exists, and a failure stops the build.
echo "--- licence build-input audit ---"
if ! node "$ROOT/scripts/audit-build-inputs.mjs" "$BUILD"; then
  echo "BLOCKED_BY_BUILD_LICENSE_GATE: refusing to produce a Geogram artifact" >&2
  exit 2
fi

GEO_LIB="$(find "$BUILD" -name 'libgeogram.a' | head -1)"
if [ -z "$GEO_LIB" ]; then
  echo "libgeogram.a not found after build" >&2
  exit 1
fi

# `geogram/basic/geofile.h` includes <zlib.h>, and Geogram satisfies that from
# its own bundled copy. The binding needs the same include path. zlib is under
# the permissive zlib licence — recorded in the ledger as a component that
# survives into the artifact and therefore carries an attribution obligation.
# It is NOT one of the gated components.
em++ -O3 \
  -I"$SRC/src/lib" \
  -I"$SRC/src/lib/geogram/third_party/zlib" \
  "$HERE/binding.cpp" \
  "$GEO_LIB" \
  -o "$ARTIFACTS/geogram-candidate.js" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createGeogramCandidate \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS='["_cf_g_run","_cf_g_status","_cf_g_vertex_count","_cf_g_triangle_count","_cf_g_positions","_cf_g_triangles","_cf_g_intersection_count","_cf_g_moebius_facets","_cf_g_reset","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF64","HEAPU32"]' \
  --no-entry \
  > "$BUILD/link.log" 2>&1 || { echo "LINK FAILED"; tail -40 "$BUILD/link.log"; exit 1; }

FINISHED=$(date +%s)
echo "geogram build ok in $((FINISHED - STARTED))s"
ls -l "$ARTIFACTS" | awk 'NR>1 {print "  ", $9, $5, "bytes"}'
