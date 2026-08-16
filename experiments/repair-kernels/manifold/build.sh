#!/usr/bin/env bash
#
# Builds the experimental Manifold WASM candidate at its pinned SHA.
#
# SEQUENTIAL ONLY. `MANIFOLD_PAR` stays OFF: upstream warns that parallel
# Emscripten builds risk memory corruption, and pthreads are not needed to
# answer this stage's architectural questions. A threaded build, if ever wanted,
# must be a separate and explicitly labelled experiment.
#
# CROSS_SECTION is off because it pulls Clipper2 for 2D work the bakeoff never
# does — every dependency that enters the artifact is one more licence to track.
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
  -DMANIFOLD_PAR=OFF \
  -DMANIFOLD_TEST=OFF \
  -DMANIFOLD_CROSS_SECTION=OFF \
  -DMANIFOLD_PYBIND=OFF \
  -DMANIFOLD_JSBIND=OFF \
  -DMANIFOLD_DEBUG=OFF \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  > "$BUILD/configure.log" 2>&1 || { tail -30 "$BUILD/configure.log"; exit 1; }

cmake --build "$BUILD" --target manifold -j2 > "$BUILD/compile.log" 2>&1 || {
  tail -40 "$BUILD/compile.log"
  exit 1
}

# Link our binding against the static library. Kept as a separate em++ call
# rather than a CMake target so the exact link line is visible and auditable.
em++ -O3 \
  -I"$SRC/include" \
  "$HERE/binding.cpp" \
  "$BUILD/src/libmanifold.a" \
  -o "$ARTIFACTS/manifold-candidate.js" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createManifoldCandidate \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=33554432 \
  -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS='["_cf_run","_cf_boolean","_cf_status","_cf_kernel_reported_success","_cf_vertex_count","_cf_triangle_count","_cf_positions","_cf_triangles","_cf_genus","_cf_volume","_cf_surface_area","_cf_component_count","_cf_reset","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF64","HEAPU32","getValue"]' \
  --no-entry \
  > "$BUILD/link.log" 2>&1 || { tail -30 "$BUILD/link.log"; exit 1; }

FINISHED=$(date +%s)
echo "manifold build ok in $((FINISHED - STARTED))s"
ls -l "$ARTIFACTS" | awk 'NR>1 {print "  ", $9, $5, "bytes"}'
