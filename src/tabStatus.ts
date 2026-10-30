// What each repository tab shows next to its name: uncommitted changes,
// commits to push and to pull. The open repository's come from the
// store; the others' are read in one call when tabs change, the app
// regains focus, or the open repository is left (it may have changed).

import { create } from "zustand";

import { api, RepoSummary } from "./api";
import { useStore } from "./store";

export interface TabMark {
  changes: number;
  conflicts: number;
  ahead: number;
  behind: number;
}

export const useTabSummaries = create<{ byPath: Record<string, RepoSummary> }>(() => ({ byPath: {} }));

let timer: ReturnType<typeof setTimeout> | null = null;

export function loadTabSummaries() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    const paths = useStore.getState().tabs.map((t) => t.path);
    if (!paths.length) return;
    try {
      const got = await api.repoSummaries(paths);
      useTabSummaries.setState((s) => ({ byPath: { ...s.byPath, ...Object.fromEntries(got.map((g) => [g.path, g])) } }));
    } catch {
      // The marks are a convenience; leave them as they were.
    }
  }, 150);
}

export function markOf(summary: RepoSummary | undefined): TabMark | null {
  if (!summary?.info) return null;
  return { changes: summary.changes, conflicts: summary.conflicts, ahead: summary.info.ahead, behind: summary.info.behind };
}

useStore.subscribe((st, prev) => {
  if (st.tabs !== prev.tabs || st.repo?.path !== prev.repo?.path) loadTabSummaries();
});
