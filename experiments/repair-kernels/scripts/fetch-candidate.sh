#!/usr/bin/env bash
#
# Fetches ONE candidate at its pinned commit and verifies the SHA.
#
# The verification is the point. A clone that silently landed on a different
# commit would make every number downstream describe software nobody can
# identify, so a mismatch is a hard failure rather than a warning.
#
# Usage: fetch-candidate.sh <candidate-id>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ID="${1:?usage: fetch-candidate.sh <candidate-id>}"

REPO="$(node "$HERE/candidate-field.mjs" "$ID" repository)"
SHA="$(node "$HERE/candidate-field.mjs" "$ID" sha)"

# Geogram alone needs submodules; upstream warns that GitHub's generated
# archives omit them, which is how a careless integration ends up with the
# gated third-party components after believing it excluded them.
SUBMODULES=no
if [ "$ID" = "geogram" ]; then SUBMODULES=yes; fi

DEST="$ROOT/$ID/upstream"
mkdir -p "$DEST"

if [ ! -d "$DEST/.git" ]; then
  echo "fetching $ID from $REPO at $SHA"
  git init --quiet "$DEST"
  git -C "$DEST" remote add origin "$REPO"
fi

# Only the pinned commit: the full history of these projects is large and
# nothing here needs it.
git -C "$DEST" fetch --quiet --depth 1 origin "$SHA"
git -C "$DEST" checkout --quiet FETCH_HEAD

ACTUAL="$(git -C "$DEST" rev-parse HEAD)"
if [ "$ACTUAL" != "$SHA" ]; then
  echo "SHA MISMATCH for $ID: expected $SHA, got $ACTUAL" >&2
  exit 1
fi
echo "  verified $ID @ $ACTUAL"

if [ "$SUBMODULES" = "yes" ]; then
  echo "  fetching submodules"
  git -C "$DEST" submodule update --init --recursive --depth 1 --quiet || {
    echo "  submodule fetch failed" >&2
    exit 1
  }
fi

du -sh "$DEST" | awk '{print "  size:", $1}'
