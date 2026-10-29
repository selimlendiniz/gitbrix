#!/usr/bin/env bash
# Rebuild the demo repository and record src/mock/fixture.json from it.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

"$root/scripts/demo-repo.sh" "$tmp" >/dev/null
mkdir -p "$root/src/mock"
cd "$root/src-tauri"
GITBRIX_FIXTURE_REPO="$tmp/demo-app" \
GITBRIX_FIXTURE_OUT="$root/src/mock/fixture.json" \
GITBRIX_FIXTURE_PATH_AS="/home/demo/codes/demo-app" \
  cargo test --quiet --lib record_ui_fixture -- --ignored --exact git::tests::record_ui_fixture
echo "wrote src/mock/fixture.json ($(wc -c <"$root/src/mock/fixture.json") bytes)"
