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

### 2026-10-31 — threads, reviews, suggestions, CI logs, comment notifications, partial stash, file finder, graph keys

- Threads: GitLab discussions / GitHub reviewThreads; reply, resolve
  (`forge.rs` reply_in/resolve_in, `src/review.ts`, `components/Threads.tsx`).
- Pending review (localStorage) → GitHub reviews API / GitLab draft_notes +
  bulk_publish (+ approve).
- Suggestions: written from a diff line; applied locally (`ops::apply_suggestion`).
- CI: `forge/ci.rs` (jobs, logs, retry; GitHub log redirect fetched
  without the token), `src/ansi.ts`, `components/CiDialog.tsx`.
- Comment/mention notifications: inbox carries comment counts and
  mentions (GitHub search, GitLab todos); grown conversations are read via
  `pull_request_conversation_for`. Fixed `newForReview` dropping memory fields.
- Partial stash built by hand (`ops::stash_paths`): libgit2 1.9.7's
  path-limited stash discards other files' changes.
- Ctrl+P file finder (`history::list_files`), README/Markdown in the file
  browser, graph keyboard navigation; search box autofocus fix.
- Markdown: service-rendered HTML (GitLab GraphQL bodyHtml, GitHub
  body_html), sanitized; local fallback keeps safe inline HTML.
- Graph canvas scrolls with the rows (no lag while scrolling).

### 2026-10-30 — issues, clashing branches, merge options, windows, settings file, updates, Flatpak

- Issues (`src-tauri/src/forge/issues.rs`, `src/issues.ts`, `components/Issues.tsx`):
  GitHub GraphQL / GitLab REST; sidebar section, issue window, "Start work"
  branch from the remote's main commit (no tracking of main), `Closes #N` hint.
  `forge::each_project` now lists anything per covered remote.
- Clashing branches (`git/overlap.rs`): `merge_trees` per remote branch,
  cached per (HEAD, tip); toolbar warning + file marks.
- Merge: "when checks pass" (GitHub enablePullRequestAutoMerge, GitLab
  merge_when_pipeline_succeeds/auto_merge); after merging, fetch, switch to
  the target, ff, delete the local branch only if it has nothing unpushed.
- Windows: per-window watcher and terminals (dropped on close), terminal
  output `emit_to` its window, `quit_app`, window titles, only the main
  window persists tabs and notifies; settings/workspaces sync via `storage`.
- Settings file (`src/transfer.ts`): export/import with validation, merge
  by id, accounts pending a token.
- Updates (`src-tauri/src/updates.rs`, `scripts/release.sh`): tauri-plugin-updater
  with the address from Settings; key in `~/.tauri/gitbrix.key` (not in the repo).
  Tried for real: a 0.1.0 AppImage updated itself to 0.1.1 from a local
  server; a wrong signature was refused; plain http to another host refused.
- Flatpak (`flatpak/`, `scripts/flatpak.sh`, `src-tauri/src/host.rs`): GNOME 49
  runtime, host programs via flatpak-spawn. Tried for real under WebDriver:
  graph, terminal on the host, update kind "flatpak".
- Tests: Rust 133, unit 63, Playwright 82, e2e 26 steps.

### 2026-10-30 — title bar items, Gravatar

- Title bar, left to right: app menu (the gitbrix mark: open, clone, new,
  recent repositories, palette, settings, shortcuts, about, quit), the
  tabs, a "⌄" list of every tab once they don't fit (the mouse wheel
  scrolls them sideways), a search box in the drag area that opens the
  command palette (its toolbar button is gone), then background work,
  the pull request bell and the account picture.
- Tab marks: a dot for uncommitted changes (red for conflicts), ↑ to push,
  ↓ to pull. The open repository's come live from the store; the other
  tabs' from `repo_summaries`, read again when tabs change, the app gets
  focus, the open repository is left, and on the pull request timer
  (`src/tabStatus.ts`).
- Bell: the account-wide list (`pull_request_inbox`, already polled for
  notifications) grouped into waiting for you / yours / assigned and
  others; the count is the first group. A request whose repository is
  open in the app (its `byRepo` list has it, with the remote) opens in
  the review panel; others open in the browser.
- Background work (`src/activity.ts`): auto-fetch, workspace fetches and
  pull request checks show as a spinner with their label; failures from
  these and from every `store.run` operation are kept (the same one
  again moves up with a count) with a red count until looked at. Auto-
  fetch errors were silent before; now they land here, still no toast.
- Account button: the picture of whoever commits in the open repository
  (profile or git config), a menu with the accounts and the profiles.
- Gravatar (`src-tauri/src/avatars.rs`): SHA-256 of the trimmed,
  lowercased address, `d=404` so a missing picture means initials;
  `<id>+name@users.noreply.github.com` uses GitHub's picture for that
  user id. Fetched 6 at a time, kept as data URLs in the app cache dir
  for a week (absent ones for a day); network failures aren't kept. No
  credentials, redirects allowed (no token involved). The webview's CSP
  stays `img-src 'self' data:`. Frontend batches the addresses rendered
  together into one call (`src/avatars.ts`). Shown in the graph dots
  (inside a ring of the lane colour), the author column, the commit
  panel (also co-authors), statistics and the account button. Settings
  → Author pictures turns it off.
- Fix: dialogs could run below the window (14vh top padding + a max
  height of 100vh − 32px); long Settings hid its Done button.
- Tests: Rust 125 (+3 avatars, local server), unit 54, Playwright 66
  (+7 `tests/ui/titlebar.spec.ts`), e2e 24 steps (tab names read from
  `.tab-name` now that tabs carry marks).

### 2026-10-30 — several commits, branch cleanup, auto-stash, bisect, line comments, releases, file tree, statistics

- Selection: Ctrl+click toggles, Shift+click selects a range (`store.multi`,
  `extendSelection`). Two commits still compare (now with cherry-pick both,
  revert both, squash); three or more open `MultiPanel`. Cherry-picking
  several runs through the rebase engine onto HEAD (`rebase::pick_onto_head`),
  so a conflict stops it and Continue/Skip/Abort pick it up; reverts go
  newest first; squash is an interactive rebase from the oldest commit's
  parent and refuses commits that aren't consecutive on the branch.
- Branch cleanup (`git/cleanup.rs`): local branches merged into the
  checked-out branch or main/master/develop, local branches whose upstream
  is gone, remote branches merged into the remote's default branch. Merged
  locals are ticked; gone ones are force-deleted only when ticked; remote
  deletions ask again. Local deletions go on the undo stack.
- Auto-stash in `store.run`: an operation stopped by "local changes would
  be overwritten" asks (or, with Settings → Auto-stash → Always, doesn't)
  to stash including untracked files, run again, and pop; a pop that
  conflicts leaves the stash and says so.
- Bisect (`git/bisect.rs`): state in git's own files (BISECT_START,
  BISECT_LOG, refs/bisect/*), so `git bisect log` agrees. The next commit
  splits the remaining candidates most evenly (exact up to 400, then the
  topological middle); skip; `bisect run` semantics for a command (0 good,
  125 skip, 1–127 bad). Banner with Good/Bad/Skip/Run/Stop, graph marks.
- Line comments on a request's diff: GitHub review comments (commit_id,
  line, side), GitLab discussions with a position from the MR's diff_refs.
  The request's range and conversation moved to `usePrView` so the diff
  view can show and post them.
- Releases: from a tag's menu; the tag is pushed first; notes are the
  commits since the closest older tag (by graph, not by time).
- File tree at any commit (`tree_at`, `file_at`), highlighted, with images.
- Statistics (`git/stats.rs`): totals, 52 weekly counts, weekday×hour in
  the author's time zone, contributors by email, files changed most in the
  last 1000 commits. Single-hue charts with hover titles.
- Fix on the way: a `window` listener at module level broke the unit tests
  that import actions (no window there); it is a store subscription now.
- Tests: Rust 122 (+8), unit 54, Playwright 59 (+7), e2e 24 (+3: auto-stash
  around a real checkout, squash from the compare panel, bisect run).

### 2026-10-30 — workspaces, profiles, terminal, PR create/review, CI, merge editor, LFS, patches

Selim asked for these in order; each is one commit with tests.

- Workspaces (`git/workspace.rs`, `WorkspaceDialog`): named repository
  lists (localStorage); each row sums up a repository without loading it
  (branch, ahead/behind, changed files, conflicts, last fetch); fetch all
  (4 at a time); add a repository, the open tabs or a folder's
  repositories (3 levels deep, skipping node_modules/target/…).
- Profiles (`profiles.rs`, Settings → Profiles, toolbar chip): name and
  email for commits plus allowed accounts; one active, folder rules win.
  `ops::author/committer` use the profile unless the repository's own
  config or GIT_AUTHOR_* set the identity. Accounts for credentials, PR
  lists and the inbox are filtered by the profile. The commit form shows
  who commits and why ("profile Work", "repository", "git config").
- Terminal (`terminal.rs`, portable-pty + xterm.js): the user's shell in
  the repository folder; one per tab, kept while hidden; Ctrl+` toggles;
  keys typed there don't trigger app shortcuts.
- Create pull/merge requests: branch menu / sidebar "+" / palette; target
  defaults to the project's default branch; reviewers from collaborators
  (GitHub) or members (GitLab); draft; pushes the branch first when the
  remote lacks its latest commit.
- Review in the app: clicking a request opens it in the details panel.
  Files: the request's head and target are fetched and diffed locally from
  their merge base (forks too). Conversation: description, comments,
  review verdicts, line comments (click → that file's diff); comment;
  approve; merge (merge / squash / rebase on GitHub, merge / squash on
  GitLab; delete the source branch, never a fork's). Checked live against
  the GitLab test MR (read only).
- CI: GitHub `statusCheckRollup` (one GraphQL query with aliases for up to
  50 commits), GitLab project pipelines (one call); marks on graph rows
  (click opens the pipeline) and on requests.
- Three-way merge editor replaces the per-block chooser: ours / base /
  theirs panes for the conflict at hand with context, the result as an
  editable text below. Picks rewrite only that conflict's block, so hand
  edits survive. The base comes from a diff3 re-merge of the index stages
  (`git2::merge_file`) when the work tree file has none. Ctrl+S saves;
  saving with markers left asks first.
- Git LFS (`git/lfs.rs`, no git-lfs needed): pointer parse/write; object
  store in the common git dir; staging (single and all) stores content
  and stages the pointer with the work tree file's stat data; status
  doesn't report filled-in files as modified; pointers left by a
  checkout/pull/clone are filled in automatically (once per HEAD); push
  uploads objects the pushed commits refer to (batch API, basic transfer,
  verify). Endpoint: lfs.url / remote.X.lfsurl / .lfsconfig, else
  `<remote>.git/info/lfs`; auth with the account token (https only, same
  host) or `git-lfs-authenticate` over ssh. Tested against an in-memory
  LFS server.
- Patches (`git/patch.rs`): save a commit or a compared range as a
  format-patch mailbox, copy as patch; apply a file as commits (author,
  date, message kept; RFC 2047 names) or to the work tree. Round-trip
  tested against `git am` and `git format-patch`.
- Fixes on the way: menus opened from a modal showed behind it; long
  dialogs (Settings) now scroll; chevrons ignored their rotation (toolbar
  down arrows pointed right).
- Tests: Rust 114 (+16), unit 54, Playwright 50 (+9), e2e 21 steps (+3:
  workspace, profiles, real terminal; the conflict step uses the new
  editor). Release bundles rebuilt.

### 2026-10-29 — Pull Requests window (every account)

- Toolbar button (badge: requests waiting for your approval) and command
  palette "Pull requests…" open a window listing, across all accounts, the
  open requests that involve you: To review / Mine / Assigned / All.
  GitHub: three searches in one GraphQL query (`review-requested:@me`,
  `author:@me`, `assignee:@me`); GitLab: `/merge_requests` with
  `reviewer_username`, `created_by_me`, `assigned_to_me` + approvals.
  Click opens in the browser; Approve… posts the approval.
- Approval now goes by account + project instead of remote, so it works
  from this window too.
- Notifications also come from this list, so requests in repositories that
  aren't open notify too; a request seen by both lists notifies once.

### 2026-10-29 — pull / merge requests and notifications

- `forge.rs`: open pull requests (GitHub, one GraphQL query) and merge
  requests (GitLab REST, plus each MR's approvals in parallel) for every
  remote an account covers; ssh remotes map to the https host. Per request:
  author, branches, draft, fork or not, whether the user may approve it
  (GitHub: write access or asked to review; GitLab: `user_can_approve`),
  approved by the user / overall. Token goes only to the account's host,
  no redirects, 20 s timeout.
- Sidebar "Pull Requests" section (hidden when no account covers the repo):
  `#N`/`!N`, title, draft / review / approve / ✓ badges, problems shown in
  place (missing account on github.com/gitlab.com, missing scope...). Click
  selects the source branch's commit; double-click checks it out (same-repo:
  tracks the remote branch; fork: fetches `refs/pull/N/head` or
  `refs/merge-requests/N/head` onto `pr/N` / `mr/N`). Menu: open in browser,
  check out, approve (asks first), copy link / branch.
- Checked on opening a repository and every 3 min (Settings → Pull
  requests) for all open tabs. A new request the user can approve (not
  theirs, not a draft, not approved yet) raises a desktop notification
  (tauri-plugin-notification); what was open when a project was first seen
  doesn't. Settings → Notifications turns it off.
- Live check (read only) against the GitLab test project: listed fine.

Tests: 96 Rust, 49 unit, 38 Playwright UI, 18 e2e steps — all passing.

### 2026-10-29 — drag and drop everywhere

- Drags are now tracked with mouse events (`src/dnd.ts`): HTML5 drag and
  drop doesn't reach the page in Tauri's Linux webview while file drops
  (used to open folders) are enabled, so the old branch-onto-branch drag
  most likely never worked in the real app.
- Sources: branch/tag labels (graph and sidebar), commit rows, stash rows
  and sidebar stashes, WIP files. Targets: branch labels, commit rows, the
  WIP row, remotes in the sidebar, the staged / unstaged lists. Actions come
  from `dropActions` (actions.ts): one direct action runs at once (staging
  a dragged file, comparing two commits), otherwise a menu opens. A ghost
  label follows the pointer, targets light up, Escape cancels, a click is
  still a click.
- New backend op `move_branch` (point a branch that isn't checked out at
  another commit; undoable).
- The interactive rebase editor reorders by mouse drag too.
- e2e drives a real pointer drag (WebDriver actions) in the app: a file
  onto the staged list, a branch onto a commit.

Tests: 90 Rust, 44 unit, 36 Playwright UI, 17 e2e steps — all passing.

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
