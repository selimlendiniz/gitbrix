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

export interface Seg {
  from: number;
  to: number;
  color: number;
}

export interface CommitRow {
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
}

export interface Graph {
  commits: CommitRow[];
  refs: RefInfo[];
  maxLanes: number;
  truncated: boolean;
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
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldNo: number | null;
  newNo: number | null;
  text: string;
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
  hunks: Hunk[];
}

export type PullMode = "ff-only" | "merge" | "rebase";
export type ResetMode = "soft" | "mixed" | "hard";
export type SequencerOp = "merge" | "rebase" | "cherry-pick" | "revert";

export const api = {
  initialRepo: () => invoke<string | null>("initial_repo"),
  openRepo: (path: string) => invoke<RepoInfo>("open_repo", { path }),
  watchRepo: (repo: string) => invoke<void>("watch_repo", { repo }),
  unwatchRepo: () => invoke<void>("unwatch_repo"),
  repoInfo: (repo: string) => invoke<RepoInfo>("repo_info", { repo }),
  graph: (repo: string, limit: number) => invoke<Graph>("get_graph", { repo, limit }),
  status: (repo: string) => invoke<WorkingStatus>("get_status", { repo }),
  stashes: (repo: string) => invoke<StashInfo[]>("get_stashes", { repo }),
  commitDetails: (repo: string, id: string) => invoke<CommitDetails>("commit_details", { repo, id }),
  commitFileDiff: (repo: string, id: string, path: string, oldPath: string | null) =>
    invoke<FileDiff>("commit_file_diff", { repo, id, path, oldPath }),
  workdirFileDiff: (repo: string, path: string, staged: boolean) =>
    invoke<FileDiff>("workdir_file_diff", { repo, path, staged }),
  headMessage: (repo: string) => invoke<string>("head_message", { repo }),

  stage: (repo: string, paths: string[]) => invoke<void>("stage", { repo, paths }),
  stageAll: (repo: string) => invoke<void>("stage_all", { repo }),
  unstage: (repo: string, paths: string[]) => invoke<void>("unstage", { repo, paths }),
  unstageAll: (repo: string) => invoke<void>("unstage_all", { repo }),
  discard: (repo: string, paths: string[]) => invoke<void>("discard", { repo, paths }),
  commit: (repo: string, message: string, amend: boolean) => invoke<void>("commit", { repo, message, amend }),

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

  stashSave: (repo: string, message: string | null, includeUntracked: boolean) =>
    invoke<void>("stash_save", { repo, message, includeUntracked }),
  stashApply: (repo: string, index: number, pop: boolean) => invoke<void>("stash_apply", { repo, index, pop }),
  stashDrop: (repo: string, index: number) => invoke<void>("stash_drop", { repo, index }),

  cherryPick: (repo: string, id: string) => invoke<void>("cherry_pick", { repo, id }),
  revert: (repo: string, id: string) => invoke<void>("revert", { repo, id }),
  reset: (repo: string, id: string, mode: ResetMode) => invoke<void>("reset", { repo, id, mode }),
  merge: (repo: string, rev: string) => invoke<void>("merge", { repo, rev }),
  rebase: (repo: string, onto: string) => invoke<void>("rebase", { repo, onto }),
  sequencer: (repo: string, op: SequencerOp, action: "continue" | "abort" | "skip") =>
    invoke<void>("sequencer", { repo, op, action }),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
