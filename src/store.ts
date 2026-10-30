import { create } from "zustand";

import {
  api,
  CommitDetails,
  errorText,
  FileDiff,
  Graph,
  GraphFilter,
  RemoteInfo,
  RepoInfo,
  StashInfo,
  SubmoduleInfo,
  Worktree,
  WIP_ID,
  WorkingStatus,
} from "./api";
import { addRecent } from "./recent";
import { useSettings } from "./settings";
import { loadTabs, saveTabs, Tab } from "./tabs";

const FILTER_KEY = "gitbrix.graphFilter";

function loadGraphFilter(repo: string): GraphFilter {
  try {
    const all = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    const f = all[repo];
    if (f && Array.isArray(f.hidden) && Array.isArray(f.solo)) return f;
  } catch {
    // fall through
  }
  return { hidden: [], solo: [] };
}

function saveGraphFilter(repo: string, f: GraphFilter) {
  try {
    const all = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}");
    if (f.hidden.length || f.solo.length) all[repo] = f;
    else delete all[repo];
    localStorage.setItem(FILTER_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

const GRAPH_PAGE = 5_000;

export type DiffSource =
  | { kind: "commit"; id: string; path: string; oldPath: string | null }
  | { kind: "wip"; path: string; staged: boolean }
  | { kind: "compare"; from: string; to: string; path: string; oldPath: string | null }
  | { kind: "conflict"; path: string }
  | { kind: "history"; path: string }
  | { kind: "blame"; path: string; rev: string | null }
  | { kind: "rebase"; base: string }
  | { kind: "reflog" }
  | { kind: "tree"; rev: string; path: string | null }
  | { kind: "stats" };

export interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}

export interface PromptRequest {
  kind: "prompt";
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Let the user submit an empty input. */
  allowEmpty?: boolean;
  /** Optional checkbox under the input, e.g. "Check out after create". */
  checkbox?: { label: string; initial: boolean };
  /** Multi-line textarea under the input, e.g. a tag message. */
  textarea?: { label: string; placeholder?: string; initial?: string };
  resolve: (r: PromptResult | null) => void;
}

export interface PromptResult {
  value: string;
  checked: boolean;
  text: string;
}

export interface ConfirmRequest {
  kind: "confirm";
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface State {
  repo: RepoInfo | null;
  graph: Graph | null;
  status: WorkingStatus | null;
  stashes: StashInfo[];
  remotes: RemoteInfo[];
  worktrees: Worktree[];
  submodules: SubmoduleInfo[];
  selectedId: string | null;
  /** Second commit picked with Ctrl/Shift+click to compare against. */
  compareId: string | null;
  /** Three or more commits picked with Ctrl/Shift+click (graph order,
   *  newest first); empty otherwise. */
  multi: string[];
  details: CommitDetails | null;
  diffSource: DiffSource | null;
  diff: FileDiff | null;
  diffError: string | null;
  busy: string | null;
  /** Latest progress line from git while `busy`. */
  progress: string | null;
  loading: boolean;
  toasts: Toast[];
  dialog: PromptRequest | ConfirmRequest | null;
  menu: MenuState | null;
  /** Bumped to ask the graph to scroll the selection into view. */
  scrollRequest: number;
  /** How many commits the graph loads; grows with "load more". */
  graphLimit: number;
  graphFilter: GraphFilter;
  setGraphFilter: (f: GraphFilter) => Promise<void>;

  /** Open repositories, one per tab. */
  tabs: Tab[];
  openRepo: (path: string) => Promise<void>;
  /** Leave the current repository for the welcome screen (tabs stay). */
  closeRepo: () => void;
  closeTab: (path: string) => void;
  /** "status" re-reads only the working tree, unless the WIP row must
   *  appear or disappear; "all" reloads refs and the graph too. */
  refresh: (scope?: "all" | "status") => Promise<void>;
  loadMoreCommits: () => Promise<void>;
  select: (id: string | null, scroll?: boolean) => void;
  setCompare: (id: string | null) => void;
  /** Ctrl+click (toggle `id`) or Shift+click (`range` from the selected
   *  commit): two commits compare, more make a multi-selection. */
  extendSelection: (id: string, range: boolean) => void;
  openDiff: (source: DiffSource) => Promise<void>;
  reloadOpenDiff: (status: WorkingStatus) => void;
  closeDiff: () => void;
  run: (
    label: string,
    fn: (repo: string) => Promise<unknown>,
    success?: string,
    scope?: "all" | "status",
  ) => Promise<boolean>;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
  prompt: (req: Omit<PromptRequest, "kind" | "resolve">) => Promise<PromptResult | null>;
  confirm: (req: Omit<ConfirmRequest, "kind" | "resolve">) => Promise<boolean>;
  closeDialog: () => void;
  showMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeMenu: () => void;
}

let toastSeq = 0;
// Responses from an earlier refresh or selection must not overwrite newer
// ones, so each async load checks it is still the latest of its kind.
let refreshSeq = 0;
let statusSeq = 0;
let openSeq = 0;
let detailsSeq = 0;
let diffSeq = 0;
let loadingMore = false;

function sameSource(a: DiffSource | null, b: DiffSource | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The operation stopped because local changes would be overwritten (not
 *  a stash being applied over them). */
export function blockedByLocalChanges(text: string): boolean {
  return /local changes.*would be overwritten/i.test(text) && !/by the stash/i.test(text);
}

/** Stash the local changes, run `fn` again, and put the changes back
 *  (asking first unless Settings → Auto-stash says always). */
async function retryWithStash(
  repo: string,
  label: string,
  fn: (repo: string) => Promise<unknown>,
  success: string | undefined,
  blocked: string,
): Promise<boolean> {
  const st = useStore.getState();
  if (useSettings.getState().autoStash !== "always") {
    const ok = await st.confirm({
      title: "Local changes in the way",
      message: `${blocked}\n\nStash them, carry on (${label.toLowerCase()}), then put them back?`,
      confirmLabel: "Stash and carry on",
    });
    if (!ok) return false;
  }
  let stashId: string | null = null;
  try {
    await api.stashSave(repo, `gitbrix: autostash (${label.toLowerCase()})`, true);
    stashId = (await api.stashes(repo))[0]?.id ?? null;
  } catch (e) {
    st.toast("error", `Couldn't stash the local changes: ${errorText(e)}`);
    return false;
  }
  let failure: string | null = null;
  try {
    await fn(repo);
  } catch (e) {
    failure = errorText(e);
  }
  try {
    await api.stashApply(repo, 0, true, stashId);
  } catch {
    st.toast(
      "error",
      `${failure ? `${failure}\n` : ""}Your local changes didn't go back cleanly; they are kept in the stash list (“autostash”).`,
    );
    return !failure;
  }
  if (failure) {
    st.toast("error", failure);
    return false;
  }
  if (success) st.toast("info", `${success} (local changes stashed and put back)`);
  return true;
}

export const useStore = create<State>((set, get) => ({
  repo: null,
  graph: null,
  status: null,
  stashes: [],
  remotes: [],
  worktrees: [],
  submodules: [],
  selectedId: null,
  compareId: null,
  multi: [],
  details: null,
  diffSource: null,
  diff: null,
  diffError: null,
  busy: null,
  progress: null,
  loading: false,
  toasts: [],
  dialog: null,
  menu: null,
  scrollRequest: 0,
  graphLimit: GRAPH_PAGE,
  graphFilter: { hidden: [], solo: [] },
  tabs: loadTabs().tabs,

  async openRepo(path) {
    const seq = ++openSeq;
    set({ loading: true });
    try {
      const info = await api.openRepo(path);
      // A later open (another tab clicked meanwhile) wins.
      if (seq !== openSeq) return;
      addRecent(info.path, info.name);
      const tabs = get().tabs.some((t) => t.path === info.path)
        ? get().tabs
        : [...get().tabs, { path: info.path, name: info.name }];
      set({ tabs });
      saveTabs(tabs, info.path);
      // Without a watcher the app still refreshes on window focus.
      api.watchRepo(info.path).catch((e) => console.warn("watch failed:", errorText(e)));
      set({
        repo: info,
        graph: null,
        status: null,
        stashes: [],
        selectedId: null,
        details: null,
        diffSource: null,
        diff: null,
        graphLimit: GRAPH_PAGE,
        graphFilter: loadGraphFilter(info.path),
      });
      await get().refresh();
      if (seq !== openSeq) return;
      const { graph, status } = get();
      const dirty = status && (status.staged.length || status.unstaged.length || status.conflicted.length);
      get().select(dirty ? WIP_ID : graph?.commits[0]?.id ?? null);
    } catch (e) {
      get().toast("error", errorText(e));
      // A tab whose repository can't be opened (moved, deleted) goes away.
      if (get().tabs.some((t) => t.path === path) && get().repo?.path !== path) {
        const tabs = get().tabs.filter((t) => t.path !== path);
        set({ tabs });
        saveTabs(tabs, get().repo?.path ?? null);
      }
    } finally {
      if (seq === openSeq) set({ loading: false });
    }
  },

  closeTab(path) {
    const { tabs, repo } = get();
    const i = tabs.findIndex((t) => t.path === path);
    const rest = tabs.filter((t) => t.path !== path);
    set({ tabs: rest });
    if (repo?.path !== path) {
      saveTabs(rest, repo?.path ?? null);
      return;
    }
    const next = rest[Math.min(i, rest.length - 1)];
    saveTabs(rest, next?.path ?? null);
    if (next) void get().openRepo(next.path);
    else get().closeRepo();
  },

  closeRepo() {
    saveTabs(get().tabs, null);
    api.unwatchRepo().catch(() => {});
    set({ repo: null, graph: null, status: null, stashes: [], selectedId: null, details: null, diffSource: null, diff: null });
  },

  async refresh(scope = "all") {
    const repo = get().repo;
    if (!repo) return;
    try {
      if (scope === "status" && get().graph) {
        // Own counter: a status-only load must not cancel a full refresh
        // that is already running (it would drop that refresh's graph).
        const sseq = ++statusSeq;
        const status = await api.status(repo.path);
        if (sseq !== statusSeq || get().repo?.path !== repo.path) return;
        const dirty = status.staged.length + status.unstaged.length + status.conflicted.length > 0;
        const hasWipRow = get().graph?.commits[0]?.id === WIP_ID;
        if (dirty === hasWipRow) {
          set({ status });
          get().reloadOpenDiff(status);
          return;
        }
        // The WIP row has to appear or disappear: fall through to a full load.
      }
      const seq = ++refreshSeq;
      // Also a status load: if a status-only refresh starts after this one,
      // its newer result must win over ours.
      const sseq = ++statusSeq;
      const [info, graph, status, stashes, remotes, worktrees, submodules] = await Promise.all([
        api.repoInfo(repo.path),
        api.graph(repo.path, get().graphLimit, get().graphFilter),
        api.status(repo.path),
        api.stashes(repo.path),
        api.remotes(repo.path),
        api.worktrees(repo.path).catch(() => [] as Worktree[]),
        api.submodules(repo.path).catch(() => [] as SubmoduleInfo[]),
      ]);
      if (seq !== refreshSeq || get().repo?.path !== repo.path) return;
      const stopped = get().repo?.state === "clean" && info.state !== "clean" && status.conflicted.length > 0;
      set(sseq === statusSeq ? { repo: info, graph, status, stashes, remotes, worktrees, submodules } : { repo: info, graph, stashes, remotes, worktrees, submodules });
      window.dispatchEvent(new Event("gitbrix:refreshed"));
      // An operation just stopped on conflicts: show them.
      if (stopped) get().select(WIP_ID, true);

      // Keep the selection if it still exists; otherwise fall back to HEAD.
      const { selectedId } = get();
      // Forget filter entries for refs that no longer exist.
      const names = new Set(graph.refs.map((r) => r.fullName));
      const f = get().graphFilter;
      if (f.hidden.some((h) => !names.has(h)) || f.solo.some((x) => !names.has(x))) {
        void get().setGraphFilter({ hidden: f.hidden.filter((h) => names.has(h)), solo: f.solo.filter((x) => names.has(x)) });
      }
      // Nothing selected (e.g. a fresh repository) and changes appeared.
      if (!selectedId && graph.commits[0]?.id === WIP_ID) get().select(WIP_ID);
      // Stashes aren't graph rows but can be selected from the sidebar.
      const { compareId, multi } = get();
      if (compareId && !graph.commits.some((c) => c.id === compareId)) set({ compareId: null });
      if (multi.length) {
        const kept = multi.filter((id) => graph.commits.some((c) => c.id === id));
        if (kept.length !== multi.length) set({ multi: kept.length > 2 ? kept : [] });
      }
      if (selectedId && !graph.commits.some((c) => c.id === selectedId) && !stashes.some((st) => st.id === selectedId)) {
        get().select(info.headOid ?? graph.commits[0]?.id ?? null);
      }

      get().reloadOpenDiff(get().status ?? status);
    } catch (e) {
      get().toast("error", errorText(e));
    }
  },

  reloadOpenDiff(status) {
    // A working-tree diff may be stale now; reload it or close it.
    const src = get().diffSource;
    if (src?.kind === "conflict" && !status.conflicted.some((e) => e.path === src.path)) {
      get().closeDiff();
    } else if (src?.kind === "wip") {
      const list = src.staged ? status.staged : [...status.unstaged, ...status.conflicted];
      if (list.some((e) => e.path === src.path)) {
        void get().openDiff(src);
      } else {
        const other = src.staged ? status.unstaged : status.staged;
        if (other.some((e) => e.path === src.path)) {
          void get().openDiff({ ...src, staged: !src.staged });
        } else {
          get().closeDiff();
        }
      }
    }
  },

  async setGraphFilter(f) {
    const repo = get().repo;
    if (!repo) return;
    set({ graphFilter: f });
    saveGraphFilter(repo.path, f);
    await get().refresh();
  },

  async loadMoreCommits() {
    if (loadingMore) return;
    loadingMore = true;
    try {
      set((s) => ({ graphLimit: s.graphLimit + 2 * GRAPH_PAGE }));
      await get().refresh();
    } finally {
      loadingMore = false;
    }
  },

  select(id, scroll = false) {
    const repo = get().repo;
    set((s) => ({
      selectedId: id,
      compareId: null,
      multi: [],
      details: null,
      scrollRequest: scroll ? s.scrollRequest + 1 : s.scrollRequest,
    }));
    // A commit's file diff belongs to that commit; history and blame
    // views stay open while you click through commits.
    const src = get().diffSource;
    if (
      src &&
      (src.kind === "commit" || src.kind === "compare" || (src.kind === "wip" && id !== WIP_ID) || (src.kind === "conflict" && id !== WIP_ID))
    ) {
      get().closeDiff();
    }
    if (!repo || !id || id === WIP_ID) return;
    const seq = ++detailsSeq;
    api
      .commitDetails(repo.path, id)
      .then((details) => {
        if (seq === detailsSeq) set({ details });
      })
      .catch((e) => get().toast("error", errorText(e)));
  },

  setCompare(id) {
    if (get().diffSource?.kind === "compare" || get().diffSource?.kind === "commit") get().closeDiff();
    set({ compareId: id && id !== get().selectedId && id !== WIP_ID ? id : null, multi: [] });
  },

  extendSelection(id, range) {
    const { selectedId, compareId, multi, graph } = get();
    const commits = (graph?.commits ?? []).filter((c) => c.kind === "commit");
    const order = new Map(commits.map((c, i) => [c.id, i]));
    if (!selectedId || selectedId === WIP_ID || !order.has(id) || !order.has(selectedId)) {
      get().select(id);
      return;
    }
    let picked = multi.length ? [...multi] : [selectedId, ...(compareId ? [compareId] : [])];
    if (range) {
      const [a, b] = [order.get(selectedId)!, order.get(id)!].sort((x, y) => x - y);
      picked = commits.slice(a, b + 1).map((c) => c.id);
    } else if (picked.includes(id)) {
      picked = picked.filter((x) => x !== id);
    } else {
      picked.push(id);
    }
    picked.sort((x, y) => order.get(x)! - order.get(y)!);
    // The commit clicked first stays the anchor for Shift ranges.
    const anchor = picked.includes(selectedId) ? selectedId : picked[0];
    if (picked.length <= 1) {
      get().select(picked[0] ?? id);
    } else if (picked.length === 2) {
      set({ selectedId: anchor, multi: [] });
      get().setCompare(picked.find((x) => x !== anchor) ?? null);
    } else {
      const src = get().diffSource;
      if (src?.kind === "compare" || src?.kind === "commit") get().closeDiff();
      set({ selectedId: anchor, compareId: null, multi: picked });
    }
  },

  async openDiff(source) {
    const repo = get().repo;
    if (!repo) return;
    const seq = ++diffSeq;
    if (!sameSource(source, get().diffSource)) set({ diffSource: source, diff: null, diffError: null });
    // These views load their own data.
    if (source.kind !== "commit" && source.kind !== "wip" && source.kind !== "compare") return; // views that load their own data
    try {
      const ws = useSettings.getState().ignoreWhitespace;
      const diff =
        source.kind === "commit"
          ? await api.commitFileDiff(repo.path, source.id, source.path, source.oldPath, ws)
          : source.kind === "compare"
            ? await api.compareFileDiff(repo.path, source.from, source.to, source.path, source.oldPath, ws)
            : await api.workdirFileDiff(repo.path, source.path, source.staged);
      if (seq === diffSeq) set({ diff, diffError: null });
    } catch (e) {
      if (seq === diffSeq) set({ diff: null, diffError: errorText(e) });
    }
  },

  closeDiff() {
    diffSeq++;
    set({ diffSource: null, diff: null, diffError: null });
  },

  async run(label, fn, success, scope = "all") {
    const repo = get().repo;
    if (!repo || get().busy) return false;
    set({ busy: label, progress: null });
    let ok = true;
    try {
      await fn(repo.path);
      if (success) get().toast("info", success);
    } catch (e) {
      const text = errorText(e);
      ok = blockedByLocalChanges(text) ? await retryWithStash(repo.path, label, fn, success, text) : false;
      if (!blockedByLocalChanges(text)) get().toast("error", text);
    } finally {
      set({ busy: null, progress: null });
      await get().refresh(scope);
    }
    return ok;
  },

  toast(kind, text) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 3500);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  prompt(req) {
    return new Promise((resolve) => {
      set({
        dialog: {
          ...req,
          kind: "prompt",
          resolve: (r) => {
            set({ dialog: null });
            resolve(r);
          },
        },
      });
    });
  },

  confirm(req) {
    return new Promise((resolve) => {
      set({
        dialog: {
          ...req,
          kind: "confirm",
          resolve: (ok) => {
            set({ dialog: null });
            resolve(ok);
          },
        },
      });
    });
  },

  closeDialog() {
    const d = get().dialog;
    if (!d) return;
    if (d.kind === "prompt") d.resolve(null);
    else d.resolve(false);
  },

  showMenu(x, y, items) {
    set({ menu: { x, y, items } });
  },

  closeMenu() {
    set({ menu: null });
  },
}));
