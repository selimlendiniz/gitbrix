import { create } from "zustand";

import {
  api,
  CommitDetails,
  errorText,
  FileDiff,
  Graph,
  RepoInfo,
  StashInfo,
  WIP_ID,
  WorkingStatus,
} from "./api";
import { addRecent } from "./recent";
import { loadTabs, saveTabs, Tab } from "./tabs";

const GRAPH_PAGE = 5_000;

export type DiffSource =
  | { kind: "commit"; id: string; path: string; oldPath: string | null }
  | { kind: "wip"; path: string; staged: boolean }
  | { kind: "conflict"; path: string }
  | { kind: "history"; path: string }
  | { kind: "blame"; path: string; rev: string | null }
  | { kind: "rebase"; base: string };

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
  textarea?: { label: string; placeholder?: string };
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
  selectedId: string | null;
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
let detailsSeq = 0;
let diffSeq = 0;

function sameSource(a: DiffSource | null, b: DiffSource | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const useStore = create<State>((set, get) => ({
  repo: null,
  graph: null,
  status: null,
  stashes: [],
  selectedId: null,
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
  tabs: loadTabs().tabs,

  async openRepo(path) {
    set({ loading: true });
    try {
      const info = await api.openRepo(path);
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
      });
      await get().refresh();
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
      set({ loading: false });
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
    const seq = ++refreshSeq;
    try {
      if (scope === "status" && get().graph) {
        const status = await api.status(repo.path);
        if (seq !== refreshSeq || get().repo?.path !== repo.path) return;
        const dirty = status.staged.length + status.unstaged.length + status.conflicted.length > 0;
        const hasWipRow = get().graph?.commits[0]?.id === WIP_ID;
        if (dirty === hasWipRow) {
          set({ status });
          get().reloadOpenDiff(status);
          return;
        }
        // The WIP row has to appear or disappear: fall through to a full load.
      }
      const [info, graph, status, stashes] = await Promise.all([
        api.repoInfo(repo.path),
        api.graph(repo.path, get().graphLimit),
        api.status(repo.path),
        api.stashes(repo.path),
      ]);
      if (seq !== refreshSeq || get().repo?.path !== repo.path) return;
      const stopped = get().repo?.state === "clean" && info.state !== "clean" && status.conflicted.length > 0;
      set({ repo: info, graph, status, stashes });
      // An operation just stopped on conflicts: show them.
      if (stopped) get().select(WIP_ID, true);

      // Keep the selection if it still exists; otherwise fall back to HEAD.
      const { selectedId } = get();
      // Stashes aren't graph rows but can be selected from the sidebar.
      if (selectedId && !graph.commits.some((c) => c.id === selectedId) && !stashes.some((st) => st.id === selectedId)) {
        get().select(info.headOid ?? graph.commits[0]?.id ?? null);
      }

      get().reloadOpenDiff(status);
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

  async loadMoreCommits() {
    set((s) => ({ graphLimit: s.graphLimit + 2 * GRAPH_PAGE }));
    await get().refresh();
  },

  select(id, scroll = false) {
    const repo = get().repo;
    set((s) => ({
      selectedId: id,
      details: null,
      scrollRequest: scroll ? s.scrollRequest + 1 : s.scrollRequest,
    }));
    // A commit's file diff belongs to that commit; history and blame
    // views stay open while you click through commits.
    const src = get().diffSource;
    if (src && (src.kind === "commit" || (src.kind === "wip" && id !== WIP_ID) || (src.kind === "conflict" && id !== WIP_ID))) {
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

  async openDiff(source) {
    const repo = get().repo;
    if (!repo) return;
    const seq = ++diffSeq;
    if (!sameSource(source, get().diffSource)) set({ diffSource: source, diff: null, diffError: null });
    // These views load their own data.
    if (source.kind !== "commit" && source.kind !== "wip") return;
    try {
      const diff =
        source.kind === "commit"
          ? await api.commitFileDiff(repo.path, source.id, source.path, source.oldPath)
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
      ok = false;
      get().toast("error", errorText(e));
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
