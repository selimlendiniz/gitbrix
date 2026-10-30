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
- Three-way merge editor for conflicts: ours, base and theirs side by
  side, the result below as an editable file; per conflict take ours,
  theirs, both or the base
- Git LFS without the git-lfs program: LFS files are staged as pointers,
  filled in after checkouts, pulls and clones, and uploaded before a push;
  track a file type with LFS from the file menu
- Patches: save commits (or a compared range) as `format-patch` files or
  copy them; apply a patch file as commits with their authors (`git am`)
  or to the working tree (`git apply`)
- Stash save / apply / pop / drop, and inspect a stash's changes

**Branches and remotes**
- Check out, create, rename, delete branches and tags
- Drag and drop: a branch onto a branch (merge, rebase), onto a commit
  (move it there, or reset / rebase the checked-out one), onto a remote
  (push); a commit onto a branch (cherry-pick, move the branch) or onto
  another commit (compare); a stash onto the WIP row (apply, pop); files
  between the unstaged and staged lists; commits in the interactive
  rebase editor
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
  themes, resizable panels, keyboard shortcuts (press `?`), own title bar
- Workspaces: many repositories in one list with branch, ahead/behind and
  local changes; fetch them all at once; add a folder's repositories
- Profiles (work, personal…): the name and email commits are made with,
  and which accounts are used; folder rules pick the profile per
  repository
- Embedded terminal (Ctrl+`), one shell per repository tab

Everything runs on libgit2; the `git` program is not needed. What git
would do around an operation is done here too: hooks (`pre-commit`,
`commit-msg`, `pre-push`, `post-*`) run, commits and tags are signed when
`commit.gpgsign` / `tag.gpgsign` say so (gpg, gpgsm or ssh keys), ssh
remotes go through the system's `ssh` (so `~/.ssh/config`, the agent and
`known_hosts` apply), and rebases, cherry-picks and merges stop on
conflicts and continue the same way.

**Accounts.** For https remotes add a GitHub or GitLab account (self-hosted
GitLab too) with a personal access token in Settings → Accounts. The token
is checked with the service, kept in the system keyring (KWallet, GNOME
Keyring) and sent only to that host over https. `~/.git-credentials` is
read as a fallback.

**Pull / merge requests.** With an account, the sidebar lists the open pull
requests (GitHub) or merge requests (GitLab) of the repository's remotes:
review it in the app (its files and diffs, the conversation; comment,
approve, merge), check it out or open it in the browser. Create one from
a branch's menu, with reviewers and as a draft; the branch is pushed
first if needed. CI status (GitHub checks, GitLab pipelines) shows on
commits in the graph and on requests. The Pull Requests
button in the toolbar lists those involving you on every account (to
review, yours, assigned). New ones you can
approve raise a desktop notification (checked every 3 minutes for every
open tab; Settings → Pull requests / Notifications). GitLab tokens need
`read_api` (or `api` to approve); GitHub fine-grained tokens need "Pull
requests" access.

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
libappindicator-gtk3-devel librsvg2-devel libxdo-devel dbus-devel`; for
e2e also `webkitgtk6.0` (provides `WebKitWebDriver`) and
`xorg-x11-server-Xvfb`. The tests build their scratch repositories with
the `git` CLI; the app itself doesn't use it.

## Layout

```
src-tauri/src/
  commands.rs        Tauri command surface
  watch.rs           file watcher → `repo-changed` events
  git/
    graph.rs         lane layout
    log.rs refs.rs   graph walk, branches, tags, stashes, remotes
    diff.rs status.rs history.rs
    ops.rs           index, commits, branches, stashes, merges
    net.rs ssh.rs    fetch / pull / push / clone; ssh through `ssh`
    rebase.rs        plain and interactive rebases, stop and continue
    hooks.rs sign.rs hooks and commit / tag signing
  accounts.rs        GitHub / GitLab tokens in the system keyring
src/
  store.ts           app state (Zustand)
  actions.ts undo.ts user-level operations, undo stack
  graph/ diff/       canvas drawing, patch building, conflicts, highlighting
  components/        UI
scripts/             demo repo, fixture recorder, big synthetic repo
tests/               unit, ui (Playwright), e2e (WebDriver)
```

See `PROGRESS.md` for the build log and `docs/PLAN.md` for the plan.
