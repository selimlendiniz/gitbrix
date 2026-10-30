#!/usr/bin/env bash
# Build the Flatpak from a release binary and install it for this user.
#
#   scripts/flatpak.sh
#
# Needs (user installs, no sudo):
#   flatpak install --user flathub org.flatpak.Builder org.gnome.Platform//49 org.gnome.Sdk//49
#
# Writes release/gitbrix.flatpak, a single-file bundle another machine
# installs with: flatpak install --user gitbrix.flatpak

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

# The binary only: the bundles aren't needed here.
pnpm tauri build --no-bundle

build=${XDG_CACHE_HOME:-$HOME/.cache}/gitbrix-flatpak
repo=$build/repo
mkdir -p release
flatpak run --user org.flatpak.Builder \
  --user --install --force-clean --disable-rofiles-fuse \
  --state-dir="$build/state" --repo="$repo" \
  "$build/app" flatpak/dev.gitbrix.app.yml
flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo \
  "$repo" release/gitbrix.flatpak dev.gitbrix.app
echo "Installed dev.gitbrix.app for this user; bundle: release/gitbrix.flatpak"
