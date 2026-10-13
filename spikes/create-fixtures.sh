#!/usr/bin/env bash
# Scaffold base AdonisJS starter kits used by M0 spikes into $SPIKE_APPS
# (default /tmp/adonisjs-mcp-m0; disposable, outside the repository).
# Base fixtures are templates: never mutate them; clone with spikes/clone-fixture.sh.
set -euo pipefail

apps="${SPIKE_APPS:-/tmp/adonisjs-mcp-m0}"
mkdir -p "$apps"
cd "$apps"

for kit in api react hypermedia; do
  if [[ -d "$kit" ]]; then
    echo "skip $kit (exists)"
    continue
  fi
  npx -y create-adonisjs@3.4.0 "$kit" --kit="$kit" --pkg=npm >"$kit.log" 2>&1 &
done
wait
echo "fixtures ready in $apps"
