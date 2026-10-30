// User-level git actions shared by the toolbar, sidebar, graph and menus.
// Each one asks for input or confirmation where needed, then runs through
// the store so errors become toasts and the view refreshes afterwards.

import { open as pickFile, save as pickSaveFile } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { api, CommitRow, errorText, PullMode, PullRequest, RebaseStep, RefInfo, RemoteInfo, ResetMode, StashInfo, SubmoduleInfo, WIP_ID, Worktree } from "./api";
import { shortId } from "./format";
import { DragItem, DropAction, DropTarget, setDropResolver } from "./dnd";
import { bisectMenu } from "./bisect";
import { useRelease } from "./components/ReleaseDialog";
import { begin, end } from "./activity";
import { createPullRequest, loadInbox, loadPrs, openPullRequest, prLabel, usePrs } from "./prs";
import { MenuItem, useStore } from "./store";
import { pushUndo, trackHead } from "./undo";

const s = () => useStore.getState();

function copy(text: string, done = "Copied to clipboard") {
  navigator.clipboard?.writeText(text).then(
    () => s().toast("info", done),
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
        // Plain -d: if commits were added to it since (e.g. from a
        // terminal), git refuses instead of losing them.
        await api.deleteBranch(r, name, false);
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

/** Fetch in the background: no success toast, errors stay quiet. Holds
 *  the busy lock like any operation, so a merge or rebase can't start
 *  while git is fetching into the same repository. */
export async function backgroundFetch() {
  const st = s();
  const repo = st.repo;
  if (!repo || st.busy || st.remotes.length === 0) return;
  useStore.setState({ busy: "Auto-fetching", progress: null });
  const task = begin(`Auto-fetching ${repo.name}`);
  try {
    await api.fetch(repo.path);
    end(task);
  } catch (e) {
    // Offline or no credentials: no toast; a manual fetch shows errors,
    // and the title bar keeps this one.
    end(task, errorText(e));
  } finally {
    useStore.setState({ busy: null, progress: null });
  }
  if (s().repo?.path === repo.path) await s().refresh();
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
      { label: "Create pull request…", onSelect: () => createPullRequest(ref.name) },
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
      { label: "Create release…", hint: "GitHub / GitLab", disabled: !s().remotes.length, onSelect: () => useRelease.setState({ tag: ref.name }) },
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
  const isHead = c.id === s().repo?.headOid;
  return [
    ...(isHead ? [{ label: "Edit commit message…", onSelect: () => rewordHead() }, { separator: true, label: "" }] : []),
    { label: "Check out this commit…", onSelect: () => checkoutDetached(c.id) },
    { label: "Browse files at this commit", onSelect: () => void s().openDiff({ kind: "tree", rev: c.id, path: null }) },
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
    ...bisectMenu(c.id),
    { separator: true, label: "" },
    { label: "Save as patch…", onSelect: () => void savePatch([c.id], null, patchFileName(c.summary)) },
    { label: "Copy as patch", onSelect: () => void copyPatch([c.id], null) },
    { separator: true, label: "" },
    { label: "Copy commit SHA", onSelect: () => copy(c.id) },
    { label: "Copy commit message", onSelect: () => copy(c.summary) },
  ];
}

// ---------- several commits ----------

/** The selected commits, oldest first (the graph lists newest first). */
function oldestFirst(ids: string[]): string[] {
  const order = new Map((s().graph?.commits ?? []).map((c, i) => [c.id, i]));
  return [...ids].sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
}

export async function cherryPickMany(ids: string[]) {
  const head = currentBranch() ?? "HEAD";
  const ok = await s().confirm({
    title: "Cherry-pick commits",
    message: `Apply ${ids.length} commits onto ${head}, oldest first? A conflict stops the sequence; resolve it and press Continue.`,
    confirmLabel: `Cherry-pick ${ids.length}`,
  });
  if (!ok) return;
  await trackHead(`cherry-pick ${ids.length} commits`, () =>
    s().run("Cherry-picking", (r) => api.cherryPickMany(r, oldestFirst(ids)), `Cherry-picked ${ids.length} commits onto ${head}`),
  );
}

export async function revertMany(ids: string[]) {
  const ok = await s().confirm({
    title: "Revert commits",
    message: `Make ${ids.length} commits that undo the selected ones, newest first?`,
    confirmLabel: `Revert ${ids.length}`,
  });
  if (!ok) return;
  await trackHead(`revert ${ids.length} commits`, () =>
    s().run("Reverting", (r) => api.revertMany(r, oldestFirst(ids).reverse()), `Reverted ${ids.length} commits`),
  );
}

/** Fold consecutive commits of the current branch into one (an
 *  interactive rebase from the oldest one's parent). */
export async function squashCommits(ids: string[]) {
  const st = s();
  const repo = st.repo;
  if (!repo) return;
  const sorted = oldestFirst(ids);
  const oldest = st.graph?.commits.find((c) => c.id === sorted[0]);
  const base = oldest?.parents[0];
  if (!base) {
    st.toast("error", "The oldest selected commit has no parent to squash onto");
    return;
  }
  let line;
  try {
    line = await api.rebaseCommits(repo.path, base);
  } catch (e) {
    st.toast("error", errorText(e));
    return;
  }
  const at = line.findIndex((c) => c.id === sorted[0]);
  const run = line.slice(at, at + sorted.length).map((c) => c.id);
  if (at < 0 || run.join() !== sorted.join()) {
    st.toast("error", "Squash needs consecutive commits of the checked-out branch");
    return;
  }
  const ok = await st.confirm({
    title: "Squash commits",
    message: `Combine ${ids.length} commits into one, keeping all their messages? Later commits are replayed on top.`,
    confirmLabel: `Squash ${ids.length}`,
  });
  if (!ok) return;
  const steps: RebaseStep[] = line.map((c) => ({
    action: sorted.includes(c.id) && c.id !== sorted[0] ? "squash" : "pick",
    id: c.id,
    message: null,
  }));
  await trackHead(`squash ${ids.length} commits`, () =>
    st.run("Squashing", (r) => api.interactiveRebase(r, base, steps), `Squashed ${ids.length} commits`),
  );
}

export function multiMenu(ids: string[]): MenuItem[] {
  const n = ids.length;
  return [
    { label: `Cherry-pick ${n} commits onto ${currentBranch() ?? "HEAD"}…`, onSelect: () => void cherryPickMany(ids) },
    { label: `Revert ${n} commits…`, onSelect: () => void revertMany(ids) },
    { label: `Squash ${n} commits into one…`, hint: "consecutive", onSelect: () => void squashCommits(ids) },
    { separator: true, label: "" },
    { label: "Save as patch…", onSelect: () => void savePatch(oldestFirst(ids), null, `${n}-commits.patch`) },
    { label: "Copy as patch", onSelect: () => void copyPatch(oldestFirst(ids), null) },
    { label: "Copy commit SHAs", onSelect: () => copy(oldestFirst(ids).join("\n")) },
    { separator: true, label: "" },
    { label: "Clear selection", onSelect: () => s().select(s().selectedId) },
  ];
}

// ---------- patches ----------

/** `Fix the parser` → `0001-Fix-the-parser.patch`, as format-patch names it. */
export function patchFileName(summary: string): string {
  const slug = summary
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 52);
  return `0001-${slug || "patch"}.patch`;
}

/** Commits as patch text: `ids`, or with `from`, those after it up to ids[0]. */
async function patchText(ids: string[], from: string | null): Promise<string | null> {
  const repo = s().repo;
  if (!repo) return null;
  try {
    return await api.formatPatch(repo.path, ids, from);
  } catch (e) {
    s().toast("error", errorText(e));
    return null;
  }
}

export async function savePatch(ids: string[], from: string | null, fileName: string) {
  const text = await patchText(ids, from);
  if (text === null) return;
  try {
    const path = await pickSaveFile({
      title: "Save patch",
      defaultPath: fileName,
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    });
    if (!path) return;
    await api.saveTextFile(path, text);
    s().toast("info", `Saved ${path.split("/").pop()}`);
  } catch (e) {
    s().toast("error", errorText(e));
  }
}

export async function copyPatch(ids: string[], from: string | null) {
  const text = await patchText(ids, from);
  if (text !== null) copy(text, "Patch copied");
}

/** Apply a patch file: as commits with their authors (`git am`), or to
 *  the work tree only (`git apply`). */
export async function applyPatchFile(asCommits: boolean) {
  const repo = s().repo;
  if (!repo) return;
  let path: string | null;
  try {
    const picked = await pickFile({
      title: asCommits ? "Apply patches as commits" : "Apply a patch to the working tree",
      multiple: false,
      filters: [{ name: "Patch", extensions: ["patch", "diff", "mbox", "eml"] }, { name: "All files", extensions: ["*"] }],
    });
    path = typeof picked === "string" ? picked : null;
  } catch (e) {
    s().toast("error", errorText(e));
    return;
  }
  if (!path) return;
  const name = path.split("/").pop();
  if (asCommits) {
    let subjects: string[] = [];
    try {
      subjects = await api.readPatchFile(path);
    } catch (e) {
      s().toast("error", errorText(e));
      return;
    }
    const n = subjects.length;
    const ok = await s().confirm({
      title: "Apply patches as commits",
      message: `Commit ${n} patch${n === 1 ? "" : "es"} from ${name} on ${repo.headBranch ?? "HEAD"}, keeping their authors and messages?\n\n${subjects
        .slice(0, 8)
        .map((x) => `• ${x || "(no message)"}`)
        .join("\n")}${n > 8 ? `\n• … ${n - 8} more` : ""}`,
      confirmLabel: n === 1 ? "Commit it" : `Commit ${n}`,
    });
    if (!ok) return;
    await trackHead(`apply ${name}`, () =>
      s().run("Applying patches", (r) => api.applyPatchFile(r, path!, true), `Committed ${n} patch${n === 1 ? "" : "es"}`),
    );
  } else {
    await s().run("Applying patch", (r) => api.applyPatchFile(r, path!, false), `Applied ${name} to the working tree`, "status");
  }
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

/** Track an untracked file's extension (or the file) with Git LFS. */
export function lfsItems(path: string): MenuItem[] {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const pattern = dot > 0 ? `*${base.slice(dot)}` : path;
  return [
    {
      label: `Track ${pattern} with Git LFS`,
      hint: "large files",
      onSelect: () =>
        s().run("Updating .gitattributes", (r) => api.lfsTrack(r, pattern), `${pattern} is stored with Git LFS from now on`, "status"),
    },
  ];
}

/** Fill in LFS files that are still pointers (after a checkout, pull or
 *  clone). Tried once per repository state, so a failing server doesn't
 *  retry on every refresh. */
let lfsTried = "";
export async function lfsPullIfNeeded() {
  const st = s();
  const repo = st.repo;
  if (!repo || st.busy) return;
  const key = `${repo.path}@${repo.headOid}`;
  if (key === lfsTried) return;
  let pending = 0;
  try {
    pending = await api.lfsPending(repo.path);
  } catch {
    return;
  }
  if (!pending || s().repo?.path !== repo.path || s().busy) return;
  lfsTried = key;
  await st.run(
    "Downloading LFS files",
    (r) => api.lfsPull(r),
    `Downloaded ${pending} LFS file${pending === 1 ? "" : "s"}`,
    "status",
  );
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

/** Point a branch that isn't checked out at another commit (undoable). */
export async function moveBranch(ref: RefInfo, target: string, label = shortId(target)) {
  const repo = s().repo?.path;
  const from = ref.target;
  const ok = await s().run(`Moving ${ref.name}`, (r) => api.moveBranch(r, ref.name, target), `Moved ${ref.name} to ${label}`);
  if (ok && repo) pushUndo({ label: `move ${ref.name}`, repo, run: (r) => api.moveBranch(r, ref.name, from) });
}

function stashActions(st: StashInfo): DropAction[] {
  return [
    { label: `Apply stash “${st.message}”`, onSelect: () => stashApply(st.index) },
    { label: `Pop stash “${st.message}”`, onSelect: () => stashPop(st.index) },
  ];
}

/** What dropping `item` on `target` can do (see dnd.ts). */
export function dropActions(item: DragItem, target: DropTarget): DropAction[] {
  const head = currentBranch();
  const isHeadRef = (r: RefInfo) => r.kind === "local" && r.name === head;

  if (item.kind === "files") {
    if (target.kind !== "files" || target.staged === item.staged) return [];
    const what = item.paths.length === 1 ? item.paths[0] : `${item.paths.length} files`;
    return target.staged
      ? [{ label: `Stage ${what}`, direct: true, onSelect: () => void s().run("Staging", (r) => api.stage(r, item.paths), undefined, "status") }]
      : [{ label: `Unstage ${what}`, direct: true, onSelect: () => void s().run("Unstaging", (r) => api.unstage(r, item.paths), undefined, "status") }];
  }

  if (item.kind === "stash") {
    const onWip = (target.kind === "commit" && target.commit.id === WIP_ID) || (target.kind === "files" && !target.staged);
    return onWip ? stashActions(item.stash) : [];
  }

  if (item.kind === "ref") {
    const src = item.ref;
    if (target.kind === "ref") return target.ref.fullName === src.fullName ? [] : dropMenu(src, target.ref);
    if (target.kind === "remote") {
      if (src.kind === "local") return [{ label: `Push ${src.name} to ${target.remote}`, onSelect: () => pushBranchTo(src, target.remote) }];
      if (src.kind === "tag")
        return [
          {
            label: `Push tag ${src.name} to ${target.remote}`,
            onSelect: () => s().run(`Pushing ${src.name}`, (r) => api.pushTag(r, target.remote, src.name, false), `Pushed ${src.name} to ${target.remote}`),
          },
        ];
      return [];
    }
    if (target.kind === "commit" && target.commit.id !== WIP_ID && target.commit.kind === "commit" && src.kind === "local") {
      const c = target.commit;
      const sid = shortId(c.id);
      if (c.id === src.target) return [];
      if (isHeadRef(src)) {
        return [
          { label: `Rebase ${src.name} onto ${sid}`, onSelect: () => rebaseOnto(c.id, sid) },
          { label: `Merge ${sid} into ${src.name}`, onSelect: () => mergeInto(c.id, sid) },
          { separator: true, label: "" },
          { label: `Reset ${src.name} to ${sid} — soft`, onSelect: () => resetTo(c, "soft") },
          { label: `Reset ${src.name} to ${sid} — mixed`, onSelect: () => resetTo(c, "mixed") },
          { label: `Reset ${src.name} to ${sid} — hard…`, danger: true, onSelect: () => resetTo(c, "hard") },
        ];
      }
      return [{ label: `Move ${src.name} to ${sid}`, onSelect: () => moveBranch(src, c.id, sid) }];
    }
    return [];
  }

  // A commit.
  const c = item.commit;
  const sid = shortId(c.id);
  if (c.id === WIP_ID || c.kind !== "commit") return [];
  if (target.kind === "commit") {
    const t = target.commit;
    if (t.id === c.id || t.id === WIP_ID || t.kind !== "commit") return [];
    return [
      {
        label: `Compare ${sid} with ${shortId(t.id)}`,
        direct: true,
        onSelect: () => {
          s().select(c.id);
          s().setCompare(t.id);
        },
      },
    ];
  }
  if (target.kind !== "ref" || target.ref.kind !== "local") return [];
  const b = target.ref;
  if (isHeadRef(b)) {
    return [
      { label: `Cherry-pick ${sid} onto ${b.name}`, onSelect: () => cherryPick(c) },
      { label: `Merge ${sid} into ${b.name}`, onSelect: () => mergeInto(c.id, sid) },
      { label: `Rebase ${b.name} onto ${sid}`, onSelect: () => rebaseOnto(c.id, sid) },
    ];
  }
  return [
    { label: `Move ${b.name} to ${sid}`, disabled: b.target === c.id, onSelect: () => moveBranch(b, c.id, sid) },
    {
      label: `Check out ${b.name} and cherry-pick ${sid}`,
      onSelect: async () => {
        await checkoutRef(b);
        if (currentBranch() === b.name) await cherryPick(c);
      },
    },
  ];
}

setDropResolver(dropActions);

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
        // Ignored files (.env, build output) are deleted too, and git does
        // not count them as changes: name them.
        const ignored = await api.worktreeIgnored(wt.path).catch(() => [] as string[]);
        const extra = ignored.length
          ? ` It also deletes ${ignored.length} ignored item${ignored.length === 1 ? "" : "s"}: ${ignored.slice(0, 5).join(", ")}${ignored.length > 5 ? ", …" : ""}.`
          : "";
        const ok = await s().confirm({
          title: "Remove worktree",
          message: `Remove the worktree at ${wt.path}? Its folder is deleted; the branch${wt.branch ? ` ${wt.branch}` : ""} stays. Uncommitted changes there are lost.${extra}`,
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

// ---------- submodules ----------

export function submoduleMenu(sm: SubmoduleInfo): MenuItem[] {
  const repo = s().repo;
  const abs = repo ? `${repo.path.replace(/\/+$/, "")}/${sm.path}` : sm.path;
  return [
    { label: "Open in a tab", disabled: !sm.initialized, onSelect: () => void s().openRepo(abs) },
    { label: "Update all submodules", onSelect: () => updateSubmodules() },
    { separator: true, label: "" },
    ...fileItemsAbs(abs),
    { label: "Copy URL", disabled: !sm.url, onSelect: () => sm.url && copy(sm.url) },
  ];
}

export async function updateSubmodules() {
  await s().run("Updating submodules", (r) => api.submoduleUpdate(r), "Submodules updated");
}

/** Change the message of the commit HEAD points at (staged changes stay out). */
export async function rewordHead() {
  const repo = s().repo;
  if (!repo) return;
  const msg = await api.headMessage(repo.path).catch(() => "");
  const [summary, ...rest] = msg.split("\n");
  const res = await s().prompt({
    title: "Edit commit message",
    label: "Summary",
    initial: summary,
    confirmLabel: "Save message",
    textarea: { label: "Description", initial: rest.join("\n").trim() },
  });
  const sum = res?.value.trim();
  if (!res || !sum) return;
  const message = res.text.trim() ? `${sum}\n\n${res.text.trim()}\n` : `${sum}\n`;
  await trackHead("edit message", () => s().run("Saving message", (r) => api.rewordHead(r, message), "Message updated"));
}

// ---------------------------------------------------------------------------
// Pull / merge requests

/** The request's branch: a same-repository one tracks its remote branch, a fork's goes on pr/N or mr/N. */
export async function checkoutPullRequest(pr: PullRequest) {
  const label = prLabel(pr);
  if (pr.sameRepo) {
    const remoteRef = `${pr.remote}/${pr.sourceBranch}`;
    if (s().repo?.headBranch === pr.sourceBranch) return;
    await trackHead(`checkout ${pr.sourceBranch}`, () =>
      s().run(
        `Checking out ${label}`,
        async (r) => {
          await api.fetchRemote(r, pr.remote);
          await api.checkoutRemote(r, remoteRef, pr.sourceBranch);
        },
        `Switched to ${pr.sourceBranch}`,
      ),
    );
  } else {
    await trackHead(`checkout ${label}`, () =>
      s().run(`Checking out ${label}`, (r) => api.checkoutPullRequest(r, pr.remote, pr.number), `Checked out ${label} from its fork`),
    );
  }
}

export async function approvePullRequest(pr: PullRequest) {
  const ok = await s().confirm({
    title: `Approve ${prLabel(pr)}`,
    message: `Approve "${pr.title}" by ${pr.author} on ${pr.project.split("/")[0]}? The approval is posted under your account.`,
    confirmLabel: "Approve",
  });
  if (!ok) return;
  try {
    await api.approvePullRequest(pr.account, pr.project, pr.number);
    s().toast("info", `Approved ${prLabel(pr)}`);
  } catch (e) {
    s().toast("error", errorText(e));
  }
  const repo = s().repo?.path;
  await Promise.all([repo ? loadPrs(repo) : null, usePrs.getState().inbox ? loadInbox() : null]);
}

export function prMenu(pr: PullRequest): MenuItem[] {
  return [
    ...(pr.remote ? [{ label: "Review in gitbrix", onSelect: () => openPullRequest(pr) }] : []),
    { label: "Open in browser", onSelect: () => void openUrl(pr.url) },
    { label: `Check out ${pr.sameRepo ? pr.sourceBranch : prLabel(pr)}`, onSelect: () => checkoutPullRequest(pr) },
    {
      label: pr.approvedByMe ? "Approved by you" : "Approve…",
      disabled: !pr.canApprove || pr.approvedByMe,
      onSelect: () => approvePullRequest(pr),
    },
    { separator: true, label: "" },
    { label: "Copy link", onSelect: () => copy(pr.url) },
    { label: "Copy branch name", onSelect: () => copy(pr.sourceBranch) },
  ];
}
