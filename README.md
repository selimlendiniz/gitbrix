# gitbrix

A fast, graph-first desktop Git client built with Tauri 2, Rust and React.

## Features

**History**
- Commit graph with lanes computed in Rust and drawn on canvas; handles
  tens of thousands of commits (pages of 5 000, more load as you scroll)
- Branch, remote and tag labels on the graph; local and remote branches on
  the same commit share one label
- Commit details, file lists with line counts, unified and split diffs with
  syntax highlighting and intra-line change marks
- Search (Ctrl+F) by message, author or SHA, or across all history by file
  path or by code (`git log -S`); compare any two commits
  (Ctrl/Shift+click); file history that follows renames; blame
- Stashes drawn in the graph; hide or solo branches; reflog view to
  recover lost commits

**Changes**
- Stage, unstage and discard whole files, single hunks or selected lines
- Commit and amend; the message draft survives switching views
- Merge conflict view: per conflict take ours, theirs or both
- Stash save / apply / pop / drop, and inspect a stash's changes

**Branches and remotes**
- Check out, create, rename, delete branches and tags; drag a branch onto
  another to merge, rebase or push
- Merge, rebase, cherry-pick, revert, reset (soft / mixed / hard)
- Interactive rebase editor: reorder, reword, squash, fixup, drop
- Fetch, pull (fast-forward / merge / rebase), push (force-with-lease),
  with live progress; add, edit and remove remotes; push tags
- Clone and create repositories; worktrees; submodules

**Comfort**
- Undo (Ctrl+Z) for commits, checkouts, merges, rebases, resets, branch
  and tag changes, stash drops
- Auto-refresh when files or refs change outside the app
- Tabs for several repositories, command palette (Ctrl+K), dark and light
  themes, resizable panels, keyboard shortcuts (press `?`)

All writes and network operations run the real `git` executable, so your
hooks, credential helpers, signing and ssh configuration apply as usual.

## Development

Tools are pinned in `mise.toml` (Rust, Node, pnpm, tauri-driver).

```bash
pnpm install
pnpm tauri dev               # run the app
src-tauri/target/release/gitbrix <path>   # a built binary opens <path>
pnpm dev                     # UI only in a browser, backed by a recorded fixture
                             #   http://localhost:1420/?open

pnpm test:rust               # backend tests against real throwaway repos
pnpm test:unit               # Vitest
pnpm test:ui                 # Playwright (system Chrome) against the fixture UI
pnpm test:e2e                # the real app under Xvfb via tauri-driver

pnpm tauri build --bundles rpm
```

Linux build dependencies (Fedora): `webkit2gtk4.1-devel openssl-devel
libappindicator-gtk3-devel librsvg2-devel libxdo-devel`; for e2e also
`webkitgtk6.0` (provides `WebKitWebDriver`) and `xorg-x11-server-Xvfb`.

## Layout

```
src-tauri/src/
  commands.rs        Tauri command surface
  watch.rs           file watcher → `repo-changed` events
  git/
    graph.rs         lane layout
    log.rs refs.rs   graph walk, branches, tags, stashes, remotes
    diff.rs status.rs history.rs
    ops.rs cli.rs    every write, through the git CLI
    rebase.rs        interactive rebase from a UI plan
src/
  store.ts           app state (Zustand)
  actions.ts undo.ts user-level operations, undo stack
  graph/ diff/       canvas drawing, patch building, conflicts, highlighting
  components/        UI
scripts/             demo repo, fixture recorder, big synthetic repo
tests/               unit, ui (Playwright), e2e (WebDriver)
```

See `PROGRESS.md` for the build log and `docs/PLAN.md` for the plan.
