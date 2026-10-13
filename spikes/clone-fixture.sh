#!/usr/bin/env bash
# Usage: spikes/clone-fixture.sh <api|react|hypermedia> <clone-name>
# Copy-on-write clone (APFS `cp -c`, falls back to plain copy) of a base fixture,
# including node_modules, so each spike mutates its own disposable app.
set -euo pipefail

kit="${1:?kit required}"
name="${2:?clone name required}"
apps="${SPIKE_APPS:-/tmp/adonisjs-mcp-m0}"
src="$apps/$kit"
dest="$apps/$name"

[[ -d "$src" ]] || { echo "missing base fixture $src; run spikes/create-fixtures.sh" >&2; exit 1; }
[[ ! -e "$dest" ]] || { echo "$dest already exists" >&2; exit 1; }

cp -cR "$src" "$dest" 2>/dev/null || cp -R "$src" "$dest"
echo "$dest"
