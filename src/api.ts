// Typed wrappers around the Rust commands in src-tauri/src/commands.rs.
// Field names mirror the serde `camelCase` output of the Rust structs.

import { invoke } from "@tauri-apps/api/core";

export const WIP_ID = "WIP";

export interface RepoInfo {
  path: string;
  name: string;
  headBranch: string | null;
  headOid: string | null;
  detached: boolean;
  unborn: boolean;
  state: "clean" | "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | "am";
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Graph line segment: [from lane, to lane, colour index]. */
export type Seg = [from: number, to: number, color: number];

export interface CommitRow {
  kind: "commit" | "stash" | "wip";
  id: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  time: number;
  parents: string[];
  lane: number;
  color: number;
  up: Seg[];
  down: Seg[];
}

export type RefKind = "local" | "remote" | "tag";

export interface RefInfo {
  fullName: string;
  name: string;
  kind: RefKind;
  target: string;
  isHead: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Annotated tags only. */
  message?: string;
}

export interface Graph {
  commits: CommitRow[];
  refs: RefInfo[];
  maxLanes: number;
  truncated: boolean;
}

/** Refs (full names) the graph leaves out, or the only ones it walks. */
export interface GraphFilter {
  hidden: string[];
  solo: string[];
}

export interface StashInfo {
  index: number;
  message: string;
  id: string;
  base: string | null;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

export interface StatusEntry {
  path: string;
  oldPath: string | null;
  status: FileStatus;
}

export interface WorkingStatus {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  conflicted: StatusEntry[];
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Signature {
  name: string;
  email: string;
  time: number;
}

export interface CommitDetails {
  id: string;
  message: string;
  author: Signature;
  committer: Signature;
  parents: string[];
  files: FileChange[];
  signed: boolean;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
  noEol?: boolean;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  truncated: boolean;
  /** Not valid UTF-8: line text is approximate, no partial staging. */
  lossy?: boolean;
  hunks: Hunk[];
}

export interface ConflictFile {
  path: string;
  ours: string | null;
  theirs: string | null;
  base: string | null;
  working: string | null;
  binary: boolean;
}

export interface HistoryEntry {
  id: string;
  authorName: string;
  time: number;
  summary: string;
  path: string;
}

export interface BlameCommit {
  id: string;
  authorName: string;
  authorEmail: string;
  time: number;
  summary: string;
}

export interface Blame {
  path: string;
  lines: { id: string; line: number; text: string }[];
  commits: Record<string, BlameCommit>;
}

export interface RebaseCommit {
  id: string;
  summary: string;
  message: string;
  authorName: string;
  time: number;
}

export interface RebaseStep {
  action: "pick" | "reword" | "squash" | "fixup" | "drop";
  id: string;
  message: string | null;
}

export interface RemoteInfo {
  name: string;
  url: string | null;
  pushUrl: string | null;
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  main: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string | null;
  initialized: boolean;
  modified: boolean;
}

export interface ReflogEntry {
  index: number;
  id: string;
  oldId: string;
  message: string;
  time: number;
  summary: string | null;
}

export type PullMode = "ff-only" | "merge" | "rebase";
export type ResetMode = "soft" | "mixed" | "hard" | "keep";
export type SequencerOp = "merge" | "rebase" | "cherry-pick" | "revert";

export type Provider = "github" | "gitlab";

export interface Account {
  id: string;
  provider: Provider;
  /** e.g. https://github.com or a self-hosted https://gitlab.example.com */
  url: string;
  username: string;
  name: string | null;
}

export const api = {
  initialRepo: () => invoke<string | null>("initial_repo"),
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  watchRepo: (repo: string) => invoke<void>("watch_repo", { repo }),
  unwatchRepo: () => invoke<void>("unwatch_repo"),
  repoInfo: (repo: string) => invoke<RepoInfo>("repo_info", { repo }),
  graph: (repo: string, limit: number, filter: GraphFilter) => invoke<Graph>("get_graph", { repo, limit, filter }),
  status: (repo: string) => invoke<WorkingStatus>("get_status", { repo }),
  stashes: (repo: string) => invoke<StashInfo[]>("get_stashes", { repo }),
  commitDetails: (repo: string, id: string) => invoke<CommitDetails>("commit_details", { repo, id }),
  commitFileDiff: (repo: string, id: string, path: string, oldPath: string | null, ignoreWs = false) =>
    invoke<FileDiff>("commit_file_diff", { repo, id, path, oldPath, ignoreWs }),
  compareCommits: (repo: string, from: string, to: string) => invoke<FileChange[]>("compare_commits", { repo, from, to }),
  compareFileDiff: (repo: string, from: string, to: string, path: string, oldPath: string | null, ignoreWs = false) =>
    invoke<FileDiff>("compare_file_diff", { repo, from, to, path, oldPath, ignoreWs }),
  fileBase64: (repo: string, rev: string | null, path: string) => invoke<string | null>("file_base64", { repo, rev, path }),
  workdirFileDiff: (repo: string, path: string, staged: boolean) =>
    invoke<FileDiff>("workdir_file_diff", { repo, path, staged }),
  fileHistory: (repo: string, path: string, limit: number) => invoke<HistoryEntry[]>("file_history", { repo, path, limit }),
  searchHistory: (repo: string, mode: "files" | "code", query: string, limit: number) =>
    invoke<string[]>("search_history", { repo, mode, query, limit }),
  reflog: (repo: string, limit: number) => invoke<ReflogEntry[]>("reflog", { repo, limit }),
  blame: (repo: string, path: string, rev: string | null) => invoke<Blame>("blame", { repo, path, rev }),
  headMessage: (repo: string) => invoke<string>("head_message", { repo }),

  stage: (repo: string, paths: string[]) => invoke<void>("stage", { repo, paths }),
  stageAll: (repo: string) => invoke<void>("stage_all", { repo }),
  unstage: (repo: string, paths: string[]) => invoke<void>("unstage", { repo, paths }),
  unstageAll: (repo: string) => invoke<void>("unstage_all", { repo }),
  applyPatch: (repo: string, patch: string, target: "index" | "worktree", reverse: boolean, intentToAdd: string | null) =>
    invoke<void>("apply_patch", { repo, patch, target, reverse, intentToAdd }),
  conflictFile: (repo: string, path: string) => invoke<ConflictFile>("conflict_file", { repo, path }),
  resolveConflict: (repo: string, path: string, content: string | null, side: "ours" | "theirs" | null) =>
    invoke<void>("resolve_conflict", { repo, path, content, side }),
  ignore: (repo: string, pattern: string) => invoke<void>("ignore", { repo, pattern }),
  discard: (repo: string, paths: string[]) => invoke<void>("discard", { repo, paths }),
  commit: (repo: string, message: string, amend: boolean) => invoke<void>("commit", { repo, message, amend }),
  rewordHead: (repo: string, message: string) => invoke<void>("reword_head", { repo, message }),

  checkoutBranch: (repo: string, name: string) => invoke<void>("checkout_branch", { repo, name }),
  checkoutRemote: (repo: string, remoteBranch: string, local: string) =>
    invoke<void>("checkout_remote", { repo, remoteBranch, local }),
  checkoutDetached: (repo: string, rev: string) => invoke<void>("checkout_detached", { repo, rev }),
  createBranch: (repo: string, name: string, start: string | null, checkout: boolean) =>
    invoke<void>("create_branch", { repo, name, start, checkout }),
  deleteBranch: (repo: string, name: string, force: boolean) => invoke<void>("delete_branch", { repo, name, force }),
  renameBranch: (repo: string, old: string, newName: string) =>
    invoke<void>("rename_branch", { repo, old, new: newName }),
  deleteRemoteBranch: (repo: string, remote: string, branch: string) =>
    invoke<void>("delete_remote_branch", { repo, remote, branch }),
  createTag: (repo: string, name: string, target: string, message: string | null) =>
    invoke<void>("create_tag", { repo, name, target, message }),
  deleteTag: (repo: string, name: string) => invoke<void>("delete_tag", { repo, name }),

  fetch: (repo: string) => invoke<void>("fetch", { repo }),
  pull: (repo: string, mode: PullMode) => invoke<void>("pull", { repo, mode }),
  push: (repo: string, force: boolean) => invoke<void>("push", { repo, force }),

  remotes: (repo: string) => invoke<RemoteInfo[]>("get_remotes", { repo }),
  addRemote: (repo: string, name: string, url: string) => invoke<void>("add_remote", { repo, name, url }),
  removeRemote: (repo: string, name: string) => invoke<void>("remove_remote", { repo, name }),
  renameRemote: (repo: string, old: string, newName: string) => invoke<void>("rename_remote", { repo, old, new: newName }),
  setRemoteUrl: (repo: string, name: string, url: string) => invoke<void>("set_remote_url", { repo, name, url }),
  fetchRemote: (repo: string, remote: string) => invoke<void>("fetch_remote", { repo, remote }),
  pushBranch: (repo: string, remote: string, branch: string, force: boolean) =>
    invoke<void>("push_branch", { repo, remote, branch, force }),
  setUpstream: (repo: string, branch: string, upstream: string | null) => invoke<void>("set_upstream", { repo, branch, upstream }),
  pushTag: (repo: string, remote: string, tag: string, del: boolean) => invoke<void>("push_tag", { repo, remote, tag, delete: del }),
  submodules: (repo: string) => invoke<SubmoduleInfo[]>("get_submodules", { repo }),
  submoduleUpdate: (repo: string) => invoke<void>("submodule_update", { repo }),
  worktrees: (repo: string) => invoke<Worktree[]>("get_worktrees", { repo }),
  addWorktree: (repo: string, path: string, branch: string, newBranch: boolean, start: string | null) =>
    invoke<void>("add_worktree", { repo, path, branch, newBranch, start }),
  removeWorktree: (repo: string, path: string, force: boolean) => invoke<void>("remove_worktree", { repo, path, force }),
  worktreeIgnored: (path: string) => invoke<string[]>("worktree_ignored", { path }),
  pruneWorktrees: (repo: string) => invoke<void>("prune_worktrees", { repo }),
  cloneRepo: (url: string, parent: string, name: string) => invoke<string>("clone_repo", { url, parent, name }),
  initRepo: (path: string) => invoke<string>("init_repo", { path }),

  stashSave: (repo: string, message: string | null, includeUntracked: boolean) =>
    invoke<void>("stash_save", { repo, message, includeUntracked }),
  /** With `id`, the stash is found by id (the index may be stale). */
  stashApply: (repo: string, index: number, pop: boolean, id: string | null = null) =>
    invoke<void>("stash_apply", { repo, index, pop, id }),
  stashDrop: (repo: string, index: number, id: string | null = null) => invoke<void>("stash_drop", { repo, index, id }),
  stashStore: (repo: string, id: string, message: string) => invoke<void>("stash_store", { repo, id, message }),

  cherryPick: (repo: string, id: string) => invoke<void>("cherry_pick", { repo, id }),
  revert: (repo: string, id: string) => invoke<void>("revert", { repo, id }),
  reset: (repo: string, id: string, mode: ResetMode) => invoke<void>("reset", { repo, id, mode }),
  merge: (repo: string, rev: string) => invoke<void>("merge", { repo, rev }),
  rebase: (repo: string, onto: string) => invoke<void>("rebase", { repo, onto }),
  rebaseCommits: (repo: string, base: string) => invoke<RebaseCommit[]>("rebase_commits", { repo, base }),
  interactiveRebase: (repo: string, base: string, steps: RebaseStep[]) =>
    invoke<void>("interactive_rebase", { repo, base, steps }),
  sequencer: (repo: string, op: SequencerOp, action: "continue" | "abort" | "skip") =>
    invoke<void>("sequencer", { repo, op, action }),

  accounts: () => invoke<Account[]>("get_accounts"),
  /** Checks the token with the service, then keeps it in the system keyring. */
  addAccount: (provider: Provider, url: string, token: string) => invoke<Account>("add_account", { provider, url, token }),
  removeAccount: (id: string) => invoke<void>("remove_account", { id }),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
