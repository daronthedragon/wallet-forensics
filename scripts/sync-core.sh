#!/usr/bin/env bash
#
# Refresh the vendored analysis core from its upstream home in the skill repo.
#
# The skill has to stay installable by cloning it on its own, so it cannot
# depend on a package published from here. Vendoring plus a CI drift gate is
# the honest arrangement: one copy is authoritative, the other is a checked
# duplicate rather than a second implementation waiting to diverge.
#
# Usage: scripts/sync-core.sh
set -euo pipefail

UPSTREAM="https://raw.githubusercontent.com/daronthedragon/wallet-forensics-skill/main/core/analysis.mjs"
DEST="src/core/analysis.mjs"
SUMFILE="src/core/.analysis.sha256"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "fetching $UPSTREAM"
curl -fsSL "$UPSTREAM" -o "$tmp"

if [ ! -s "$tmp" ]; then
  echo "error: upstream returned an empty file" >&2
  exit 1
fi

sum="$(sha256sum "$tmp" | cut -d' ' -f1)"

{
  cat <<'BANNER'
/*
 * VENDORED — do not edit here.
 *
 * Upstream: https://github.com/daronthedragon/wallet-forensics-skill
 *           core/analysis.mjs
 *
 * The skill must stay installable by cloning it alone, so it cannot depend on
 * a package published from this repo. Copying the file and gating on drift is
 * therefore the honest arrangement: CI fetches upstream and fails if the two
 * differ, which is the check that was missing when these implementations
 * silently diverged.
 *
 * To change this logic: edit it upstream, then re-run scripts/sync-core.sh.
 */
BANNER
  cat "$tmp"
} > "$DEST"

echo "$sum" > "$SUMFILE"

echo "synced $DEST"
echo "upstream sha256: $sum"
