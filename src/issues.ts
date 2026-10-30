// Issues of the open repositories' remotes (sidebar), the one shown in the
// issue window, and starting work on one: a branch named after it, whose
// commits are offered "Closes #N".

import { create } from "zustand";

import { api, errorText, Issue, Issues } from "./api";
import { begin, end } from "./activity";
import { pushUndo } from "./undo";
import { useStore } from "./store";

export interface RepoIssues extends Issues {
  error?: string;
  loading?: boolean;
}

export const useIssues = create<{ byRepo: Record<string, RepoIssues> }>(() => ({ byRepo: {} }));

/** The issue shown in the issue window. */
export const useIssueView = create<{ issue: Issue | null }>(() => ({ issue: null }));

const inFlight = new Set<string>();

/** List the repository's open issues. */
export async function loadIssues(repo: string) {
  if (inFlight.has(repo)) return;
  inFlight.add(repo);
  const empty: RepoIssues = { items: [], problems: [], covered: false, projects: [] };
  const patch = (p: Partial<RepoIssues>) =>
    useIssues.setState((s) => ({ byRepo: { ...s.byRepo, [repo]: { ...(s.byRepo[repo] ?? empty), ...p } } }));
  patch({ loading: true });
  const task = begin(`Checking issues of ${repo.split("/").pop()}`);
  try {
    const res = await api.issues(repo);
    patch({ ...res, error: undefined, loading: false });
    end(task);
  } catch (e) {
    patch({ error: errorText(e), loading: false });
    end(task, errorText(e));
  } finally {
    inFlight.delete(repo);
  }
}

export function issueLabel(issue: Pick<Issue, "number">): string {
  return `#${issue.number}`;
}

/** Assigned to the user first, then most recently updated. */
export function sortIssues(items: Issue[]): Issue[] {
  return [...items].sort((a, b) => Number(b.assignedToMe) - Number(a.assignedToMe) || b.updated.localeCompare(a.updated));
}

/** `123-login-fails-on-safari`: the number, then the title in plain words. */
export function issueBranchName(issue: Pick<Issue, "number" | "title">): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `${issue.number}-${slug}` : `issue-${issue.number}`;
}

/**
 * The issue a branch was started for, from its name: `123-...`, with an
 * optional `prefix/` (`feature/123-...`).
 */
export function issueOfBranch(branch: string | null | undefined): number | null {
  const m = branch?.match(/^(?:[\w.-]+\/)?(\d+)-/);
  return m ? Number(m[1]) : null;
}

/** "Closes #N", unless the message already mentions the issue. */
export function withClosing(body: string, issue: number): string {
  if (new RegExp(`#${issue}\\b`).test(body)) return body;
  const line = `Closes #${issue}`;
  return body.trim() ? `${body.trimEnd()}\n\n${line}` : line;
}

/** The remote's main branch to start from: its `main` or `master`. */
function startPoint(remote: string): { name: string; target: string } | null {
  const refs = useStore.getState().graph?.refs ?? [];
  for (const name of ["main", "master", "develop"]) {
    const ref = refs.find((r) => r.kind === "remote" && r.name === `${remote}/${name}`);
    if (ref) return { name: ref.name, target: ref.target };
  }
  return null;
}

/** A branch for the issue, from the remote's main branch, checked out. */
export async function startWork(issue: Issue) {
  const s = useStore.getState();
  const start = startPoint(issue.remote);
  useIssueView.setState({ issue: null });
  const res = await s.prompt({
    title: `Start work on ${issueLabel(issue)}`,
    label: start ? `New branch from ${start.name}` : "New branch from the checked-out commit",
    initial: issueBranchName(issue),
    confirmLabel: "Create and check out",
  });
  const name = res?.value.trim();
  if (!res || !name) return;
  const repo = s.repo;
  const prevBranch = repo?.headBranch ?? null;
  const prevOid = repo?.headOid ?? null;
  // From the commit, not the remote branch: a new branch shouldn't track
  // (and push to) main.
  const ok = await s.run(`Creating ${name}`, (r) => api.createBranch(r, name, start?.target ?? null, true), `Working on ${issueLabel(issue)} in ${name}`);
  if (!ok || !repo) return;
  pushUndo({
    label: `create branch ${name}`,
    repo: repo.path,
    run: async (r) => {
      if (prevBranch) await api.checkoutBranch(r, prevBranch);
      else if (prevOid) await api.checkoutDetached(r, prevOid);
      await api.deleteBranch(r, name, false);
    },
  });
}
