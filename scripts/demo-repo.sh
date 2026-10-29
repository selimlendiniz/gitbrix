#!/usr/bin/env bash
# Build a demo repository with branches, merges, tags, a remote, a stash
# and a dirty working tree. Used to record the UI fixture and for manual
# testing.
#
#   scripts/demo-repo.sh /path/to/new/dir
set -euo pipefail

dest=${1:?usage: demo-repo.sh <dir>}
# Only ever delete a directory this script created (or an empty one).
if [ -e "$dest" ] && [ -n "$(ls -A "$dest")" ] && [ ! -e "$dest/.gitbrix-demo" ]; then
  echo "refusing to overwrite non-demo directory: $dest" >&2
  exit 1
fi
rm -rf "$dest"
mkdir -p "$dest"
touch "$dest/.gitbrix-demo"
cd "$dest"

git init -q --bare -b main origin.git
git init -q -b main demo-app
cd demo-app
git config user.name "Ada Lovelace"
git config user.email ada@example.com
git config commit.gpgsign false
git config tag.gpgsign false
git config core.hooksPath /dev/null
git remote add origin ../origin.git

t=1767225600 # 2026-01-01T00:00:00Z
as() { # as "<name>" <email> -- commit as another author
  export GIT_AUTHOR_NAME=$1 GIT_AUTHOR_EMAIL=$2
}
c() { # c <file> <line> <message>
  t=$((t + 3600 * 7))
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >>"$1"
  git add -A
  GIT_AUTHOR_DATE="@$t" GIT_COMMITTER_DATE="@$t" git commit -q -m "$3"
}
merge() { # merge <branch> <message>
  t=$((t + 3600 * 3))
  GIT_AUTHOR_DATE="@$t" GIT_COMMITTER_DATE="@$t" git merge -q --no-ff -m "$2" "$1"
}

as "Ada Lovelace" ada@example.com
c README.md "# Demo project" "Initial commit"
c src/main.rs 'fn main() { println!("hello"); }' "Add main entry point"
c Cargo.toml '[package] name = "demo"' "Add Cargo manifest"
git tag -a v0.1.0 -m "First release"

git switch -q -c feature/parser
as "Grace Hopper" grace@example.com
c src/parser.rs "pub fn parse() {}" "Add parser skeleton"
c src/parser.rs "// handle comments" "Parser: handle comments"

git switch -q main
as "Ada Lovelace" ada@example.com
c docs/guide.md "## Getting started" "Write getting started guide"

git switch -q -c fix/typo
as "Linus Torvalds" linus@example.com
c README.md "Fixed a typo." "Fix typo in README"
git switch -q main
merge fix/typo "Merge branch 'fix/typo'"

git switch -q feature/parser
as "Grace Hopper" grace@example.com
c src/parser.rs "pub fn tokens() {}" "Parser: tokenizer"
git switch -q main
merge feature/parser "Merge branch 'feature/parser'"
git tag v0.2.0

git switch -q -c feature/ui
as "Margaret Hamilton" margaret@example.com
c src/ui.rs "pub fn draw() {}" "Start UI module"
c src/ui.rs "pub fn layout() {}" "UI: layout pass"

git switch -q main
as "Ada Lovelace" ada@example.com
c src/main.rs "// wire parser" "Wire parser into main"
c CHANGELOG.md "- 0.2.0: parser" "Update changelog"

git push -q -u origin main feature/ui
git switch -q feature/ui
as "Margaret Hamilton" margaret@example.com
c src/ui.rs "pub fn theme() {}" "UI: dark theme"

git switch -q -c experiment/fast-path main~1
as "Linus Torvalds" linus@example.com
c src/fast.rs "pub fn fast() {}" "Experiment: fast path"

git switch -q main
as "Ada Lovelace" ada@example.com
c src/main.rs "// tidy" "Tidy up main"

# A stash, then a dirty working tree: one staged, one modified, one new.
printf 'stash me\n' >>docs/guide.md
git stash push -q -m "half-written docs"
printf 'staged change\n' >>CHANGELOG.md
git add CHANGELOG.md
printf '// unstaged edit\n' >>src/main.rs
printf 'notes\n' >notes.txt

echo "Demo repository ready: $dest/demo-app"
