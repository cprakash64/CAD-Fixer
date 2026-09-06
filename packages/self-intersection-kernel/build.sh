#!/usr/bin/env bash
#
# Builds the PRODUCTION self-intersection WASM kernel at the audited Geogram SHA.
#
# THE LICENCE GATE IS PART OF THE BUILD, exactly as it is for the Stage 3A
# research artifacts. `GEOGRAM_WITH_TETGEN=OFF` and `GEOGRAM_WITH_TRIANGLE=OFF`
# exclude the AGPL and non-free components at configure time, and this script
# REFUSES to emit an artifact if the build-input audit fails. A production
# artifact is not exempt from the obligation it carries — if anything it is the
# only artifact where the obligation is actually distributed.
#
# WHY THE OPTIONS MIRROR THE RESEARCH BUILD EXACTLY. The Stage 3C-1A-R1
# qualification measured a specific compiled artifact. A production build with
# different options would be a different artifact, and the evidence would no
# longer describe what ships.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
KERNELS="$ROOT/experiments/repair-kernels"
SRC="$KERNELS/geogram/upstream"
GEO_BUILD="$KERNELS/geogram/build"
ARTIFACTS="$HERE/artifacts"

GEOGRAM_COMMIT="c8529bb00838186938ab31d96008a59b6a892dee"

if [ ! -d "$SRC" ]; then
  echo "Geogram source not present. Fetch it with the pinned script in" >&2
  echo "  experiments/repair-kernels/scripts/fetch-candidate.sh" >&2
  exit 1
fi

ACTUAL="$(git -C "$SRC" rev-parse HEAD)"
if [ "$ACTUAL" != "$GEOGRAM_COMMIT" ]; then
  echo "GEOGRAM SHA MISMATCH: expected $GEOGRAM_COMMIT, found $ACTUAL" >&2
  echo "The qualification evidence describes the pinned commit only." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$KERNELS/.toolchain/emsdk_env.sh" >/dev/null 2>&1
export EMSCRIPTEN="$KERNELS/.toolchain/upstream/emscripten"

GEO_LIB="$(find "$GEO_BUILD" -name 'libgeogram.a' | head -1)"
if [ -z "$GEO_LIB" ]; then
  echo "libgeogram.a not found. Run experiments/repair-kernels/geogram/build.sh first." >&2
  exit 1
fi

# THE GATE. Runs against the real build inputs AND, below, the real artifact.
echo "--- licence build-input audit ---"
if ! node "$KERNELS/scripts/audit-build-inputs.mjs" "$GEO_BUILD"; then
  echo "BLOCKED_BY_BUILD_LICENSE_GATE: refusing to produce a production artifact" >&2
  exit 2
fi

mkdir -p "$ARTIFACTS"

# -fexceptions is REQUIRED, not incidental. Geogram's fixed 20-element symbolic
# buffer asserts by THROWING, and the capacity guard in si_core.h catches it.
# Without exception support that throw would kill the diagnostic worker instead
# of degrading the report to PARTIAL.
em++ -O3 -std=c++17 -fexceptions \
  -I"$SRC/src/lib" \
  -I"$SRC/src/lib/geogram/third_party/zlib" \
  -I"$HERE/src" \
  "$HERE/src/binding.cpp" \
  "$GEO_LIB" \
  -o "$ARTIFACTS/self-intersection.js" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createSelfIntersectionKernel \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=67108864 \
  -sENVIRONMENT=web,worker \
  -sEXPORTED_FUNCTIONS='["_cf_si_run","_cf_si_failed","_cf_si_candidate_pairs","_cf_si_tested_pairs","_cf_si_intersecting_pairs","_cf_si_affected_faces","_cf_si_proper_crossing","_cf_si_coplanar_overlap","_cf_si_point_touch","_cf_si_edge_touch","_cf_si_adjacent_beyond","_cf_si_duplicate","_cf_si_legitimate","_cf_si_skipped_faces","_cf_si_skipped_pairs","_cf_si_unclassified_pairs","_cf_si_sample_pairs","_cf_si_samples_truncated","_cf_si_samples","_cf_si_aabb_ms","_cf_si_scan_ms","_cf_hf_begin","_cf_hf_classify","_cf_hf_end","_cf_hf_failed","_cf_hf_status","_cf_hf_tested_pairs","_cf_hf_skipped_pairs","_cf_hf_ignored_pairs","_cf_hf_unclassified_pairs","_cf_hf_invalid_patch_source","_cf_hf_invalid_patch_patch","_cf_hf_proper_crossing","_cf_hf_coplanar_overlap","_cf_hf_point_touch","_cf_hf_edge_touch","_cf_hf_adjacent_beyond","_cf_hf_duplicate","_cf_hf_legitimate","_cf_hf_sample_pairs","_cf_hf_samples_truncated","_cf_hf_samples","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPF64","HEAPU32"]' \
  --no-entry

# THE SECOND GATE: the artifact that actually ships, scanned for the symbols the
# excluded components would leave behind.
echo "--- licence artifact audit ---"
if ! node "$KERNELS/scripts/audit-build-inputs.mjs" "$GEO_BUILD" "$ARTIFACTS/self-intersection.wasm"; then
  rm -f "$ARTIFACTS/self-intersection.js" "$ARTIFACTS/self-intersection.wasm"
  echo "BLOCKED_BY_ARTIFACT_LICENSE_GATE: artifact removed" >&2
  exit 2
fi

echo "production self-intersection kernel built at geogram $GEOGRAM_COMMIT"
ls -l "$ARTIFACTS" | awk 'NR>1 {print "  ", $9, $5, "bytes"}'
