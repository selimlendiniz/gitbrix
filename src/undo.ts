// Undo for operations done in the app. Each successful operation pushes
// how to reverse it; Undo runs the newest one.
//
// HEAD-moving operations (commit, checkout, merge, rebase, reset, ...)
// record HEAD before and after: undo switches back to the previous branch,
// or moves the branch back with `reset --keep`, which refuses to touch
// files you have changed since. Ref deletions record what to recreate.

import { create } from "zustand";

import { api, RepoInfo, ResetMode } from "./api";
import { shortId } from "./format";
import { useStore } from "./store";

export interface UndoEntry {
  label: string;
  repo: string;
  run: (repo: string) => Promise<unknown>;
}

const MAX = 30;

export const useUndo = create<{ stack: UndoEntry[] }>(() => ({ stack: [] }));

export function pushUndo(entry: UndoEntry) {
  useUndo.setState((s) => ({ stack: [...s.stack, entry].slice(-MAX) }));
}

/** The entry Undo would run for the open repository. */
export function nextUndo(stack: UndoEntry[], repo: string | undefined): UndoEntry | undefined {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].repo === repo) return stack[i];
  return undefined;
}

export async function undoLast() {
  const store = useStore.getState();
  const repo = store.repo?.path;
  const { stack } = useUndo.getState();
  const entry = nextUndo(stack, repo);
  if (!entry || store.busy) return;
  const ok = await store.run(`Undoing ${entry.label}`, entry.run, `Undid ${entry.label}`);
  if (ok) useUndo.setState((s) => ({ stack: s.stack.filter((e) => e !== entry) }));
}

/** How to get from HEAD `after` back to HEAD `before`, or null. The
 *  returned function first checks HEAD is still where `after` left it:
 *  if anything moved it since (a commit from a terminal), undoing would
 *  throw that work away, so it refuses. */
export function headUndo(before: RepoInfo, after: RepoInfo): ((repo: string) => Promise<unknown>) | null {
  if (!before.headOid) return null; // nothing to go back to
  let undo: (repo: string) => Promise<unknown>;
  if (before.headBranch !== after.headBranch || before.detached !== after.detached) {
    const branch = before.headBranch;
    const oid = before.headOid;
    undo = before.detached || !branch ? (r) => api.checkoutDetached(r, oid) : (r) => api.checkoutBranch(r, branch);
  } else if (before.headOid !== after.headOid) {
    const oid = before.headOid;
    const mode: ResetMode = "keep";
    undo = (r) => api.reset(r, oid, mode);
  } else {
    return null;
  }
  return async (r) => {
    const now = await api.repoInfo(r);
    if (now.headOid !== after.headOid || now.headBranch !== after.headBranch) {
      throw "HEAD has moved since then (another commit or checkout), so this can't be undone safely.";
    }
    return undo(r);
  };
}

/** Run an operation that may move HEAD and make it undoable. `op`
 *  returns whether it succeeded (as `store.run` does). */
export async function trackHead(label: string, op: () => Promise<boolean>): Promise<boolean> {
  const repo = useStore.getState().repo?.path;
  if (!repo) return op();
  const before = await api.repoInfo(repo).catch(() => null);
  const ok = await op();
  if (!ok || !before) return ok;
  const after = await api.repoInfo(repo).catch(() => null);
  const undo = after && headUndo(before, after);
  if (undo) pushUndo({ label, repo, run: undo });
  return ok;
}

export const describe = {
  commit: (summary: string) => `commit “${summary.length > 40 ? summary.slice(0, 40) + "…" : summary}”`,
  at: (id: string) => shortId(id),
};
