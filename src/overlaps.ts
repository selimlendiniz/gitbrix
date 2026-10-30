// Other people's branches that clash with the work here: files that would
// conflict merging them with HEAD, and files being edited that they
// changed too. Checked again when HEAD, the branches or the work tree change.

import { create } from "zustand";

import { api, Overlap } from "./api";
import { useStore } from "./store";

export const useOverlaps = create<{ byRepo: Record<string, Overlap[]> }>(() => ({ byRepo: {} }));

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;

/** Check the open repository, soon (changes come in bursts). */
export function loadOverlaps(delay = 600) {
  clearTimeout(timer);
  timer = setTimeout(() => void check(), delay);
}

async function check() {
  if (running) {
    again = true;
    return;
  }
  const repo = useStore.getState().repo?.path;
  if (!repo) return;
  running = true;
  try {
    const list = await api.overlaps(repo);
    useOverlaps.setState((s) => ({ byRepo: { ...s.byRepo, [repo]: list } }));
  } catch {
    // A hint, not an operation: no error to show.
  } finally {
    running = false;
    if (again) {
      again = false;
      loadOverlaps(0);
    }
  }
}

/** Per path, the branches that clash on it and how. */
export function clashesByPath(list: Overlap[]): Map<string, { branch: string; conflict: boolean }[]> {
  const out = new Map<string, { branch: string; conflict: boolean }[]>();
  for (const o of list) {
    for (const [paths, conflict] of [
      [o.conflicts, true],
      [o.edited, false],
    ] as const) {
      for (const p of paths) out.set(p, [...(out.get(p) ?? []), { branch: o.branch, conflict }]);
    }
  }
  return out;
}

// What the answer depends on: HEAD, the branch tips, the changed files.
useStore.subscribe((st, prev) => {
  if (!st.repo) return;
  if (
    st.repo.path !== prev.repo?.path ||
    st.repo.headOid !== prev.repo?.headOid ||
    st.graph?.refs !== prev.graph?.refs ||
    st.status !== prev.status
  ) {
    loadOverlaps();
  }
});
