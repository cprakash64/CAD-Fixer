#!/usr/bin/env bash
#
# Builds the experimental PMP WASM candidate at its pinned SHA.
#
# ALGORITHMS ONLY. Viewers, examples, tests and docs are all off: the bakeoff
# measures the library, not its demo application, and the visualisation layer
# pulls GL dependencies that have nothing to do with hole filling. Measuring an
# example app's artifact size and calling it the library's cost would be a
# straightforwardly misleading number.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$HERE/upstream"
BUILD="$HERE/build"
ARTIFACTS="$HERE/artifacts"

# shellcheck disable=SC1091
source "$ROOT/.toolchain/emsdk_env.sh" >/dev/null 2>&1

mkdir -p "$BUILD" "$ARTIFACTS"
STARTED=$(date +%s)

emcmake cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DPMP_BUILD_EXAMPLES=OFF \
  -DPMP_BUILD_TESTS=OFF \
  -DPMP_BUILD_DOCS=OFF \
  -DPMP_BUILD_VIEWERS=OFF \
  -DPMP_BUILD_REGRESSIONS=OFF \
  -DPMP_INSTALL=OFF \
  -DPMP_STRICT_COMPILATION=OFF \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  > "$BUILD/configure.log" 2>&1 || { echo "CONFIGURE FAILED"; tail -30 "$BUILD/configure.log"; exit 1; }

cmake --build "$BUILD" --target pmp -j2 > "$BUILD/compile.log" 2>&1 || {
  echo "COMPILE FAILED"
  tail -40 "$BUILD/compile.log"
  exit 1
}

PMP_LIB="$(find "$BUILD" -name 'libpmp.a' | head -1)"
if [ -z "$PMP_LIB" ]; then
  echo "libpmp.a not found after build" >&2
  exit 1
fi

# PMP vendors Eigen under external/ with a VERSIONED directory name
# (eigen-3.4.0), not a bare `eigen`, so the path is discovered rather than
# assumed — a guessed path that silently missed would fail at the binding
# compile, which is exactly what happened on the first attempt.
EIGEN_DIR="$(find "$SRC/external" -maxdepth 1 -type d -name 'eigen*' | head -1)"
if [ -z "$EIGEN_DIR" ]; then
  echo "vendored Eigen not found under $SRC/external" >&2
  exit 1
fi
EIGEN_INC="-I$EIGEN_DIR"
echo "  using Eigen: $EIGEN_DIR"

# C++20, matching what PMP's own build used. The branch head uses `operator<=>`
# (the three-way comparison operator), which is a C++20 feature; compiling the
# binding as C++17 failed on PMP's own headers.
em++ -O3 -std=c++20 \
  -I"$SRC/src" \
  $EIGEN_INC \
  "$HERE/binding.cpp" \
  "$PMP_LIB" \
  -o "$ARTIFACTS/pmp-candidate.js" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createPmpCandidate \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 \
  -sENVIRONMENT=web,worker,node \
  -sDISABLE_EXCEPTION_CATCHING=0 \
  -sEXPORTED_FUNCTIONS='["_cf_p_run","_cf_p_status","_cf_p_vertex_count","_cf_p_triangle_count","_cf_p_positions","_cf_p_triangles","_cf_p_filled_holes","_cf_p_reset","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF64","HEAPU32"]' \
  --no-entry \
  > "$BUILD/link.log" 2>&1 || { echo "LINK FAILED"; tail -40 "$BUILD/link.log"; exit 1; }

FINISHED=$(date +%s)
echo "pmp build ok in $((FINISHED - STARTED))s"
ls -l "$ARTIFACTS" | awk 'NR>1 {print "  ", $9, $5, "bytes"}'
