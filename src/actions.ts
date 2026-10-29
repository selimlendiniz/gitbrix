// User-level git actions shared by the toolbar, sidebar, graph and menus.
// Each one asks for input or confirmation where needed, then runs through
// the store so errors become toasts and the view refreshes afterwards.

import { api, CommitRow, PullMode, RefInfo, ResetMode, StashInfo, WIP_ID } from "./api";
import { shortId } from "./format";
import { MenuItem, useStore } from "./store";

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
    await s().run(`Checking out ${ref.name}`, (r) => api.checkoutBranch(r, ref.name), `Switched to ${ref.name}`);
  } else if (ref.kind === "remote") {
    const { branch } = remoteOf(ref);
    await s().run(
      `Checking out ${ref.name}`,
      (r) => api.checkoutRemote(r, ref.name, branch),
      `Switched to ${branch} tracking ${ref.name}`,
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
  await s().run(`Checking out ${label}`, (r) => api.checkoutDetached(r, rev));
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
  await s().run(`Creating ${name}`, (r) => api.createBranch(r, name, start, res.checked), `Created branch ${name}`);
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
  await s().run(`Tagging ${name}`, (r) => api.createTag(r, name, target, res.text || null), `Created tag ${name}`);
}

export async function renameBranch(ref: RefInfo) {
  const res = await s().prompt({ title: `Rename ${ref.name}`, label: "New name", initial: ref.name, confirmLabel: "Rename" });
  const name = res?.value.trim();
  if (!res || !name || name === ref.name) return;
  await s().run(`Renaming ${ref.name}`, (r) => api.renameBranch(r, ref.name, name));
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
  const done = await s().run(`Deleting ${ref.name}`, (r) => api.deleteBranch(r, ref.name, false), `Deleted ${ref.name}`);
  if (done) return;
  // `git branch -d` refuses unmerged branches; offer the forced delete.
  const force = await s().confirm({
    title: "Branch is not fully merged",
    message: `${ref.name} has commits that are not merged anywhere. Delete it anyway? Those commits may be lost.`,
    confirmLabel: "Force delete",
    danger: true,
  });
  if (force) await s().run(`Deleting ${ref.name}`, (r) => api.deleteBranch(r, ref.name, true), `Deleted ${ref.name}`);
}

export async function deleteTag(ref: RefInfo) {
  const ok = await s().confirm({ title: "Delete tag", message: `Delete local tag ${ref.name}?`, confirmLabel: "Delete", danger: true });
  if (ok) await s().run(`Deleting ${ref.name}`, (r) => api.deleteTag(r, ref.name), `Deleted tag ${ref.name}`);
}

export async function mergeInto(rev: string, label: string) {
  const head = currentBranch() ?? "HEAD";
  const ok = await s().confirm({ title: "Merge", message: `Merge ${label} into ${head}?`, confirmLabel: "Merge" });
  if (ok) await s().run(`Merging ${label}`, (r) => api.merge(r, rev), `Merged ${label} into ${head}`);
}

export async function rebaseOnto(rev: string, label: string) {
  const head = currentBranch() ?? "HEAD";
  const ok = await s().confirm({
    title: "Rebase",
    message: `Rebase ${head} onto ${label}? Commits on ${head} will be rewritten.`,
    confirmLabel: "Rebase",
  });
  if (ok) await s().run(`Rebasing onto ${label}`, (r) => api.rebase(r, rev), `Rebased ${head} onto ${label}`);
}

export async function cherryPick(c: CommitRow) {
  await s().run(`Cherry-picking ${shortId(c.id)}`, (r) => api.cherryPick(r, c.id), `Cherry-picked ${shortId(c.id)}`);
}

export async function revertCommit(c: CommitRow) {
  const ok = await s().confirm({
    title: "Revert commit",
    message: `Create a new commit that undoes ${shortId(c.id)} “${c.summary}”?`,
    confirmLabel: "Revert",
  });
  if (ok) await s().run(`Reverting ${shortId(c.id)}`, (r) => api.revert(r, c.id), `Reverted ${shortId(c.id)}`);
}

export async function resetTo(c: CommitRow, mode: ResetMode) {
  const head = currentBranch() ?? "HEAD";
  const what = {
    soft: "keep all changes staged",
    mixed: "keep all changes in the working tree, unstaged",
    hard: "DISCARD all uncommitted changes and commits after it",
  }[mode];
  const ok = await s().confirm({
    title: `Reset ${head} (${mode})`,
    message: `Move ${head} to ${shortId(c.id)} and ${what}.`,
    confirmLabel: `Reset ${mode}`,
    danger: mode === "hard",
  });
  if (ok) await s().run(`Resetting to ${shortId(c.id)}`, (r) => api.reset(r, c.id, mode));
}

export async function fetchAll() {
  await s().run("Fetching", (r) => api.fetch(r), "Fetched all remotes");
}

export async function pull(mode: PullMode) {
  await s().run("Pulling", (r) => api.pull(r, mode), "Pulled");
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
  await s().run("Stashing", (r) => api.stashSave(r, res.value.trim() || null, res.checked), "Changes stashed");
}

export async function stashPop(index = 0) {
  await s().run("Popping stash", (r) => api.stashApply(r, index, true), "Stash applied and dropped");
}

export async function stashApply(index: number) {
  await s().run("Applying stash", (r) => api.stashApply(r, index, false), "Stash applied");
}

export async function stashDrop(st: StashInfo) {
  const ok = await s().confirm({
    title: "Drop stash",
    message: `Delete stash@{${st.index}} “${st.message}”? This cannot be undone.`,
    confirmLabel: "Drop",
    danger: true,
  });
  if (ok) await s().run("Dropping stash", (r) => api.stashDrop(r, st.index), "Stash dropped");
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
