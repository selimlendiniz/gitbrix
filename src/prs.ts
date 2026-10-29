// Pull/merge requests of the open repositories, checked in the background.
// A new request the user may approve raises a desktop notification; what
// was already open the first time a project is seen doesn't.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { api, errorText, PullRequest, PullRequests } from "./api";
import { useSettings } from "./settings";

export interface RepoPrs extends PullRequests {
  error?: string;
  loading?: boolean;
}

export const usePrs = create<{ byRepo: Record<string, RepoPrs> }>(() => ({ byRepo: {} }));

const NOTIFIED = "gitbrix.prs.notified";

/** Per project, the request numbers already seen or notified about. */
type Seen = Record<string, number[]>;

function loadSeen(): Seen {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIFIED) ?? "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveSeen(seen: Seen) {
  try {
    localStorage.setItem(NOTIFIED, JSON.stringify(seen));
  } catch {
    // ignore
  }
}

export function prLabel(pr: PullRequest): string {
  return pr.provider === "gitlab" ? `!${pr.number}` : `#${pr.number}`;
}

/** Someone else's request, ready for review, that the user may approve. */
export function wantsReview(pr: PullRequest): boolean {
  return pr.canApprove && !pr.mine && !pr.draft && !pr.approvedByMe;
}

/**
 * The requests to notify about, and what to remember. The first look at a
 * project only records what is open; after that a request is news once it
 * wants the user's review (a draft becoming ready counts).
 */
export function newForReview(res: PullRequests, seen: Seen): { fresh: PullRequest[]; seen: Seen } {
  const next = { ...seen };
  const fresh: PullRequest[] = [];
  for (const project of res.projects) {
    const items = res.items.filter((p) => p.project === project);
    const known = seen[project];
    if (!known) {
      next[project] = items.map((p) => p.number);
      continue;
    }
    const added = items.filter((p) => wantsReview(p) && !known.includes(p.number));
    fresh.push(...added);
    // Only open ones are kept, so the list doesn't grow forever.
    const open = new Set(items.map((p) => p.number));
    next[project] = [...known.filter((n) => open.has(n)), ...added.map((p) => p.number)];
  }
  return { fresh, seen: next };
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

const inFlight = new Set<string>();

/** List the repository's requests, and notify about new ones. */
export async function loadPrs(repo: string) {
  if (inFlight.has(repo)) return;
  inFlight.add(repo);
  const empty: RepoPrs = { items: [], problems: [], covered: false, projects: [] };
  const patch = (p: Partial<RepoPrs>) =>
    usePrs.setState((s) => ({ byRepo: { ...s.byRepo, [repo]: { ...(s.byRepo[repo] ?? empty), ...p } } }));
  patch({ loading: true });
  try {
    const res = await api.pullRequests(repo);
    patch({ ...res, error: undefined, loading: false });
    const { fresh, seen } = newForReview(res, loadSeen());
    saveSeen(seen);
    notify(fresh);
  } catch (e) {
    patch({ error: errorText(e), loading: false });
  } finally {
    inFlight.delete(repo);
  }
}
