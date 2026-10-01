#!/usr/bin/env bash
# Shared production/research configuration; sourced after PYBRIX_REPO_ROOT is set.
PYBRIX_GEOGRAM_COMMIT=c8529bb00838186938ab31d96008a59b6a892dee
PYBRIX_EMSDK_VERSION=4.0.16
PYBRIX_EMSDK_ROOT="${PYBRIX_EMSDK_ROOT:-$PYBRIX_REPO_ROOT/experiments/repair-kernels/.toolchain}"
if [ ! -f "$PYBRIX_EMSDK_ROOT/emsdk_env.sh" ]; then
  echo "Install emsdk $PYBRIX_EMSDK_VERSION and set PYBRIX_EMSDK_ROOT." >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$PYBRIX_EMSDK_ROOT/emsdk_env.sh" >/dev/null 2>&1
export EMSCRIPTEN="$PYBRIX_EMSDK_ROOT/upstream/emscripten"
PYBRIX_COMPILER_VERSION="$(emcc --version | head -1)"
if [[ "$PYBRIX_COMPILER_VERSION" != *" $PYBRIX_EMSDK_VERSION "* ]]; then
  echo "Expected Emscripten $PYBRIX_EMSDK_VERSION; found $PYBRIX_COMPILER_VERSION" >&2
  exit 1
fi
PYBRIX_GEOGRAM_SOURCE="$PYBRIX_REPO_ROOT/experiments/repair-kernels/geogram/upstream"
if [ "$(git -C "$PYBRIX_GEOGRAM_SOURCE" rev-parse HEAD)" != "$PYBRIX_GEOGRAM_COMMIT" ]; then
  echo "Geogram source revision mismatch" >&2
  exit 1
fi
if [ -n "$(git -C "$PYBRIX_GEOGRAM_SOURCE" status --porcelain --untracked-files=no)" ]; then
  echo "Geogram source must be clean, including pinned submodules" >&2
  exit 1
fi
# Earlier matches map generated/repository files; later, more specific mappings
# retain useful upstream diagnostics without leaking a checkout or SDK location.
PYBRIX_PATH_FLAGS=()
for PYBRIX_MAP in "$PYBRIX_REPO_ROOT=/src/pybrix" "$PYBRIX_GEOGRAM_SOURCE=/src/geogram" "$PYBRIX_EMSDK_ROOT=/src/toolchain"; do
  PYBRIX_PATH_FLAGS+=("-ffile-prefix-map=$PYBRIX_MAP" "-fmacro-prefix-map=$PYBRIX_MAP" "-fdebug-prefix-map=$PYBRIX_MAP")
done
# Deterministic toolchain timestamps, independent of invocation date.
export SOURCE_DATE_EPOCH=1755302400
