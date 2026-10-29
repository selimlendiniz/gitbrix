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
