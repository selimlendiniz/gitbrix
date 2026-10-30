// Workspaces: named lists of repositories watched together (changes,
// ahead/behind, fetch all). The lists live in localStorage, per machine.

import { create } from "zustand";

import { api, errorText, RepoSummary } from "./api";
import { useStore } from "./store";

const KEY = "gitbrix.workspaces";

export interface Workspace {
  id: string;
  name: string;
  repos: string[];
}

interface Saved {
  list: Workspace[];
  active: string | null;
}

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && Array.isArray(raw.list)) return { list: raw.list, active: raw.active ?? null };
  } catch {
    // fall through
  }
  return { list: [], active: null };
}

interface State extends Saved {
  /** The pinned Workspaces tab is the one shown. */
  open: boolean;
  /** Latest summary per repository path. */
  summaries: Record<string, RepoSummary>;
  loading: boolean;
  /** Paths being fetched right now. */
  fetching: string[];
  /** Fetch errors from the last "fetch all", per path. */
  fetchErrors: Record<string, string>;
}

export const useWorkspaces = create<State>(() => ({
  ...load(),
  open: false,
  summaries: {},
  loading: false,
  fetching: [],
  fetchErrors: {},
}));

export function showWorkspaces() {
  useWorkspaces.setState({ open: true });
  void loadSummaries();
}

export function hideWorkspaces() {
  useWorkspaces.setState({ open: false });
}

// Opening a repository (palette, recent list, drop) shows its tab.
useStore.subscribe((st, prev) => {
  if (st.repo?.path !== prev.repo?.path && st.repo && useWorkspaces.getState().open) hideWorkspaces();
});

function save() {
  const { list, active } = useWorkspaces.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ list, active }));
  } catch {
    // ignore
  }
}

export function activeWorkspace(): Workspace | null {
  const { list, active } = useWorkspaces.getState();
  return list.find((w) => w.id === active) ?? list[0] ?? null;
}

export function createWorkspace(name: string, repos: string[] = []): Workspace {
  const ws = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, repos: unique(repos) };
  useWorkspaces.setState((s) => ({ list: [...s.list, ws], active: ws.id }));
  save();
  return ws;
}

export function selectWorkspace(id: string) {
  useWorkspaces.setState({ active: id, fetchErrors: {} });
  save();
  void loadSummaries();
}

export function renameWorkspace(id: string, name: string) {
  useWorkspaces.setState((s) => ({ list: s.list.map((w) => (w.id === id ? { ...w, name } : w)) }));
  save();
}

export function deleteWorkspace(id: string) {
  useWorkspaces.setState((s) => {
    const list = s.list.filter((w) => w.id !== id);
    return { list, active: s.active === id ? list[0]?.id ?? null : s.active };
  });
  save();
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

/** Add repositories to the active workspace (made if there is none). */
export function addRepos(paths: string[]) {
  const ws = activeWorkspace() ?? createWorkspace("Workspace");
  const repos = unique([...ws.repos, ...paths]);
  useWorkspaces.setState((s) => ({ list: s.list.map((w) => (w.id === ws.id ? { ...w, repos } : w)), active: ws.id }));
  save();
  void loadSummaries();
}

export function removeRepo(path: string) {
  const ws = activeWorkspace();
  if (!ws) return;
  useWorkspaces.setState((s) => ({
    list: s.list.map((w) => (w.id === ws.id ? { ...w, repos: w.repos.filter((p) => p !== path) } : w)),
  }));
  save();
}

let loadSeq = 0;

export async function loadSummaries() {
  const ws = activeWorkspace();
  if (!ws?.repos.length) return;
  const seq = ++loadSeq;
  useWorkspaces.setState({ loading: true });
  try {
    const got = await api.repoSummaries(ws.repos);
    if (seq !== loadSeq) return;
    useWorkspaces.setState((s) => ({ summaries: { ...s.summaries, ...Object.fromEntries(got.map((g) => [g.path, g])) } }));
  } catch (e) {
    useStore.getState().toast("error", errorText(e));
  } finally {
    if (seq === loadSeq) useWorkspaces.setState({ loading: false });
  }
}

/** Repositories under a folder go into the active workspace. */
export async function scanFolder(dir: string): Promise<number> {
  const found = await api.findRepos(dir);
  const before = activeWorkspace()?.repos.length ?? 0;
  if (found.length) addRepos(found);
  return (activeWorkspace()?.repos.length ?? 0) - before;
}

/** Fetch the given repositories, a few at a time. The repository open in
 * the app is skipped while an operation runs in it. */
export async function fetchRepos(paths: string[]) {
  const queue = paths.filter((p) => !useWorkspaces.getState().fetching.includes(p));
  useWorkspaces.setState((s) => ({
    fetching: [...s.fetching, ...queue],
    fetchErrors: Object.fromEntries(Object.entries(s.fetchErrors).filter(([p]) => !queue.includes(p))),
  }));
  const done = (path: string, error?: string) =>
    useWorkspaces.setState((s) => ({
      fetching: s.fetching.filter((p) => p !== path),
      fetchErrors: error ? { ...s.fetchErrors, [path]: error } : s.fetchErrors,
    }));
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      const st = useStore.getState();
      if (st.repo?.path === path && st.busy) {
        done(path, "Busy with another operation");
        continue;
      }
      try {
        await api.fetch(path);
        done(path);
      } catch (e) {
        done(path, errorText(e));
      }
      if (useStore.getState().repo?.path === path) void useStore.getState().refresh();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await loadSummaries();
}
