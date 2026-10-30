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
    /** `pull_requests` answers per repository path; wins over __gitbrixPrs. */
    __gitbrixPrsByRepo?: Record<string, unknown>;
    /** What `pull_request_inbox` answers; tests set it. */
    __gitbrixInbox?: unknown;
    /** What `ci_statuses` answers; tests set it. */
    __gitbrixCi?: Record<string, unknown>;
    /** Repositories `find_repos` finds; tests set it. */
    __gitbrixFound?: string[];
  }
}

// Profiles saved in this page session.
let profiles: { active: string | null; list: { id: string; name: string; userName: string; userEmail: string }[] } = {
  active: null,
  list: [],
};

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
  pull_requests: (a) =>
    window.__gitbrixPrsByRepo?.[a.repo as string] ?? window.__gitbrixPrs ?? { items: [], problems: [], covered: false, projects: [] },
  pull_request_inbox: () => window.__gitbrixInbox ?? { items: [], problems: [], accounts: [] },
  // The fixture repository is summed up from its recording; any other path
  // looks like a clean repository named after its folder.
  repo_summaries: (a) =>
    (a.paths as string[]).map((path) =>
      path === fixture.info.path
        ? { path, info: fixture.info, changes: fixture.status.unstaged.length + fixture.status.staged.length, conflicts: 0, fetched: null, error: null }
        : path.includes("missing")
          ? { path, info: null, changes: 0, conflicts: 0, fetched: null, error: "could not find repository" }
          : {
              path,
              info: { ...fixture.info, path, name: path.split("/").pop(), headBranch: "main", ahead: 0, behind: 2, state: "clean" },
              changes: 0,
              conflicts: 0,
              fetched: Math.floor(Date.now() / 1000) - 3600,
              error: null,
            },
    ),
  find_repos: () => window.__gitbrixFound ?? [],
  get_profiles: () => profiles,
  terminal_open: () => 7,
  format_patch: (a) => `From ${(a.ids as string[])[0]} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] mock\n\n---\n`,
  read_patch_file: () => ["Add two", "Add b"],
  "plugin:dialog|save": () => "/home/demo/0001-Tidy-up-main.patch",
  lfs_pending: () => (window as { __gitbrixLfsPending?: number }).__gitbrixLfsPending ?? 0,
  ci_statuses: (a) => Object.fromEntries(Object.entries(window.__gitbrixCi ?? {}).filter(([sha]) => (a.shas as string[]).includes(sha))),
  pull_request_form: () => ({
    provider: "gitlab",
    project: "gitlab.com/team/demo-app",
    defaultBranch: "main",
    people: [
      { id: 7, username: "ada", name: "Ada Lovelace" },
      { id: 8, username: "grace", name: "Grace Hopper" },
    ],
  }),
  // A request's range: the fixture's last two commits, so the compare mock has files.
  pull_request_range: () => ({ base: fixture.graph.commits[fixture.graph.commits.length - 2].id, head: fixture.graph.commits.find((c) => c.summary === "UI: dark theme")?.id }),
  pull_request_conversation: () => ({
    description: "Makes the UI darker.",
    comments: [
      { author: "bot", body: "added 1 commit", created: "2026-10-01T00:00:00Z", path: null, line: null, verdict: null, system: true },
      { author: "ada", body: "Too dark?", created: "2026-10-02T00:00:00Z", path: "src/ui.rs", line: 3, verdict: null, system: false },
    ],
    open: true,
    mergeable: true,
    mergeStatus: "mergeable",
  }),
  create_pull_request: () => ({ number: 14, url: "https://gitlab.com/team/demo-app/-/merge_requests/14", warning: null }),
  save_profiles: (a) => {
    const next = a.profiles as typeof profiles;
    if (next.list.some((p) => !p.userName || !p.userEmail)) throw "Profile needs a name and an email for commits";
    profiles = next;
    return profiles;
  },
  identity: () => {
    const p = profiles.list.find((x) => x.id === profiles.active);
    return p
      ? { name: p.userName, email: p.userEmail, source: "profile", profile: p.name }
      : { name: "Demo User", email: "demo@example.com", source: "git config", profile: null };
  },
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
