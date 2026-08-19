#!/usr/bin/env bash
#
# Refresh the vendored core from its upstream home in the skill repo.
#
# The skill has to stay installable by cloning it on its own, so it cannot
# depend on a package published from here. Vendoring plus a CI drift gate is
# the honest arrangement: one copy is authoritative, the other is a checked
# duplicate rather than a second implementation waiting to diverge.
#
# Usage: scripts/sync-core.sh
set -euo pipefail

BASE="https://raw.githubusercontent.com/daronthedragon/wallet-forensics-skill/main/core"
DEST_DIR="src/core"
MANIFEST="$DEST_DIR/.upstream.sha256"

FILES=(analysis.mjs cache.mjs)

read -r -d '' BANNER <<'B' || true
/*
 * VENDORED — do not edit here.
 *
 * Upstream: https://github.com/daronthedragon/wallet-forensics-skill
 *           core/__FILE__
 *
 * The skill must stay installable by cloning it alone, so it cannot depend on
 * a package published from this repo. Copying the file and gating on drift is
 * therefore the honest arrangement: CI fetches upstream and fails if the two
 * differ, which is the check that was missing when these implementations
 * silently diverged.
 *
 * To change this logic: edit it upstream, then re-run scripts/sync-core.sh.
 */
B

mkdir -p "$DEST_DIR"
: > "$MANIFEST"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for f in "${FILES[@]}"; do
  echo "fetching $BASE/$f"
  curl -fsSL --retry 3 "$BASE/$f" -o "$tmp"

  if [ ! -s "$tmp" ]; then
    echo "error: upstream returned an empty $f" >&2
    exit 1
  fi

  sum="$(sha256sum "$tmp" | cut -d' ' -f1)"

  {
    echo "${BANNER//__FILE__/$f}"
    cat "$tmp"
  } > "$DEST_DIR/$f"

  echo "$sum  $f" >> "$MANIFEST"
  echo "  $f  $sum"
done

echo "synced ${#FILES[@]} files into $DEST_DIR"
