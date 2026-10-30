// Reviewing a request in the app: threads of comments (reply, resolve),
// line comments kept as a pending review until sent together, and
// suggested changes put into the work tree.

import { create } from "zustand";

import { api, errorText, LineAt, PrComment, PullRequest, ReviewVerdict } from "./api";
import { prKey, usePrView } from "./prs";
import { useStore } from "./store";

/** A comment on its own, or a thread (first comment, then replies). */
export type Entry = { kind: "comment"; comment: PrComment } | { kind: "thread"; id: string; comments: PrComment[]; resolvable: boolean; resolved: boolean };

/** Comments (oldest first) grouped into threads, in the order each starts. */
export function groupComments(comments: PrComment[]): Entry[] {
  const out: Entry[] = [];
  const threads = new Map<string, Extract<Entry, { kind: "thread" }>>();
  for (const c of comments) {
    if (!c.thread) {
      out.push({ kind: "comment", comment: c });
      continue;
    }
    let t = threads.get(c.thread);
    if (!t) {
      t = { kind: "thread", id: c.thread, comments: [], resolvable: c.resolvable, resolved: c.resolved };
      threads.set(c.thread, t);
      out.push(t);
    }
    t.comments.push(c);
  }
  return out;
}

/** The request's conversation, read again (after a reply, a review…). */
export async function refreshConversation() {
  const pr = usePrView.getState().pr;
  const repo = useStore.getState().repo?.path;
  if (!pr || !repo) return;
  try {
    usePrView.setState({ conv: await api.pullRequestConversation(repo, pr.remote, pr.number) });
  } catch (e) {
    useStore.getState().toast("error", errorText(e));
  }
}

async function onRequest(what: string, fn: (repo: string, pr: PullRequest) => Promise<unknown>): Promise<boolean> {
  const pr = usePrView.getState().pr;
  const repo = useStore.getState().repo?.path;
  if (!pr || !repo) return false;
  try {
    await fn(repo, pr);
    await refreshConversation();
    return true;
  } catch (e) {
    useStore.getState().toast("error", `${what}: ${errorText(e)}`);
    return false;
  }
}

export function replyToThread(thread: string, first: PrComment, body: string) {
  return onRequest("Couldn't reply", (repo, pr) => api.replyPullRequest(repo, pr.remote, pr.number, thread, first.id, body));
}

export function setResolved(thread: string, resolved: boolean) {
  return onRequest(resolved ? "Couldn't resolve" : "Couldn't reopen", (repo, pr) =>
    api.resolvePullRequestThread(repo, pr.remote, pr.number, thread, resolved),
  );
}

// ---------------------------------------------------------------------------
// The pending review: line comments not sent yet, per request, kept across
// restarts so a half-done review isn't lost.

export interface Pending extends LineAt {
  body: string;
}

const KEY = "gitbrix.review.pending";

function load(): Record<string, Pending[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export const useReview = create<{ pending: Record<string, Pending[]> }>(() => ({
  pending: typeof localStorage === "undefined" ? {} : load(),
}));

function save(pending: Record<string, Pending[]>) {
  useReview.setState({ pending });
  try {
    localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // ignore
  }
}

export function addPending(pr: PullRequest, c: Pending) {
  const all = useReview.getState().pending;
  save({ ...all, [prKey(pr)]: [...(all[prKey(pr)] ?? []), c] });
}

export function removePending(pr: PullRequest, index: number) {
  const all = useReview.getState().pending;
  const list = (all[prKey(pr)] ?? []).filter((_, i) => i !== index);
  const { [prKey(pr)]: _drop, ...rest } = all;
  save(list.length ? { ...rest, [prKey(pr)]: list } : rest);
}

export async function submitReview(pr: PullRequest, body: string, verdict: ReviewVerdict): Promise<boolean> {
  const comments = useReview.getState().pending[prKey(pr)] ?? [];
  const ok = await onRequest("Couldn't send the review", (repo) =>
    api.reviewPullRequest(repo, pr.remote, pr.number, { body, verdict, comments }),
  );
  if (ok) {
    const { [prKey(pr)]: _sent, ...rest } = useReview.getState().pending;
    save(rest);
    useStore.getState().toast("info", verdict === "approve" ? "Review sent, approved" : "Review sent");
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Suggested changes: GitHub's ```suggestion, GitLab's ```suggestion:-N+M
// (lines above and below the commented one).

export interface Suggestion {
  /** 1-based, inclusive. */
  from: number;
  to: number;
  text: string;
}

export function suggestionOf(c: Pick<PrComment, "body" | "line" | "startLine">): Suggestion | null {
  if (c.line == null) return null;
  const m = c.body.match(/```suggestion(?::-(\d+)\+(\d+))?[^\n]*\n([\s\S]*?)\n?```/);
  if (!m) return null;
  const above = m[1] ? Number(m[1]) : 0;
  const below = m[2] ? Number(m[2]) : 0;
  const from = m[1] ? c.line - above : (c.startLine ?? c.line);
  return { from, to: c.line + below, text: m[3] };
}

/** A suggestion block for the line, in the service's syntax. */
export function suggestionTemplate(provider: PullRequest["provider"], line: string): string {
  return `\`\`\`${provider === "gitlab" ? "suggestion:-0+0" : "suggestion"}\n${line}\n\`\`\``;
}

/** Put a comment's suggestion into the work tree (the request's branch
 * must be checked out), for the user to commit. */
export async function applySuggestion(c: PrComment) {
  const s = suggestionOf(c);
  const st = useStore.getState();
  const pr = usePrView.getState().pr;
  if (!s || !c.path || !pr || !st.repo) return;
  if (st.repo.headBranch !== pr.sourceBranch) {
    st.toast("error", `Check out ${pr.sourceBranch} first: the suggestion goes into its files`);
    return;
  }
  await st.run(
    `Applying the suggestion to ${c.path}`,
    (repo) => api.applySuggestion(repo, c.path!, s.from, s.to, s.text),
    `Applied to ${c.path}; review and commit it`,
    "status",
  );
}
