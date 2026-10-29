// Pull/merge requests: the open repositories' (sidebar) and, across all
// accounts, the ones involving the user (the Pull Requests window). Both
// are checked in the background; a new request the user may approve
// raises one desktop notification, whichever list sees it first. What was
// open the first time a list is seen doesn't.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { api, errorText, PullRequest, PullRequestInbox, PullRequests } from "./api";
import { useSettings } from "./settings";

export interface RepoPrs extends PullRequests {
  error?: string;
  loading?: boolean;
}

export interface InboxPrs extends PullRequestInbox {
  error?: string;
  loading?: boolean;
}

export const usePrs = create<{ byRepo: Record<string, RepoPrs>; inbox: InboxPrs | null }>(() => ({
  byRepo: {},
  inbox: null,
}));

const MEMORY = "gitbrix.prs.memory";

/**
 * `seen`: per list (a project, or an account's inbox), the requests open at
 * its last check. `notified`: requests already notified about.
 */
export interface Memory {
  seen: Record<string, string[]>;
  notified: string[];
}

/** A list of requests checked as one: a project's, or an account's inbox. */
export interface Source {
  key: string;
  items: PullRequest[];
}

function loadMemory(): Memory {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMORY) ?? "{}");
    return { seen: raw?.seen ?? {}, notified: Array.isArray(raw?.notified) ? raw.notified : [] };
  } catch {
    return { seen: {}, notified: [] };
  }
}

function saveMemory(mem: Memory) {
  try {
    localStorage.setItem(MEMORY, JSON.stringify(mem));
  } catch {
    // ignore
  }
}

export function prLabel(pr: PullRequest): string {
  return pr.provider === "gitlab" ? `!${pr.number}` : `#${pr.number}`;
}

export function prKey(pr: PullRequest): string {
  return `${pr.project}#${pr.number}`;
}

/** Someone else's request, ready for review, that the user may approve. */
export function wantsReview(pr: PullRequest): boolean {
  return pr.canApprove && !pr.mine && !pr.draft && !pr.approvedByMe;
}

export function repoSources(res: PullRequests): Source[] {
  return res.projects.map((project) => ({ key: project, items: res.items.filter((p) => p.project === project) }));
}

export function inboxSources(res: PullRequestInbox): Source[] {
  return res.accounts.map((id) => ({ key: `inbox:${id}`, items: res.items.filter((p) => p.account === id) }));
}

/**
 * The requests to notify about, and what to remember. The first look at a
 * list only records what is open; after that a request is news once it
 * wants the user's review (a draft becoming ready counts), unless another
 * list already brought it up.
 */
export function newForReview(sources: Source[], mem: Memory): { fresh: PullRequest[]; mem: Memory } {
  const seen = { ...mem.seen };
  const notified = new Set(mem.notified);
  const fresh: PullRequest[] = [];
  for (const { key, items } of sources) {
    const known = seen[key];
    if (!known) {
      seen[key] = items.map(prKey);
      continue;
    }
    const added = items.filter((p) => wantsReview(p) && !known.includes(prKey(p)));
    for (const p of added) {
      if (notified.has(prKey(p))) continue;
      notified.add(prKey(p));
      fresh.push(p);
    }
    // Only open ones are kept, so the lists don't grow forever.
    const open = new Set(items.map(prKey));
    seen[key] = [...known.filter((k) => open.has(k)), ...added.map(prKey)];
  }
  return { fresh, mem: { seen, notified: [...notified].slice(-500) } };
}

function notify(prs: PullRequest[]) {
  if (!prs.length || !useSettings.getState().prNotify) return;
  const name = (pr: PullRequest) => pr.project.split("/").pop();
  const options =
    prs.length === 1
      ? {
          title: `${prs[0].reviewRequested ? "Review requested" : "Ready for your approval"}: ${prLabel(prs[0])} ${prs[0].title}`,
          body: `${prs[0].author} · ${prs[0].sourceBranch} → ${prs[0].targetBranch} · ${name(prs[0])}`,
        }
      : {
          title: `${prs.length} new requests ready for your approval`,
          body: prs.map((p) => `${prLabel(p)} ${p.title} (${name(p)})`).join("\n"),
        };
  // Desktop apps need no permission; the plugin's command shows it.
  invoke("plugin:notification|notify", { options }).catch(() => {});
}

function remember(sources: Source[]) {
  const { fresh, mem } = newForReview(sources, loadMemory());
  saveMemory(mem);
  notify(fresh);
}

const inFlight = new Set<string>();

async function once(key: string, fn: () => Promise<void>) {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    await fn();
  } finally {
    inFlight.delete(key);
  }
}

/** List the repository's requests, and notify about new ones. */
export function loadPrs(repo: string) {
  const empty: RepoPrs = { items: [], problems: [], covered: false, projects: [] };
  const patch = (p: Partial<RepoPrs>) =>
    usePrs.setState((s) => ({ byRepo: { ...s.byRepo, [repo]: { ...(s.byRepo[repo] ?? empty), ...p } } }));
  return once(repo, async () => {
    patch({ loading: true });
    try {
      const res = await api.pullRequests(repo);
      patch({ ...res, error: undefined, loading: false });
      remember(repoSources(res));
    } catch (e) {
      patch({ error: errorText(e), loading: false });
    }
  });
}

/** List the requests involving the user on every account. */
export function loadInbox() {
  const empty: InboxPrs = { items: [], problems: [], accounts: [] };
  const patch = (p: Partial<InboxPrs>) => usePrs.setState((s) => ({ inbox: { ...(s.inbox ?? empty), ...p } }));
  return once("\0inbox", async () => {
    patch({ loading: true });
    try {
      const res = await api.pullRequestInbox();
      patch({ ...res, error: undefined, loading: false });
      remember(inboxSources(res));
    } catch (e) {
      patch({ error: errorText(e), loading: false });
    }
  });
}
