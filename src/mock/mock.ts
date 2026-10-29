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
  }
}

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
  "plugin:dialog|open": () => fixture.info.path,
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
