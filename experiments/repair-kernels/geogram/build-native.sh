#!/usr/bin/env bash
#
# Builds the NATIVE Geogram reference executable at the pinned SHA.
#
# Stage 3A-3A. This exists to answer one question the WASM candidate cannot:
# when Geogram's colocate path misbehaves, is that Geogram, our binding, our
# initialisation, or Emscripten? A native build from the same commit with the
# same options isolates the compiler target as the only remaining variable.
#
# THE LICENCE GATE APPLIES HERE TOO. This produces a real binary containing
# real Geogram code, so the same tetgen/triangle exclusions and the same audit
# run. A research binary is not exempt from the obligation the artifact carries.
#
# Options mirror build.sh deliberately. A native build with different features
# would answer a different question.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$HERE/upstream"
BUILD="$HERE/build-native"
ARTIFACTS="$HERE/artifacts"

mkdir -p "$BUILD" "$ARTIFACTS"
STARTED=$(date +%s)

cmake -S "$SRC" -B "$BUILD" \
  -DVORPALINE_PLATFORM=Darwin-aarch64-clang \
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

# Same gate, same script, same refusal-to-emit as the WASM build.
echo "--- licence build-input audit (native) ---"
if ! node "$ROOT/scripts/audit-build-inputs.mjs" "$BUILD"; then
  echo "BLOCKED_BY_BUILD_LICENSE_GATE: refusing to produce a native Geogram artifact" >&2
  exit 2
fi

GEO_LIB="$(find "$BUILD" -name 'libgeogram.a' | head -1)"
if [ -z "$GEO_LIB" ]; then
  echo "libgeogram.a not found after native build" >&2
  exit 1
fi

clang++ -O3 -std=c++17 \
  -I"$SRC/src/lib" \
  -I"$SRC/src/lib/geogram/third_party/zlib" \
  "$HERE/reference.cpp" \
  "$GEO_LIB" \
  -o "$ARTIFACTS/geogram-reference" \
  > "$BUILD/link.log" 2>&1 || { echo "LINK FAILED"; tail -40 "$BUILD/link.log"; exit 1; }

FINISHED=$(date +%s)
echo "geogram native reference ok in $((FINISHED - STARTED))s"
shasum -a 256 "$ARTIFACTS/geogram-reference"
