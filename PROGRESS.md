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

### 2026-10-29 — no more git CLI: everything on libgit2; accounts

Selim asked for the app to work without `git` installed and to log in to
GitHub / GitLab (including self-hosted) with access tokens.

- Every write and network operation moved from the `git` CLI to libgit2;
  `cli.rs` is gone and nothing in the app runs `git` any more.
- What git does around operations is done by us: hooks (`hooks.rs`:
  pre-commit, prepare-commit-msg, commit-msg, post-commit, post-checkout,
  post-merge, pre-push), signing (`sign.rs`: gpg / gpgsm / ssh-keygen,
  commits and annotated tags), message cleanup, `GIT_AUTHOR_*` identity.
- ssh remotes use our own libgit2 transport (`ssh.rs`) that runs the
  system's `ssh` like git does, so `~/.ssh/config`, the agent, FIDO keys,
  `known_hosts` and `core.sshCommand` keep working (libgit2's libssh2 would
  ignore them). https uses libgit2 + OpenSSL.
- Rebases are our own engine (`rebase.rs`): state in `.git/rebase-merge/`,
  autostash in the stash list, conflicts stop it, continue / skip / abort.
  Gotcha found: libgit2's `reset` and `cleanup_state` delete the rebase
  directory, so skipping a step checks out HEAD instead of resetting.
- Other libgit2 gaps covered: stash pop drops the stash even on conflicts
  (now kept), force push "with lease" (checks the remote ref first),
  deleting a remote branch leaves the tracking ref (removed), merge
  messages say "into <branch>", merge/cherry-pick abort keeps unrelated
  local edits.
- Accounts (Settings → Accounts): GitHub or GitLab + address + token. The
  token is checked against the API, stored in the Secret Service keyring
  (KWallet here), and offered only to https remotes on the same host (and
  path, for several accounts on one GitLab). `~/.git-credentials` is a
  fallback. A GitLab token without `read_user` is stored as user `oauth2`.
- Packaging: the RPM no longer depends on `git`.
- An independent review of the move found 7 bugs, all fixed with tests:
  discard deleted nested repositories and ignored files (now like
  `git clean -f -d`); rebase abort left HEAD detached and reset during a
  stopped rebase destroyed it (libgit2's reset deletes `rebase-merge`);
  abort/skip with no operation in progress threw away staged work; stash
  over staged changes gave a raw libgit2 error; the GitLab token could
  follow redirects (redirects now off for the token check); accounts for
  a group path checked the token at the wrong API URL. Also: squash can't
  fold into the base, a manual commit during a stopped rebase keeps the
  original author, amend refused mid-merge, hook/gpg pipes can't
  deadlock, ssh signing scratch files in a private 0700 directory,
  worktrees with checked-out submodules aren't removed.

Tests: 89 Rust (new: hooks, ssh signing verified by git, rebase
continue/skip, cherry-pick author, merge abort, lease, remote branch delete
and tag push, ssh transport through a fake `ssh`, submodule update, stash
conflicts), 44 unit, 31 Playwright UI, 16 e2e steps — all passing.

### 2026-10-29 — image diffs, whitespace, edit message, branch hover

- Changed images show before/after side by side (commits, comparisons,
  history, working tree).
- "Ignore whitespace" for commit/comparison diffs; "Edit commit message…"
  on the HEAD commit (`commit --amend --only`, undoable).
- Hovering a branch label highlights its first-parent line; the author
  column was accidentally hidden at the default window size — fixed.
- Release RPM rebuilt; e2e passes on the release binary.

Tests: 65 Rust, 44 unit, 30 Playwright UI, 16 e2e steps — all passing.

### 2026-10-29 — reflog, history search, file tree, first-commit fix, review 2

- Reflog view (recover lost commits), whole-history search by file path or
  code (`git log -S`), file lists as a folder tree, keyboard navigation in
  file lists, open a folder by dropping it on the window, `~` in typed paths.
- Fixed: a repository without commits had no WIP row, so the first commit
  could not be made (found by a new e2e step).
- A second independent review found 1 bug + 6 risks in the newer code; all
  fixed (case-sensitive code search, symlinked .gitignore write-through,
  safer undo of branch creation, background fetch takes the busy lock, …).
- Turkish review guide for the user: `docs/INCELEME.md`.

Tests: 63 Rust, 44 unit, 28 Playwright UI, 15 e2e steps — all passing.

### 2026-10-29 — stashes in graph, hide/solo, worktrees, submodules, polish

- Stashes drawn in the graph above their base commit.
- Hide or solo branches in the graph (eye icon / branch menu), per repo.
- Worktrees: list, open in tab, create (branch menu "Open in new
  worktree…"), remove, prune. Submodules: list, open, update --init.
- Toolbar branch switcher; diverged ff-only pull offers a rebase;
  optional background auto-fetch (off by default — a locked ssh key would
  prompt every time); signed badge, co-authors, annotated tag messages.
- Narrow windows: graph drops author/date columns, side panels shrink.

Tests: 59 Rust, 43 unit, 23 Playwright UI, 12 e2e steps — all passing.

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
