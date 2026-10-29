# gitbrix — progress log

Autonomous build log. Newest entries at the top. Plan: `docs/PLAN.md`.

## How to run

```bash
pnpm install
pnpm tauri dev                 # the real app
pnpm dev                       # UI only, in a browser, backed by src/mock/fixture.json
                               #   http://localhost:1420/?open opens the demo repo
cd src-tauri && cargo test     # backend tests (real git repos in temp dirs)
pnpm exec playwright test      # UI tests + screenshots in test-results/shots/
scripts/demo-repo.sh <dir>     # build a demo repo with branches/merges/stash/WIP
scripts/record-fixture.sh      # re-record the UI fixture from the demo repo
```

## Log

### 2026-10-29 — settings, remotes, compare, drag & drop, packaging, review

- Settings: dark / light / system theme, Pull button mode, date format;
  resizable sidebar and details panels.
- Remotes: add / edit URL / rename / remove / fetch one; push a branch or
  tag to a chosen remote; set / unset upstream.
- Compare any two commits (Ctrl/Shift+click).
- Drag a branch onto another: merge, rebase, check out & merge, push.
- Ignore untracked files (file / extension / folder), discard all, open
  file / show in folder, shortcuts help (`?`), branch folders in the
  sidebar, refs on the commit panel, double-click shortcuts, infinite scroll.
- Strict CSP for the webview; release RPM builds
  (`pnpm tauri build --bundles rpm` →
  `src-tauri/target/release/bundle/rpm/gitbrix-0.1.0-1.x86_64.rpm`, 3.2 MB).
  e2e passes against both debug and release binaries (`E2E_APP=…`).
- An independent code review found 4 bugs and 9 risks; all fixed with
  regression tests (literal pathspecs, undo safety, CRLF conflicts,
  non-UTF-8 partial staging, stale stash indices, refresh races, …).

Tests: 54 Rust, 42 unit, 19 Playwright UI, 10 e2e steps — all passing.

### 2026-10-29 — performance, stash view, undo, highlighting, tabs, palette

- Big-repo work (generated 50k commits, `scripts/big-repo.py`): fixed a
  watcher feedback loop (inotify *read* events triggered refreshes that
  never finished on large repos), compact graph payload, 5k-commit pages
  with "Load more", status-only refresh for working-tree changes,
  responsive graph column.
- Stashes are selectable: files, diffs, Pop/Apply/Drop.
- Undo (toolbar, Ctrl+Z) for HEAD-moving operations (`reset --keep` or
  switch back), branch/tag create/rename/delete, stash and stash drop.
- Syntax highlighting (highlight.js, lazy) + intra-line change marks.
- Repository tabs with session restore; e2e runs with isolated XDG dirs
  (earlier runs had written test repos into ~/.local/share/dev.gitbrix.app;
  that test-only directory was deleted).
- Command palette (Ctrl+K / Ctrl+Shift+P).

Tests: 47 Rust, 37 unit, 13 Playwright UI, 10 e2e steps — all passing.

### 2026-10-29 — steps 12–14: search, history/blame, clone/init, interactive rebase

- Ctrl+F commit search (message / author / SHA prefix), Enter steps through.
- File history (follows renames) with per-commit diff; blame at a commit or
  the work tree. From file context menus and the diff header.
- Clone (URL → folder name derived) and New repository dialogs; live
  `--progress` output for clone/fetch/pull/push shown in the toolbar.
- Interactive rebase editor: right-click a commit → "Interactive rebase
  from here…". Reorder by drag or Alt+↑/↓, p/r/s/f/d keys, reword inline.
  Backend writes the todo via GIT_SEQUENCE_EDITOR, rewords with
  `exec git commit --amend -F`, uses `--autostash`, refuses ranges with merges.
- The merge/rebase banner moved above the center view so it shows whatever
  is selected; when an operation stops on conflicts the WIP row is selected.

Tests: 43 Rust, 24 unit, 9 Playwright UI, 9 e2e steps — all passing.

### 2026-10-29 — steps 9–11: watcher, hunk/line staging, conflicts

- File watcher (`src-tauri/src/watch.rs`): edits and terminal commits show
  up without pressing refresh.
- Hunk and line staging/unstaging/discarding in the diff view (click a
  line, Shift+click for a range). Patches built in `src/diff/patch.ts`,
  applied with `git apply --cached [--reverse] --recount`.
- Merge conflict view: per-block ours / theirs / both, take-whole-file,
  save & mark resolved, then Continue from the banner.
- Real-app e2e (`pnpm test:e2e`): Xvfb + tauri-driver + WebKitWebDriver.
  7 steps incl. commit, branch, hunk staging, external change, conflict.
  Note: WebKitWebDriver's element-text endpoint returns "" — the runner
  reads `textContent` via script.

Tests: 32 Rust, 20 unit, 5 Playwright UI, 7 e2e steps — all passing.

### 2026-10-29 — step 1–8 foundation

Done:
- Tauri 2 + React 19 + TS scaffold, own icon and dark theme.
- Rust backend: `git2` for reads (graph walk, refs, status, diffs),
  `git` CLI for every write (hooks/credentials/signing behave like the terminal).
- Commit graph: lane layout in Rust (`src-tauri/src/git/graph.rs`), per-row
  self-contained segments, canvas renderer with row virtualization, author
  initials on nodes, WIP row on top of HEAD, ref pills (local+remote merged
  into one pill when on the same commit, `+N` overflow).
- Layout keeps the first-parent chain on the leftmost lane (side lanes fold
  into it) — fixed after the first screenshot showed `main` drifting right.
- Commit details panel, file list with +/− counts, unified and split diff.
- WIP panel: stage/unstage/discard per file and all, commit + amend,
  Ctrl+Enter, draft survives switching selection; merge/rebase/cherry-pick
  banner with Abort/Skip/Continue.
- Sidebar: local / remote (grouped) / tags / stashes, filter, ahead/behind,
  double-click checkout, context menus.
- Toolbar: Pull (ff-only default; merge/rebase in menu), Push (sets upstream
  on first push; force-with-lease in menu), Fetch, Branch, Stash, Pop.
- Graph context menu: checkout (detached), branch/tag here, cherry-pick,
  revert, merge, rebase, reset soft/mixed/hard, copy SHA/message.
- In-app dialogs/menus/toasts (no native alert/confirm).
- Browser mode with `mockIPC` + recorded fixture; Playwright UI tests with
  the system Chrome.

Tests: 23 Rust tests, 4 Playwright UI tests — all passing.

Decisions made without asking:
- Pull defaults to `--ff-only` (safest); other modes in the dropdown.
- Merge commits are diffed against the first parent.
- Graph loads up to 20 000 commits; a note shows when truncated.
- Stashes are listed in the sidebar but not drawn in the graph (yet).
