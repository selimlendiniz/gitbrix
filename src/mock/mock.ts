// Browser-only mode: serve backend calls from a fixture recorded from a
// real repository (scripts/record-fixture.sh). Read calls return recorded
// data; write calls succeed without changing anything and are logged in
// `window.__gitbrixCalls` so UI tests can assert on them.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import fixture from "./fixture.json";

type Args = Record<string, unknown>;

declare global {
  interface Window {
    __gitbrixCalls: { cmd: string; args: Args }[];
    /** What `pull_requests` answers; tests set it. */
    __gitbrixPrs?: unknown;
  }
}

// Accounts added in this page session (the real ones live in the keyring).
let accounts: { id: string }[] = [];

// `?open` in the URL plays the role of a path on the command line.
const READS: Record<string, (a: Args) => unknown> = {
  initial_repo: () => (new URLSearchParams(location.search).has("open") ? fixture.info.path : null),
  open_repo: () => fixture.info,
  repo_info: () => fixture.info,
  get_graph: () => fixture.graph,
  get_status: () => fixture.status,
  get_stashes: () => fixture.stashes,
  head_message: () => fixture.headMessage,
  commit_details: (a) => (fixture.details as Record<string, unknown>)[a.id as string] ?? fail(`No fixture for ${a.id}`),
  commit_file_diff: (a) =>
    (fixture.commitDiffs as Record<string, unknown>)[`${a.id}:${a.path}`] ?? fail(`No fixture diff for ${a.path}`),
  workdir_file_diff: (a) =>
    (fixture.wipDiffs as Record<string, unknown>)[`${a.staged ? "staged" : "unstaged"}:${a.path}`] ??
    fail(`No changes for ${a.path}`),
  file_history: (a) => (fixture.histories as Record<string, unknown>)[a.path as string] ?? [],
  // Blame is recorded for the working tree only; good enough for the UI.
  blame: (a) => (fixture.blames as Record<string, unknown>)[a.path as string] ?? fail(`No blame for ${a.path}`),
  rebase_commits: () => fixture.rebaseCommits,
  get_remotes: () => fixture.remotes,
  get_worktrees: () => fixture.worktrees,
  get_submodules: () => [],
  reflog: () => fixture.reflog,
  // Files mode: commits whose recorded file lists mention the text.
  search_history: (a) =>
    Object.entries(fixture.details as Record<string, { files: { path: string }[] }>)
      .filter(([, d]) => d.files.some((f) => f.path.toLowerCase().includes(String(a.query).toLowerCase())))
      .map(([id]) => id),
  // Not recorded: approximate a comparison by the newer commit's own changes.
  compare_commits: (a) => ((fixture.details as Record<string, { files: unknown[] }>)[a.to as string]?.files ?? []),
  compare_file_diff: (a) =>
    (fixture.commitDiffs as Record<string, unknown>)[`${a.to}:${a.path}`] ?? fail(`No fixture diff for ${a.path}`),
  "plugin:dialog|open": () => fixture.info.path,
  get_accounts: () => accounts,
  add_account: (a) => {
    const account = { id: `${a.provider}|${a.url}|mock-user`, provider: a.provider, url: a.url, username: "mock-user", name: "Mock User" };
    accounts = [...accounts.filter((x) => x.id !== account.id), account];
    return account;
  },
  pull_requests: () => window.__gitbrixPrs ?? { items: [], problems: [], covered: false, projects: [] },
  remove_account: (a) => {
    accounts = accounts.filter((x) => x.id !== a.id);
    return null;
  },
};

function fail(msg: string): never {
  throw msg;
}

export async function installMocks() {
  window.__gitbrixCalls = [];
  mockWindows("main");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Args;
    window.__gitbrixCalls.push({ cmd, args });
    const read = READS[cmd];
    if (read) return read(args);
    // Mutations: pretend they worked.
    return null;
  });
}
