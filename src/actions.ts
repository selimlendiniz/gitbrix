// User-level git actions shared by the toolbar, sidebar, graph and menus.
// Each one asks for input or confirmation where needed, then runs through
// the store so errors become toasts and the view refreshes afterwards.

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { api, CommitRow, PullMode, RefInfo, RemoteInfo, ResetMode, StashInfo, WIP_ID, Worktree } from "./api";
import { shortId } from "./format";
import { MenuItem, useStore } from "./store";
import { pushUndo, trackHead } from "./undo";

const s = () => useStore.getState();

function copy(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => s().toast("info", "Copied to clipboard"),
    () => s().toast("error", "Clipboard is not available"),
  );
}

function currentBranch(): string | null {
  return s().repo?.headBranch ?? null;
}

export function remoteOf(ref: RefInfo): { remote: string; branch: string } {
  const i = ref.name.indexOf("/");
  return { remote: ref.name.slice(0, i), branch: ref.name.slice(i + 1) };
}

export async function checkoutRef(ref: RefInfo) {
  if (ref.kind === "local") {
    if (ref.isHead) return;
    await trackHead(`checkout ${ref.name}`, () =>
      s().run(`Checking out ${ref.name}`, (r) => api.checkoutBranch(r, ref.name), `Switched to ${ref.name}`),
    );
  } else if (ref.kind === "remote") {
    const { branch } = remoteOf(ref);
    await trackHead(`checkout ${branch}`, () =>
      s().run(`Checking out ${ref.name}`, (r) => api.checkoutRemote(r, ref.name, branch), `Switched to ${branch} tracking ${ref.name}`),
    );
  } else {
    await checkoutDetached(ref.target, ref.name);
  }
}

export async function checkoutDetached(rev: string, label = shortId(rev)) {
  const ok = await s().confirm({
    title: "Detached HEAD",
    message: `Check out ${label} without a branch? New commits won't belong to any branch until you create one.`,
    confirmLabel: "Check out",
  });
  if (!ok) return;
  await trackHead(`checkout ${label}`, () => s().run(`Checking out ${label}`, (r) => api.checkoutDetached(r, rev)));
}

export async function createBranch(start: string | null, startLabel?: string) {
  const res = await s().prompt({
    title: startLabel ? `New branch at ${startLabel}` : "New branch",
    label: "Branch name",
    placeholder: "feature/my-change",
    confirmLabel: "Create branch",
    checkbox: { label: "Check out after creating", initial: true },
  });
  const name = res?.value.trim();
  if (!res || !name) return;
  const repo = s().repo;
  const prevBranch = repo?.headBranch ?? null;
  const prevOid = repo?.headOid ?? null;
  const ok = await s().run(`Creating ${name}`, (r) => api.createBranch(r, name, start, res.checked), `Created branch ${name}`);
  if (ok && repo) {
    pushUndo({
      label: `create branch ${name}`,
      repo: repo.path,
      run: async (r) => {
        if (res.checked) {
          if (prevBranch) await api.checkoutBranch(r, prevBranch);
          else if (prevOid) await api.checkoutDetached(r, prevOid);
        }
        await api.deleteBranch(r, name, true);
      },
    });
  }
}

export async function createTag(target: string, targetLabel: string) {
  const res = await s().prompt({
    title: `New tag at ${targetLabel}`,
    label: "Tag name",
    placeholder: "v1.0.0",
    confirmLabel: "Create tag",
    textarea: { label: "Message (optional, makes an annotated tag)" },
  });
  const name = res?.value.trim();
  if (!res || !name) return;
  const ok = await s().run(`Tagging ${name}`, (r) => api.createTag(r, name, target, res.text || null), `Created tag ${name}`);
  const repo = s().repo?.path;
  if (ok && repo) pushUndo({ label: `create tag ${name}`, repo, run: (r) => api.deleteTag(r, name) });
}

export async function renameBranch(ref: RefInfo) {
  const res = await s().prompt({ title: `Rename ${ref.name}`, label: "New name", initial: ref.name, confirmLabel: "Rename" });
  const name = res?.value.trim();
  if (!res || !name || name === ref.name) return;
  const ok = await s().run(`Renaming ${ref.name}`, (r) => api.renameBranch(r, ref.name, name));
  const repo = s().repo?.path;
  if (ok && repo) pushUndo({ label: `rename ${ref.name}`, repo, run: (r) => api.renameBranch(r, name, ref.name) });
}

export async function deleteBranch(ref: RefInfo) {
  if (ref.kind === "remote") {
    const { remote, branch } = remoteOf(ref);
    const ok = await s().confirm({
      title: "Delete remote branch",
      message: `Delete ${branch} on ${remote}? This removes it for everyone using that remote.`,
      confirmLabel: "Delete on remote",
      danger: true,
    });
    if (ok) await s().run(`Deleting ${ref.name}`, (r) => api.deleteRemoteBranch(r, remote, branch), `Deleted ${ref.name}`);
    return;
  }
  const ok = await s().confirm({
    title: "Delete branch",
    message: `Delete local branch ${ref.name}?`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const repo = s().repo?.path;
  const restore = () =>
    repo && pushUndo({ label: `delete branch ${ref.name}`, repo, run: (r) => api.createBranch(r, ref.name, ref.target, false) });
  const done = await s().run(`Deleting ${ref.name}`, (r) => api.deleteBranch(r, ref.name, false), `Deleted ${ref.name}`);
  if (done) {
    restore();
    return;
  }
  // `git branch -d` refuses unmerged branches; offer the forced delete.
  const force = await s().confirm({
    title: "Branch is not fully merged",
    message: `${ref.name} has commits that are not merged anywhere. Delete it anyway? Those commits may be lost.`,
    confirmLabel: "Force delete",
    danger: true,
  });
  if (force && (await s().run(`Deleting ${ref.name}`, (r) => api.deleteBranch(r, ref.name, true), `Deleted ${ref.name}`))) restore();
}

export async function deleteTag(ref: RefInfo) {
  const ok = await s().confirm({ title: "Delete tag", message: `Delete local tag ${ref.name}?`, confirmLabel: "Delete", danger: true });
  if (!ok) return;
  const done = await s().run(`Deleting ${ref.name}`, (r) => api.deleteTag(r, ref.name), `Deleted tag ${ref.name}`);
  const repo = s().repo?.path;
  // Recreated as a lightweight tag; an annotated tag's message is not kept.
  if (done && repo) pushUndo({ label: `delete tag ${ref.name}`, repo, run: (r) => api.createTag(r, ref.name, ref.target, null) });
}

export async function mergeInto(rev: string, label: string) {
  const head = currentBranch() ?? "HEAD";
  const ok = await s().confirm({ title: "Merge", message: `Merge ${label} into ${head}?`, confirmLabel: "Merge" });
  if (ok) await trackHead(`merge ${label}`, () => s().run(`Merging ${label}`, (r) => api.merge(r, rev), `Merged ${label} into ${head}`));
}

export async function rebaseOnto(rev: string, label: string) {
  const head = currentBranch() ?? "HEAD";
  const ok = await s().confirm({
    title: "Rebase",
    message: `Rebase ${head} onto ${label}? Commits on ${head} will be rewritten.`,
    confirmLabel: "Rebase",
  });
  if (ok) await trackHead(`rebase onto ${label}`, () => s().run(`Rebasing onto ${label}`, (r) => api.rebase(r, rev), `Rebased ${head} onto ${label}`));
}

export async function cherryPick(c: CommitRow) {
  await trackHead(`cherry-pick ${shortId(c.id)}`, () =>
    s().run(`Cherry-picking ${shortId(c.id)}`, (r) => api.cherryPick(r, c.id), `Cherry-picked ${shortId(c.id)}`),
  );
}

export async function revertCommit(c: CommitRow) {
  const ok = await s().confirm({
    title: "Revert commit",
    message: `Create a new commit that undoes ${shortId(c.id)} “${c.summary}”?`,
    confirmLabel: "Revert",
  });
  if (ok) await trackHead(`revert ${shortId(c.id)}`, () => s().run(`Reverting ${shortId(c.id)}`, (r) => api.revert(r, c.id), `Reverted ${shortId(c.id)}`));
}

export async function resetTo(c: CommitRow, mode: ResetMode) {
  const head = currentBranch() ?? "HEAD";
  const what = {
    soft: "keep all changes staged",
    mixed: "keep all changes in the working tree, unstaged",
    hard: "DISCARD all uncommitted changes and commits after it",
    keep: "keep local changes, refusing if they would be overwritten",
  }[mode];
  const ok = await s().confirm({
    title: `Reset ${head} (${mode})`,
    message: `Move ${head} to ${shortId(c.id)} and ${what}.`,
    confirmLabel: `Reset ${mode}`,
    danger: mode === "hard",
  });
  if (ok) await trackHead(`reset to ${shortId(c.id)}`, () => s().run(`Resetting to ${shortId(c.id)}`, (r) => api.reset(r, c.id, mode)));
}

export async function fetchAll() {
  await s().run("Fetching", (r) => api.fetch(r), "Fetched all remotes");
}

export async function pull(mode: PullMode) {
  const ok = await trackHead("pull", () => s().run("Pulling", (r) => api.pull(r, mode), "Pulled"));
  const repo = s().repo;
  // Fast-forward refused because both sides have commits: offer a rebase.
  if (!ok && mode === "ff-only" && repo && repo.ahead > 0 && repo.behind > 0) {
    const rebase = await s().confirm({
      title: "Branch has diverged",
      message: `${repo.headBranch} has ${repo.ahead} commit${repo.ahead === 1 ? "" : "s"} that ${repo.upstream} doesn't, and ${repo.behind} the other way. Rebase your commits on top of ${repo.upstream}? (Pull ▾ also offers a merge.)`,
      confirmLabel: "Pull with rebase",
    });
    if (rebase) await pull("rebase");
  }
}

/** Fetch in the background: no busy state, no success toast. */
export async function backgroundFetch() {
  const st = s();
  const repo = st.repo;
  if (!repo || st.busy || st.remotes.length === 0) return;
  try {
    await api.fetch(repo.path);
    if (s().repo?.path === repo.path && !s().busy) await s().refresh();
  } catch {
    // Offline or no credentials: stay quiet; a manual fetch shows errors.
  }
}

export function branchSwitchMenu(): MenuItem[] {
  const locals = (s().graph?.refs ?? []).filter((r) => r.kind === "local");
  return [
    ...locals.map((r) => ({
      label: `${r.isHead ? "✓ " : ""}${r.name}`,
      disabled: r.isHead,
      hint: r.ahead || r.behind ? `↑${r.ahead} ↓${r.behind}` : undefined,
      onSelect: () => checkoutRef(r),
    })),
    { separator: true, label: "" },
    { label: "New branch…", onSelect: () => createBranch(null) },
  ];
}

export async function push(force = false) {
  const repo = s().repo;
  if (!repo) return;
  if (repo.unborn) {
    s().toast("error", "Nothing to push yet: make a first commit");
    return;
  }
  if (repo.detached) {
    s().toast("error", "HEAD is detached: check out a branch to push");
    return;
  }
  if (force) {
    const ok = await s().confirm({
      title: "Force push",
      message: `Overwrite ${repo.upstream ?? "the remote branch"} with your local ${repo.headBranch}? Uses --force-with-lease, so it stops if someone else pushed in the meantime.`,
      confirmLabel: "Force push",
      danger: true,
    });
    if (!ok) return;
  }
  await s().run("Pushing", (r) => api.push(r, force), `Pushed ${repo.headBranch}`);
}

export async function stashSave() {
  const res = await s().prompt({
    title: "Stash changes",
    label: "Message (optional)",
    placeholder: "work in progress",
    confirmLabel: "Stash",
    allowEmpty: true,
    checkbox: { label: "Include untracked files", initial: true },
  });
  if (!res) return;
  const ok = await s().run("Stashing", (r) => api.stashSave(r, res.value.trim() || null, res.checked), "Changes stashed");
  const repo = s().repo?.path;
  const id = s().stashes[0]?.id ?? null; // the refresh after `run` lists the new stash first
  if (ok && repo && id) pushUndo({ label: "stash", repo, run: (r) => api.stashApply(r, 0, true, id) });
}

function stashId(index: number): string | null {
  return s().stashes.find((st) => st.index === index)?.id ?? null;
}

export async function stashPop(index = 0) {
  const id = stashId(index);
  await s().run("Popping stash", (r) => api.stashApply(r, index, true, id), "Stash applied and dropped");
}

export async function stashApply(index: number) {
  const id = stashId(index);
  await s().run("Applying stash", (r) => api.stashApply(r, index, false, id), "Stash applied");
}

export async function stashDrop(st: StashInfo) {
  const ok = await s().confirm({
    title: "Drop stash",
    message: `Delete stash@{${st.index}} “${st.message}”?`,
    confirmLabel: "Drop",
    danger: true,
  });
  if (!ok) return;
  const done = await s().run("Dropping stash", (r) => api.stashDrop(r, st.index, st.id), "Stash dropped");
  const repo = s().repo?.path;
  if (done && repo) pushUndo({ label: "drop stash", repo, run: (r) => api.stashStore(r, st.id, st.message) });
}

export async function discardFiles(paths: string[]) {
  const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
  const ok = await s().confirm({
    title: "Discard changes",
    message: `Discard unstaged changes in ${what}? Untracked files are deleted. This cannot be undone.`,
    confirmLabel: "Discard",
    danger: true,
  });
  if (ok) await s().run("Discarding", (r) => api.discard(r, paths), undefined, "status");
}

export function stashMenu(st: StashInfo): MenuItem[] {
  return [
    { label: "Apply stash", onSelect: () => stashApply(st.index) },
    { label: "Pop stash", onSelect: () => stashPop(st.index) },
    { separator: true, label: "" },
    { label: "Drop stash", danger: true, onSelect: () => stashDrop(st) },
  ];
}

export function refMenu(ref: RefInfo): MenuItem[] {
  return [...refMenuItems(ref), { separator: true, label: "" }, ...graphItems(ref)];
}

function refMenuItems(ref: RefInfo): MenuItem[] {
  const head = currentBranch();
  const items: MenuItem[] = [];
  if (ref.kind === "local") {
    items.push(
      { label: `Check out ${ref.name}`, disabled: ref.isHead, onSelect: () => checkoutRef(ref) },
      { label: "Create branch here…", onSelect: () => createBranch(ref.name, ref.name) },
      { separator: true, label: "" },
      { label: `Merge ${ref.name} into ${head ?? "HEAD"}`, disabled: ref.isHead, onSelect: () => mergeInto(ref.name, ref.name) },
      { label: `Rebase ${head ?? "HEAD"} onto ${ref.name}`, disabled: ref.isHead, onSelect: () => rebaseOnto(ref.name, ref.name) },
      { separator: true, label: "" },
      ...branchRemoteItems(ref),
      { separator: true, label: "" },
      { label: "Open in new worktree…", disabled: ref.isHead, onSelect: () => addWorktree(ref) },
      { label: "Rename…", onSelect: () => renameBranch(ref) },
      { label: "Delete…", danger: true, disabled: ref.isHead, onSelect: () => deleteBranch(ref) },
      { separator: true, label: "" },
      { label: "Copy branch name", onSelect: () => copy(ref.name) },
    );
  } else if (ref.kind === "remote") {
    items.push(
      { label: `Check out ${remoteOf(ref).branch}`, onSelect: () => checkoutRef(ref) },
      { label: "Create branch here…", onSelect: () => createBranch(ref.name, ref.name) },
      { separator: true, label: "" },
      { label: `Merge ${ref.name} into ${head ?? "HEAD"}`, onSelect: () => mergeInto(ref.name, ref.name) },
      { label: `Rebase ${head ?? "HEAD"} onto ${ref.name}`, onSelect: () => rebaseOnto(ref.name, ref.name) },
      { separator: true, label: "" },
      { label: "Delete on remote…", danger: true, onSelect: () => deleteBranch(ref) },
      { label: "Copy branch name", onSelect: () => copy(ref.name) },
    );
  } else {
    items.push(
      { label: `Check out ${ref.name}`, onSelect: () => checkoutRef(ref) },
      { label: "Create branch here…", onSelect: () => createBranch(ref.name, ref.name) },
      { separator: true, label: "" },
      ...tagRemoteItems(ref),
      { separator: true, label: "" },
      { label: "Delete tag…", danger: true, onSelect: () => deleteTag(ref) },
      { label: "Copy tag name", onSelect: () => copy(ref.name) },
    );
  }
  return items;
}

export function commitMenu(c: CommitRow): MenuItem[] {
  if (c.id === WIP_ID) {
    return [
      { label: "Stash all changes…", onSelect: () => stashSave() },
      { label: "Stage all", onSelect: () => s().run("Staging", (r) => api.stageAll(r), undefined, "status") },
      { label: "Unstage all", onSelect: () => s().run("Unstaging", (r) => api.unstageAll(r), undefined, "status") },
    ];
  }
  const head = currentBranch();
  const sid = shortId(c.id);
  return [
    { label: "Check out this commit…", onSelect: () => checkoutDetached(c.id) },
    { label: "Create branch here…", onSelect: () => createBranch(c.id, sid) },
    { label: "Create tag here…", onSelect: () => createTag(c.id, sid) },
    { separator: true, label: "" },
    { label: "Cherry-pick commit", onSelect: () => cherryPick(c) },
    { label: "Revert commit…", onSelect: () => revertCommit(c) },
    { separator: true, label: "" },
    { label: `Merge into ${head ?? "HEAD"}`, onSelect: () => mergeInto(c.id, sid) },
    { label: `Rebase ${head ?? "HEAD"} onto this`, onSelect: () => rebaseOnto(c.id, sid) },
    {
      label: "Interactive rebase from here…",
      disabled: c.id === s().repo?.headOid,
      hint: "edit later commits",
      onSelect: () => s().openDiff({ kind: "rebase", base: c.id }),
    },
    { separator: true, label: "" },
    { label: `Reset ${head ?? "HEAD"} here — soft`, onSelect: () => resetTo(c, "soft") },
    { label: `Reset ${head ?? "HEAD"} here — mixed`, onSelect: () => resetTo(c, "mixed") },
    { label: `Reset ${head ?? "HEAD"} here — hard…`, danger: true, onSelect: () => resetTo(c, "hard") },
    { separator: true, label: "" },
    { label: "Copy commit SHA", onSelect: () => copy(c.id) },
    { label: "Copy commit message", onSelect: () => copy(c.summary) },
  ];
}

// ---------- remotes ----------

export async function addRemote() {
  const res = await s().prompt({
    title: "Add remote",
    label: "Name",
    initial: s().remotes.length ? "" : "origin",
    placeholder: "upstream",
    confirmLabel: "Add remote",
    textarea: { label: "URL", placeholder: "git@github.com:owner/project.git" },
  });
  const name = res?.value.trim();
  const url = res?.text.trim();
  if (!res || !name || !url) return;
  const ok = await s().run(`Adding ${name}`, (r) => api.addRemote(r, name, url), `Added remote ${name}`);
  if (ok) await s().run(`Fetching ${name}`, (r) => api.fetchRemote(r, name));
}

export function remoteMenu(remote: RemoteInfo): MenuItem[] {
  return [
    { label: `Fetch ${remote.name}`, onSelect: () => s().run(`Fetching ${remote.name}`, (r) => api.fetchRemote(r, remote.name), `Fetched ${remote.name}`) },
    { separator: true, label: "" },
    {
      label: "Edit URL…",
      onSelect: async () => {
        const res = await s().prompt({ title: `URL of ${remote.name}`, label: "URL", initial: remote.url ?? "", confirmLabel: "Save" });
        const url = res?.value.trim();
        if (res && url && url !== remote.url) await s().run("Saving URL", (r) => api.setRemoteUrl(r, remote.name, url));
      },
    },
    {
      label: "Rename…",
      onSelect: async () => {
        const res = await s().prompt({ title: `Rename ${remote.name}`, label: "New name", initial: remote.name, confirmLabel: "Rename" });
        const name = res?.value.trim();
        if (res && name && name !== remote.name) await s().run("Renaming remote", (r) => api.renameRemote(r, remote.name, name));
      },
    },
    {
      label: "Remove…",
      danger: true,
      onSelect: async () => {
        const ok = await s().confirm({
          title: "Remove remote",
          message: `Remove ${remote.name} and its remote-tracking branches from this repository? Nothing is deleted on the server.`,
          confirmLabel: "Remove",
          danger: true,
        });
        if (ok) await s().run(`Removing ${remote.name}`, (r) => api.removeRemote(r, remote.name), `Removed ${remote.name}`);
      },
    },
    { separator: true, label: "" },
    { label: "Copy URL", disabled: !remote.url, onSelect: () => remote.url && copy(remote.url) },
  ];
}

async function pushBranchTo(ref: RefInfo, remote: string) {
  await s().run(`Pushing ${ref.name} to ${remote}`, (r) => api.pushBranch(r, remote, ref.name, false), `Pushed ${ref.name} to ${remote}`);
}

async function setUpstream(ref: RefInfo) {
  const remoteBranches = (s().graph?.refs ?? []).filter((r) => r.kind === "remote").map((r) => r.name);
  const guess = remoteBranches.find((n) => remoteOf({ name: n } as RefInfo).branch === ref.name) ?? `origin/${ref.name}`;
  const res = await s().prompt({
    title: `Upstream of ${ref.name}`,
    label: "Remote branch",
    initial: ref.upstream ?? guess,
    placeholder: "origin/main",
    confirmLabel: "Set upstream",
  });
  const up = res?.value.trim();
  if (res && up) await s().run("Setting upstream", (r) => api.setUpstream(r, ref.name, up), `${ref.name} now tracks ${up}`);
}

export function branchRemoteItems(ref: RefInfo): MenuItem[] {
  const remotes = s().remotes;
  return [
    ...remotes.map((rm) => ({ label: `Push to ${rm.name}`, onSelect: () => pushBranchTo(ref, rm.name) })),
    { label: "Set upstream…", disabled: remotes.length === 0, onSelect: () => setUpstream(ref) },
    {
      label: "Unset upstream",
      disabled: !ref.upstream,
      onSelect: () => s().run("Unsetting upstream", (r) => api.setUpstream(r, ref.name, null)),
    },
  ];
}

export function tagRemoteItems(ref: RefInfo): MenuItem[] {
  return s().remotes.flatMap((rm) => [
    { label: `Push tag to ${rm.name}`, onSelect: () => s().run(`Pushing ${ref.name}`, (r) => api.pushTag(r, rm.name, ref.name, false), `Pushed ${ref.name} to ${rm.name}`) },
    {
      label: `Delete tag from ${rm.name}…`,
      danger: true,
      onSelect: async () => {
        const ok = await s().confirm({
          title: "Delete remote tag",
          message: `Delete tag ${ref.name} on ${rm.name}? This affects everyone using that remote.`,
          confirmLabel: "Delete on remote",
          danger: true,
        });
        if (ok) await s().run(`Deleting ${ref.name} on ${rm.name}`, (r) => api.pushTag(r, rm.name, ref.name, true));
      },
    },
  ]);
}

// ---------- files ----------

function absolute(path: string): string | null {
  const root = s().repo?.path;
  return root ? `${root.replace(/\/+$/, "")}/${path}` : null;
}

export function fileItems(path: string, deleted = false): MenuItem[] {
  return [
    {
      label: "Open file",
      disabled: deleted,
      onSelect: () => {
        const p = absolute(path);
        if (p) openPath(p).catch((e) => s().toast("error", String(e)));
      },
    },
    {
      label: "Show in folder",
      disabled: deleted,
      onSelect: () => {
        const p = absolute(path);
        if (p) revealItemInDir(p).catch((e) => s().toast("error", String(e)));
      },
    },
    { label: "Copy path", onSelect: () => copy(path) },
  ];
}

/** Ignore choices for an untracked path: the file, its extension, its folder. */
export function ignoreItems(path: string): MenuItem[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : null;
  const patterns = [`/${path}`, ...(dot > 0 ? [`*${base.slice(dot)}`] : []), ...(dir ? [`/${dir}`] : [])];
  return patterns.map((p) => ({
    label: `Ignore ${p}`,
    onSelect: () => s().run("Updating .gitignore", (r) => api.ignore(r, p), `Added ${p} to .gitignore`, "status"),
  }));
}

export async function discardAll(paths: string[]) {
  const ok = await s().confirm({
    title: "Discard all changes",
    message: `Discard unstaged changes in ${paths.length} file${paths.length === 1 ? "" : "s"}? Untracked files are deleted. Staged changes are kept. This cannot be undone.`,
    confirmLabel: "Discard all",
    danger: true,
  });
  if (ok) await s().run("Discarding", (r) => api.discard(r, paths), undefined, "status");
}

// ---------- drag and drop ----------

/** What dropping branch/tag `source` onto `target` can do. */
export function dropMenu(source: RefInfo, target: RefInfo): MenuItem[] {
  const items: MenuItem[] = [];
  const head = currentBranch();
  const targetIsHead = target.kind === "local" && target.name === head;
  const sourceIsHead = source.kind === "local" && source.name === head;

  if (targetIsHead) {
    items.push(
      { label: `Merge ${source.name} into ${target.name}`, onSelect: () => mergeInto(source.name, source.name) },
      { label: `Rebase ${target.name} onto ${source.name}`, onSelect: () => rebaseOnto(source.name, source.name) },
    );
  } else if (sourceIsHead) {
    items.push(
      { label: `Rebase ${source.name} onto ${target.name}`, onSelect: () => rebaseOnto(target.name, target.name) },
      { label: `Merge ${target.name} into ${source.name}`, onSelect: () => mergeInto(target.name, target.name) },
    );
  }
  if (target.kind === "local" && !targetIsHead) {
    items.push({
      label: `Check out ${target.name} and merge ${source.name} into it`,
      onSelect: async () => {
        await checkoutRef(target);
        if (currentBranch() === target.name) await mergeInto(source.name, source.name);
      },
    });
  }
  if (source.kind === "local" && target.kind === "remote") {
    const { remote } = remoteOf(target);
    items.push({
      label: `Push ${source.name} to ${remote}`,
      onSelect: () => s().run(`Pushing ${source.name}`, (r) => api.pushBranch(r, remote, source.name, false), `Pushed ${source.name} to ${remote}`),
    });
  }
  return items;
}

// ---------- graph filter ----------

export function toggleHidden(ref: RefInfo) {
  const f = s().graphFilter;
  const hidden = f.hidden.includes(ref.fullName) ? f.hidden.filter((h) => h !== ref.fullName) : [...f.hidden, ref.fullName];
  void s().setGraphFilter({ hidden, solo: [] });
}

export function toggleSolo(ref: RefInfo) {
  const f = s().graphFilter;
  const solo = f.solo.includes(ref.fullName) ? f.solo.filter((x) => x !== ref.fullName) : [...f.solo, ref.fullName];
  void s().setGraphFilter({ hidden: [], solo });
}

export function graphItems(ref: RefInfo): MenuItem[] {
  const f = s().graphFilter;
  return [
    { label: f.hidden.includes(ref.fullName) ? "Show in graph" : "Hide in graph", onSelect: () => toggleHidden(ref) },
    { label: f.solo.includes(ref.fullName) ? "Unsolo" : "Solo (show only this)", onSelect: () => toggleSolo(ref) },
  ];
}

// ---------- worktrees ----------

function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/** Suggested location: next to the repository, named after the branch. */
export function worktreePath(repoPath: string, branch: string): string {
  const root = repoPath.replace(/\/+$/, "");
  const parent = root.slice(0, root.lastIndexOf("/"));
  return `${parent}/${baseName(root)}-${branch.replace(/[^\w.-]+/g, "-")}`;
}

export async function addWorktree(branch?: RefInfo) {
  const repo = s().repo;
  if (!repo) return;
  const res = await s().prompt({
    title: branch ? `Open ${branch.name} in a new worktree` : "New worktree",
    label: "Branch",
    initial: branch?.name ?? "",
    placeholder: "feature/x",
    confirmLabel: "Create worktree",
    checkbox: branch ? undefined : { label: "Create this branch from HEAD", initial: true },
    textarea: { label: "Folder (leave empty for the suggested one)", placeholder: worktreePath(repo.path, branch?.name ?? "branch") },
  });
  const name = res?.value.trim();
  if (!res || !name) return;
  const path = res.text.trim() || worktreePath(repo.path, name);
  const isNew = !branch && res.checked;
  const ok = await s().run(`Creating worktree`, (r) => api.addWorktree(r, path, name, isNew, isNew ? "HEAD" : null), `Worktree created at ${path}`);
  if (ok) await s().openRepo(path);
}

export function worktreeMenu(wt: Worktree): MenuItem[] {
  const current = s().repo?.path.replace(/\/+$/, "") === wt.path.replace(/\/+$/, "");
  return [
    { label: "Open", disabled: current || wt.prunable, onSelect: () => void s().openRepo(wt.path) },
    ...fileItemsAbs(wt.path),
    { separator: true, label: "" },
    {
      label: "Remove worktree…",
      danger: true,
      disabled: wt.main || current,
      onSelect: async () => {
        const ok = await s().confirm({
          title: "Remove worktree",
          message: `Remove the worktree at ${wt.path}? Its folder is deleted; the branch${wt.branch ? ` ${wt.branch}` : ""} stays. Uncommitted changes there are lost.`,
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        const done = await s().run("Removing worktree", (r) => api.removeWorktree(r, wt.path, false), "Worktree removed");
        if (done) return;
        const force = await s().confirm({
          title: "Worktree has changes",
          message: "It has modified or untracked files. Remove it anyway?",
          confirmLabel: "Force remove",
          danger: true,
        });
        if (force) await s().run("Removing worktree", (r) => api.removeWorktree(r, wt.path, true), "Worktree removed");
      },
    },
    ...(wt.prunable ? [{ label: "Prune missing worktrees", onSelect: () => s().run("Pruning", (r) => api.pruneWorktrees(r)) }] : []),
  ];
}

function fileItemsAbs(path: string): MenuItem[] {
  return [
    { label: "Show in folder", onSelect: () => revealItemInDir(path).catch((e) => s().toast("error", String(e))) },
    { label: "Copy path", onSelect: () => copy(path) },
  ];
}
