# gitbrix — plan

Graph-first desktop Git client in the spirit of GitKraken. Own name, own
visual design; no third-party branding or assets.

## Stack

- **Shell:** Tauri 2 (Linux: WebKitGTK 4.1)
- **Backend:** Rust. Reads via `git2` (libgit2, no network features);
  writes and network ops via the `git` CLI so hooks, credential helpers,
  `~/.ssh/config` and GPG signing behave exactly like the terminal.
- **Frontend:** React 19 + TypeScript + Vite, Zustand for state.
  Commit graph drawn on `<canvas>` with fixed-height row virtualization;
  lane layout is computed in Rust.
- **Tests:** `cargo test` against throwaway repos built with the `git` CLI;
  Vitest for pure frontend logic; Playwright (system Chrome, headless)
  against the Vite dev server with `mockIPC` for UI screenshots;
  `tauri-driver` + Xvfb for real-window E2E.

## Layout

```
┌ toolbar: repo ▾ │ branch ▾ │ Undo Redo │ Pull Push Fetch │ Branch Stash Pop ┐
├ sidebar ──┬ graph ───────────────────────────────────────┬ details ────────┤
│ LOCAL     │ refs │ graph │ message          author  date │ WIP: unstaged / │
│ REMOTE    │      │  ●    │                               │ staged / commit │
│ TAGS      │      │  │ ●  │                               │ or commit info  │
│ STASHES   │      │       │                               │ + file list     │
├───────────┴───────────────────────────────────────────────┴─────────────────┤
│ diff viewer (opens over the graph when a file is selected)                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Feature order

Each step ends with tests passing and a commit. Order is chosen so every
step leaves a usable app.

1. Open repo (folder picker, recent repos), app shell, dark theme
2. Commit graph: topo walk over all refs, lane layout, canvas render,
   ref labels, virtualized scrolling
3. Commit details: metadata, changed files, per-file diff viewer
4. Working tree: status, stage/unstage file, discard, commit (amend)
5. Sidebar: local/remote branches, tags, stashes; checkout; create,
   rename, delete branch; double-click to checkout
6. Remote ops: fetch, pull (ff/rebase), push (set upstream), with
   progress and error surfacing
7. Context menus on graph rows: checkout, branch here, tag here,
   cherry-pick, revert, reset (soft/mixed/hard), merge into current,
   rebase current onto, copy SHA
8. Stash: save (with message), apply, pop, drop
9. Auto-refresh with a filesystem watcher
10. Hunk and line staging
11. Merge conflict resolution view
12. Search/filter commits; file history and blame
13. Multiple repos in tabs; keyboard shortcuts; command palette
14. Interactive rebase editor
15. Settings (theme, date format, graph density), packaging
