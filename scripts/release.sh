#!/usr/bin/env bash
# Build a signed release and the manifest that announces it.
#
#   scripts/release.sh https://example.com/gitbrix "What changed"
#
# Writes release/<version>/: the AppImage, RPM and DEB with their .sig
# signatures, and latest.json pointing at <base-url>/<file>. Upload the
# folder's files to <base-url>; the app's Settings → Updates takes
# <base-url>/latest.json.
#
# The private key is read from $TAURI_SIGNING_PRIVATE_KEY_PATH
# (default ~/.tauri/gitbrix.key) and never leaves this machine. Without
# it, installed copies can't verify updates: keep a backup.
#
# VERSION=0.1.1 overrides the version in tauri.conf.json (for trying an
# update out locally).

set -euo pipefail

base=${1:?usage: scripts/release.sh <base-url> [notes]}
notes=${2:-}
root=$(cd "$(dirname "$0")/.." && pwd)
key=${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/gitbrix.key}
[[ -r $key ]] || { echo "No signing key at $key" >&2; exit 1; }

cd "$root"
version=${VERSION:-$(node -p "require('./src-tauri/tauri.conf.json').version")}
args=(--config src-tauri/tauri.updater.conf.json)
[[ -n ${VERSION:-} ]] && args+=(--config "{\"version\":\"$VERSION\"}")

TAURI_SIGNING_PRIVATE_KEY=$(cat "$key") \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-} \
  pnpm tauri build "${args[@]}"

bundle=src-tauri/target/release/bundle
out=release/$version
rm -rf "$out"
mkdir -p "$out"
files=(
  "appimage/gitbrix_${version}_amd64.AppImage"
  "rpm/gitbrix-${version}-1.x86_64.rpm"
  "deb/gitbrix_${version}_amd64.deb"
)
for f in "${files[@]}"; do
  cp "$bundle/$f" "$bundle/$f.sig" "$out/"
done

BASE=$base VERSION=$version NOTES=$notes OUT=$out node - <<'JS'
const fs = require("fs");
const { BASE, VERSION, NOTES, OUT } = process.env;
const entry = (file) => ({
  url: `${BASE.replace(/\/+$/, "")}/${file}`,
  signature: fs.readFileSync(`${OUT}/${file}.sig`, "utf8").trim(),
});
const appimage = entry(`gitbrix_${VERSION}_amd64.AppImage`);
const manifest = {
  version: VERSION,
  notes: NOTES,
  pub_date: new Date().toISOString(),
  platforms: {
    // Copies that don't say how they were installed get the AppImage.
    "linux-x86_64": appimage,
    "linux-x86_64-appimage": appimage,
    "linux-x86_64-rpm": entry(`gitbrix-${VERSION}-1.x86_64.rpm`),
    "linux-x86_64-deb": entry(`gitbrix_${VERSION}_amd64.deb`),
  },
};
fs.writeFileSync(`${OUT}/latest.json`, JSON.stringify(manifest, null, 2) + "\n");
JS

echo "release/$version:"
ls -1 "$out"
