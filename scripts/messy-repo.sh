#!/usr/bin/env bash
# Build a deliberately tangled repository for manual testing: git-flow
# branches, many lanes open at once, criss-cross and octopus merges, a
# resolved conflict, a revert, a cherry-pick, renames, binary images, an
# orphan branch, two remotes that are ahead / behind / diverged, a gone
# upstream, a submodule, a worktree, several stashes and a working tree
# with every kind of change.
#
#   scripts/messy-repo.sh /path/to/new/dir
set -euo pipefail

dest=${1:?usage: messy-repo.sh <dir>}
# Only ever delete a directory this script created (or an empty one).
if [ -e "$dest" ] && [ -n "$(ls -A "$dest")" ] && [ ! -e "$dest/.gitbrix-messy" ]; then
  echo "refusing to overwrite non-generated directory: $dest" >&2
  exit 1
fi
rm -rf "$dest"
mkdir -p "$dest"
touch "$dest/.gitbrix-messy"
dest=$(cd "$dest" && pwd)
cd "$dest"

# Keep the user's own git config (signing, hooks, templates) out of this.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
RANDOM=42
t=1748736000 # 2025-06-01T00:00:00Z

names=("Ada Lovelace" "Grace Hopper" "Linus Torvalds" "Margaret Hamilton"
  "Ken Thompson" "Barbara Liskov" "Şükrü Çağlar" "Zoë Ångström" "Dennis Ritchie")
emails=(ada@example.com grace@example.com linus@example.com margaret@example.com
  ken@example.com barbara@example.com sukru@example.com zoe@example.com dmr@example.com)
who() { # who <index>
  export GIT_AUTHOR_NAME=${names[$1]} GIT_AUTHOR_EMAIL=${emails[$1]}
  export GIT_COMMITTER_NAME=${names[$1]} GIT_COMMITTER_EMAIL=${emails[$1]}
}
anyone() { who $((RANDOM % ${#names[@]})); }
step() { # advance the clock by roughly $1 seconds
  t=$((t + ${1:-5400} + RANDOM % 3600))
  export GIT_AUTHOR_DATE="@$t" GIT_COMMITTER_DATE="@$t"
}
add() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" >>"$1"; }
put() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" >"$1"; }
commit() { step; git add -A; git commit -q -m "$1" "${@:2}"; }
c() { add "$1" "$2"; commit "$3" "${@:4}"; }
merge() { step 1800; git merge -q --no-ff -m "$2" "$1"; }
png() { # png <path> <rrggbb>: a striped 48x48 image
  mkdir -p "$(dirname "$1")"
  python3 -I - "$1" "$2" <<'PY'
import struct, sys, zlib
path, color = sys.argv[1], bytes.fromhex(sys.argv[2])
w = h = 48
rows = (b"\0" + (color if y % 12 > 3 else b"\xff\xff\xff") * w for y in range(h))
def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
with open(path, "wb") as f:
    f.write(b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows)))
            + chunk(b"IEND", b""))
PY
}

git init -q --bare -b main origin.git
git init -q --bare -b main upstream.git

# A small library to use as a submodule.
git init -q -b main vendor-lib
(
  cd vendor-lib
  who 4
  c lib.c 'int add(int a, int b) { return a + b; }' "vendor: add()"
  c lib.c 'int sub(int a, int b) { return a - b; }' "vendor: sub()"
)

git init -q -b main messy-app
cd messy-app
git config core.autocrlf false
git remote add origin ../origin.git
git remote add upstream ../upstream.git

# --- main: the beginning ----------------------------------------------------
who 0
put README.md "# Messy app"
put package.json '{ "name": "messy-app", "version": "0.1.0" }'
put src/index.ts 'export const greeting = "hello";'
put src/util.py 'def slug(s):
    return s.lower().replace(" ", "-")'
put styles.css 'body { margin: 0; }'
put config/app.json '{
  "port": 8080,
  "debug": false
}'
put docs/old.md "Outdated notes."
printf 'echo off\r\necho build\r\n' >build.bat
printf '0.1.0' >VERSION
commit "Initial commit"
mkdir -p data
for i in $(seq 1 300); do echo "city-$i,$i"; done >data/cities.csv
commit "Add city dataset"
png assets/logo.png d03030
commit "Add logo"
git tag -a v0.1.0 -m "First public release"

# An experiment that forks early and is never merged: a very long lane.
git branch experiment/rewrite-in-rust

# --- develop and many features at once ----------------------------------------
git switch -q -c develop
who 1
c src/core.ts "export function core() {}" "Start core module"

features=(feature/auth-login feature/search feature/team-a/oauth/google
  feature/dark-mode feature/i18n feature/export-csv perf/cache-layer
  refactor/http-client)
verbs=(Add Fix Refactor Test Document Tweak Polish Handle)
for f in "${features[@]}"; do
  anyone
  c src/core.ts "// core step before $f" "Core: prepare for ${f##*/}"
  git branch "$f"
done

for round in 1 2 3 4 5; do
  for i in "${!features[@]}"; do
    f=${features[$i]}
    # Some branches skip a round so lanes have uneven lengths.
    [ $(((i + round) % 4)) -eq 0 ] && continue
    git switch -q "$f"
    who $((i % ${#names[@]}))
    slug=${f//\//-}
    c "src/$slug.ts" "// $round" "${verbs[$((RANDOM % ${#verbs[@]}))]} ${f##*/} (part $round)"
  done
  # Two branches keep up with develop by merging it in.
  if [ $round -eq 3 ]; then
    for f in feature/search perf/cache-layer; do
      git switch -q "$f"
      merge develop "Merge branch 'develop' into $f"
    done
  fi
  git switch -q develop
  anyone
  c src/core.ts "// develop round $round" "Core: round $round cleanup"
done

# The experiment gets commits interleaved with everything else.
git switch -q experiment/rewrite-in-rust
who 2
for i in $(seq 1 12); do
  c "rust/src/m$((i % 4)).rs" "// $i" "Rewrite: module $((i % 4)) step $i"
done

# Merge features back in a different order than they were started.
git switch -q develop
for f in feature/i18n feature/auth-login refactor/http-client feature/search \
  feature/team-a/oauth/google perf/cache-layer feature/dark-mode; do
  who 0
  merge "$f" "Merge branch '$f' into develop"
done
# feature/export-csv stays open and unmerged.

# Clean up some merged branches, as people do; others linger.
git branch -q -d feature/i18n refactor/http-client feature/team-a/oauth/google

# --- a conflict, resolved by hand ---------------------------------------------
git switch -q -c feature/config develop
who 3
put config/app.json '{
  "port": 9090,
  "debug": false
}'
commit "Config: move to port 9090"
git switch -q develop
who 1
put config/app.json '{
  "port": 3000,
  "debug": false
}'
commit "Config: use port 3000 for dev"
step 1800
git merge -q --no-ff -m "Merge branch 'feature/config' into develop" feature/config >/dev/null 2>&1 || true
put config/app.json '{
  "port": 3000,
  "metricsPort": 9090,
  "debug": false
}'
git add config/app.json
git commit -q --no-edit

# --- a revert -------------------------------------------------------------------
who 5
c src/cache.ts "export const enabled = true;" "Enable experimental response cache"
anyone
c src/core.ts "// unrelated" "Core: log startup time"
step
git revert --no-edit HEAD~1 >/dev/null

# --- rename, delete, image change -------------------------------------------------
who 6
mkdir -p src/helpers
git mv src/util.py src/helpers/text_utils.py
add src/helpers/text_utils.py 'def title(s):
    return s.title()'
commit "Move text helpers into src/helpers"
git rm -q docs/old.md
commit "Remove outdated notes"
png assets/logo.png 3050d0
commit "New logo colours"

# --- octopus merge -----------------------------------------------------------------
for d in api faq tutorial; do
  git switch -q -c "docs/$d" develop
  who 7
  c "docs/$d.md" "# ${d^}" "Docs: write $d page"
done
git switch -q develop
step 1800
git merge -q --no-ff -m "Merge docs branches" docs/api docs/faq docs/tutorial >/dev/null

# --- criss-cross merge ------------------------------------------------------------------
git switch -q -c cc/left develop
who 2
c src/left.ts "// left 1" "Left: first change"
left1=$(git rev-parse HEAD)
git switch -q -c cc/right develop
who 4
c src/right.ts "// right 1" "Right: first change"
right1=$(git rev-parse HEAD)
git switch -q cc/left
merge "$right1" "Merge right into left"
git switch -q cc/right
merge "$left1" "Merge left into right"
git switch -q develop
merge cc/left "Merge branch 'cc/left' into develop"
merge cc/right "Merge branch 'cc/right' into develop"

# --- release 1.0 / hotfix ------------------------------------------------------------------
git switch -q -c release/1.0 develop
who 0
put package.json '{ "name": "messy-app", "version": "1.0.0" }'
printf '1.0.0' >VERSION
commit "Bump version to 1.0.0"
c CHANGELOG.md "## 1.0.0
- Login, search, dark mode, caching" "Changelog for 1.0.0"
git switch -q main
merge release/1.0 "Merge branch 'release/1.0'"
git tag -a v1.0.0 -m "Version 1.0.0

The first stable release.
Highlights: login, search, dark mode."
git switch -q develop
merge release/1.0 "Merge branch 'release/1.0' into develop"
git branch -q -d release/1.0

git switch -q -c hotfix/1.0.1 main
who 2
c src/index.ts 'export const safe = true; // fixes crash on empty input' "Fix crash on empty input"
git switch -q main
merge hotfix/1.0.1 "Merge branch 'hotfix/1.0.1'"
git tag v1.0.1
git switch -q develop
step
git cherry-pick -x hotfix/1.0.1 >/dev/null

# --- odd commits ----------------------------------------------------------------------------
who 6
step
git commit -q --allow-empty -m "Trigger CI (empty commit)"
c src/core.ts "// tuned" "Tune the scheduler so that background jobs no longer starve interactive requests under heavy load"
c src/core.ts "// pairing" "Pair on error handling" -m "We walked through every error path in core.ts
and made sure each one is logged once, with context.

Co-authored-by: Grace Hopper <grace@example.com>
Co-authored-by: Ken Thompson <ken@example.com>"
c src/core.ts "// emoji" "✨ Sparkly startup banner 🚀"
# A commit whose author date is older than its parent's.
add src/core.ts "// backdated"
git add -A
GIT_AUTHOR_DATE="@$((t - 86400 * 20))" git commit -q -m "Port fix from old laptop (backdated author date)"

# --- orphan branch ---------------------------------------------------------------------------
git switch -q --orphan gh-pages
who 8
put index.html "<h1>messy-app</h1>"
commit "Publish site"
c index.html "<p>docs</p>" "Update site"
git switch -q develop

# --- submodule -------------------------------------------------------------------------------
who 4
step
git -c protocol.file.allow=always submodule add -q "$dest/vendor-lib" libs/vendor
git commit -q -m "Add vendor-lib as a submodule"
(cd ../vendor-lib && who 4 && c lib.c 'int mul(int a, int b) { return a * b; }' "vendor: mul()")
git -C libs/vendor fetch -q origin
git -C libs/vendor checkout -q origin/main
commit "Bump vendor-lib"

# --- release 2.0 -------------------------------------------------------------------------------
git switch -q main
merge develop "Merge branch 'develop' for 2.0"
git submodule update -q 2>/dev/null || true
who 0
put package.json '{ "name": "messy-app", "version": "2.0.0" }'
printf '2.0.0' >VERSION
commit "Release 2.0.0"
git tag -a v2.0.0 -m "Version 2.0.0"
git tag nightly-2025-09-01 HEAD~3

# --- remotes: ahead, behind, diverged, gone -----------------------------------------------------
git branch feature/old-thing develop
git push -q -u origin main develop feature/search feature/dark-mode feature/old-thing 2>/dev/null
git push -q origin --tags 2>/dev/null
git push -q upstream main v1.0.0 v2.0.0 2>/dev/null
git branch -q -u origin/main main

git clone -q ../origin.git ../teammate
(
  cd ../teammate
  who 3
  git switch -q develop
  c src/remote.ts "// from a teammate" "Teammate: add remote helper"
  c src/remote.ts "// more" "Teammate: retry on timeout"
  git push -q origin develop 2>/dev/null
  git switch -q -c feature/remote-only
  c src/ro.ts "// only on the server" "Work that only exists on origin"
  git push -q origin feature/remote-only 2>/dev/null
  git push -q origin --delete feature/old-thing 2>/dev/null
)
git clone -q ../upstream.git ../upstream-work
(
  cd ../upstream-work
  who 8
  c UPSTREAM.md "upstream note" "Upstream: security notice"
  git push -q origin main 2>/dev/null
)

who 0
c README.md "Unpushed line 1." "README: describe setup"
c README.md "Unpushed line 2." "README: describe testing"
git switch -q develop
who 1
c src/core.ts "// local only" "Core: local change not yet pushed"
git fetch -q --prune origin 2>/dev/null
git fetch -q upstream 2>/dev/null

# --- branches to try a conflict yourself ---------------------------------------------------------
for side in left right; do
  git switch -q -c "conflict/$side" main
  who 2
  put src/index.ts "export const greeting = \"hello from $side\";
export const safe = true; // fixes crash on empty input"
  commit "Greeting from the $side side"
done

# --- stashes on different bases --------------------------------------------------------------------
git switch -q main
add src/index.ts "// half-done on main"
git stash push -q -m "half-done idea on main"
git switch -q conflict/left
add src/index.ts "// wip left"
put scratch/new-file.txt "untracked in stash"
git stash push -q -u -m "left side WIP with a new file"
git switch -q develop
add src/core.ts "// try later"
git stash push -q -m "core experiment"

# --- a worktree with its own uncommitted change ----------------------------------------------------
git worktree add -q ../messy-app-hotfix -b hotfix/2.0.1 main
add ../messy-app-hotfix/src/index.ts "// hotfix in progress"

# --- the working tree: every kind of change ----------------------------------------------------------
git submodule update -q --init 2>/dev/null || true
add README.md "Staged README line."
git add README.md
sed -i 's/^city-5,5$/city-5,FIVE/' data/cities.csv
git add data/cities.csv
sed -i 's/^city-250,250$/city-250,TWO-FIFTY/' data/cities.csv
add src/core.ts "// unstaged edit"
rm src/feature-i18n.ts
mkdir -p src/styles
git mv styles.css src/styles/main.css
printf 'echo test\r\n' >>build.bat
printf '2.0.1-dev' >VERSION
png assets/logo.png 30a050
put "docs/release notes.md" "Draft release notes."
put "docs/türkçe notlar.md" "Taslak notlar."
put scratch/todo.txt "todo"
echo "// local tweak" >>libs/vendor/lib.c

echo "Messy repository ready: $dest/messy-app"
