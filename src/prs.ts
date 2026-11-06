// Pull/merge requests: the open repositories' (sidebar) and, across all
// accounts, the ones involving the user (the Pull Requests window). Both
// are checked in the background; a new request the user may approve
// raises one desktop notification, whichever list sees it first. What was
// open the first time a list is seen doesn't.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { api, Conversation, errorText, PullRequest, PullRequestInbox, PullRequests, RefInfo, RequestRange } from "./api";
import { begin, end } from "./activity";
import { fileName } from "./format";
import { useSettings } from "./settings";
import { useStore } from "./store";
import { isMainWindow } from "./windows";

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
  /** Per request (account-wide list): comments counted at the last look… */
  comments?: Record<string, number>;
  /** …and when that was (ISO), to tell new comments from old. */
  checked?: Record<string, string>;
  /** Requests the user was already told they're mentioned in. */
  mentions?: string[];
}

/** A list of requests checked as one: a project's, or an account's inbox. */
export interface Source {
  key: string;
  items: PullRequest[];
}

function loadMemory(): Memory {
  try {
    const raw = JSON.parse(localStorage.getItem(MEMORY) ?? "{}");
    return {
      seen: raw?.seen ?? {},
      notified: Array.isArray(raw?.notified) ? raw.notified : [],
      // Absent until the first look at comments, which only records.
      comments: raw?.comments,
      checked: raw?.checked,
      mentions: Array.isArray(raw?.mentions) ? raw.mentions : undefined,
    };
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
  return { fresh, mem: { ...mem, seen, notified: [...notified].slice(-500) } };
}

function notify(prs: PullRequest[]) {
  if (!prs.length || !useSettings.getState().prNotify) return;
  show(prs);
}

/** A notification about the newest listed request (or a made-up one), to see what they look like. */
export function testNotification() {
  const s = usePrs.getState();
  const latest = [...(s.inbox?.items ?? []), ...Object.values(s.byRepo).flatMap((r) => r.items)].sort((a, b) =>
    b.created.localeCompare(a.created),
  )[0];
  show([
    latest ?? {
      provider: "gitlab",
      remote: "",
      account: "",
      project: "gitlab.com/example/app",
      number: 1,
      title: "Example merge request",
      author: "someone",
      sourceBranch: "feature",
      targetBranch: "main",
      sameRepo: true,
      url: "",
      draft: false,
      created: "",
      updated: "",
      mine: false,
      reviewRequested: true,
      assigned: false,
      canApprove: true,
      approvedByMe: false,
      approved: false,
    },
  ]);
}

function show(prs: PullRequest[]) {
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

/**
 * What changed in the account-wide list since the last look: requests with
 * more comments (to read), and ones the user is newly mentioned in. The
 * first look only records. Requests gone from the list are forgotten.
 */
export function commentNews(items: PullRequest[], mem: Memory, now: string): { more: PullRequest[]; mentioned: PullRequest[]; since: Record<string, string>; mem: Memory } {
  const counts = mem.comments ?? {};
  const checked = mem.checked ?? {};
  const known = new Set(mem.mentions ?? []);
  const first = !mem.comments;
  const more: PullRequest[] = [];
  const mentioned: PullRequest[] = [];
  const since: Record<string, string> = {};
  const nextCounts: Record<string, number> = {};
  const nextChecked: Record<string, string> = {};
  for (const pr of items) {
    const key = prKey(pr);
    const n = pr.comments ?? 0;
    nextCounts[key] = n;
    nextChecked[key] = now;
    if (!first && key in counts && n > counts[key]) {
      more.push(pr);
      since[key] = checked[key] ?? now;
    }
    if (pr.mentioned && !known.has(key) && !first) mentioned.push(pr);
  }
  const mentions = items.filter((p) => p.mentioned).map(prKey);
  return { more, mentioned, since, mem: { ...mem, comments: nextCounts, checked: nextChecked, mentions } };
}

/** The user's name on the request's account (`provider|url|name`). */
function me(pr: PullRequest): string {
  return pr.account.split("|").pop() ?? "";
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0];
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/** Read the conversations that grew and tell about other people's new
 * comments; then about mentions not covered by those. */
async function tellComments(more: PullRequest[], mentioned: PullRequest[], since: Record<string, string>) {
  const told = new Set<string>();
  for (const pr of more) {
    try {
      const conv = await api.pullRequestConversationFor(pr.account, pr.project, pr.number);
      const fresh = conv.comments.filter((c) => !c.system && c.author !== me(pr) && c.created > (since[prKey(pr)] ?? ""));
      if (!fresh.length) continue;
      told.add(prKey(pr));
      const at = new RegExp(`@${me(pr).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "i");
      const mention = fresh.find((c) => at.test(c.body));
      const name = pr.project.split("/").pop();
      const title =
        mention
          ? `${mention.author} mentioned you on ${prLabel(pr)} ${pr.title}`
          : fresh.length === 1
            ? `${fresh[0].author} commented on ${prLabel(pr)} ${pr.title}`
            : `${fresh.length} new comments on ${prLabel(pr)} ${pr.title}`;
      const body = mention ? firstLine(mention.body) : fresh.length === 1 ? firstLine(fresh[0].body) : [...new Set(fresh.map((c) => c.author))].join(", ");
      invoke("plugin:notification|notify", { options: { title, body: `${body} · ${name}` } }).catch(() => {});
    } catch {
      // Not now: the next check sees the same comments as new.
    }
  }
  for (const pr of mentioned) {
    if (told.has(prKey(pr))) continue;
    invoke("plugin:notification|notify", {
      options: { title: `You were mentioned on ${prLabel(pr)} ${pr.title}`, body: `${pr.author} · ${pr.project.split("/").pop()}` },
    }).catch(() => {});
  }
}

function rememberComments(items: PullRequest[]) {
  if (!isMainWindow) return;
  const { more, mentioned, since, mem } = commentNews(items, loadMemory(), new Date().toISOString());
  saveMemory(mem);
  if (useSettings.getState().commentNotify) void tellComments(more, mentioned, since);
}

function remember(sources: Source[]) {
  // One window keeps the memory and notifies, so a request isn't
  // announced once per window.
  if (!isMainWindow) return;
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
    const task = begin(`Checking pull requests of ${fileName(repo)}`);
    try {
      const res = await api.pullRequests(repo);
      patch({ ...res, error: undefined, loading: false });
      remember(repoSources(res));
      end(task);
    } catch (e) {
      patch({ error: errorText(e), loading: false });
      end(task, errorText(e));
    }
  });
}

/** List the requests involving the user on every account. */
export function loadInbox() {
  const empty: InboxPrs = { items: [], problems: [], accounts: [] };
  const patch = (p: Partial<InboxPrs>) => usePrs.setState((s) => ({ inbox: { ...(s.inbox ?? empty), ...p } }));
  return once("\0inbox", async () => {
    patch({ loading: true });
    const task = begin("Checking your pull requests");
    try {
      const res = await api.pullRequestInbox();
      patch({ ...res, error: undefined, loading: false });
      remember(inboxSources(res));
      rememberComments(res.items);
      end(task);
    } catch (e) {
      patch({ error: errorText(e), loading: false });
      end(task, errorText(e));
    }
  });
}

/** The "create pull request" form, open for a local branch. */
export const useCreatePr = create<{ branch: string | null }>(() => ({ branch: null }));

/** Open the form for a local branch (the checked-out one by default). */
export function createPullRequest(branch?: string) {
  const s = useStore.getState();
  const name = branch ?? s.repo?.headBranch;
  if (!name) {
    s.toast("error", "Check out a branch first");
    return;
  }
  useCreatePr.setState({ branch: name });
}

/** The request shown in the details panel, reviewed in the app, with its
 * commit range and conversation once loaded (the diff view comments on
 * lines through them). */
export const usePrView = create<{ pr: PullRequest | null; range: RequestRange | null; conv: Conversation | null }>(() => ({
  pr: null,
  range: null,
  conv: null,
}));

// Picking a commit, comparing or switching repositories leaves the request.
useStore.subscribe((st, prev) => {
  if (st.selectedId !== prev.selectedId || st.compareId !== prev.compareId || st.repo?.path !== prev.repo?.path) {
    if (usePrView.getState().pr) usePrView.setState({ pr: null, range: null, conv: null });
  }
});

/** Show a request of the open repository in the details panel, with its
 * branch selected in the graph when it is there. */
export function openPullRequest(pr: PullRequest) {
  const st = useStore.getState();
  const head = pr.sameRepo
    ? st.graph?.refs.find((r) => r.kind === "remote" && r.name === `${pr.remote}/${pr.sourceBranch}`)
    : undefined;
  if (head) st.select(head.target, true);
  usePrView.setState({ pr, range: null, conv: null });
}

/**
 * After a request was merged on the service: fetch, leave its branch for
 * the target (pulled up to date), and delete the local copy of its branch
 * when nothing on it is missing from the remote one.
 */
export async function tidyAfterMerge(pr: PullRequest) {
  const st = useStore.getState();
  const repo = st.repo;
  const refs = st.graph?.refs ?? [];
  const local = refs.find((r) => r.kind === "local" && r.name === pr.sourceBranch);
  if (!repo || !local) return;
  const remote = refs.find((r) => r.kind === "remote" && r.name === `${pr.remote}/${pr.sourceBranch}`);
  // Decided before fetching, which prunes the remote branch.
  const pushed = remote?.target === local.target || (local.upstream === `${pr.remote}/${pr.sourceBranch}` && local.ahead === 0);
  const onIt = repo.headBranch === pr.sourceBranch;
  const target = pr.targetBranch;
  const hasTarget = refs.some((r) => r.kind === "local" && r.name === target);
  await st.run(
    `Tidying up after ${prLabel(pr)}`,
    async (r) => {
      await api.fetch(r);
      if (onIt) {
        if (hasTarget) await api.checkoutBranch(r, target);
        else await api.checkoutRemote(r, `${pr.remote}/${target}`, target);
        await api.pull(r, "ff-only");
      }
      if (pushed) await api.deleteBranch(r, pr.sourceBranch, true);
    },
    pushed
      ? `${onIt ? `On ${target}, up to date; ` : ""}deleted the local ${pr.sourceBranch}`
      : `${onIt ? `On ${target}, up to date; ` : ""}kept ${pr.sourceBranch}: it has commits that aren't on ${pr.remote}`,
  );
}

/**
 * The open request a branch is the source of: its remote branch, a local
 * branch of that name or tracking it, or a fork's request checked out as
 * `pr/N` / `mr/N`.
 */
export function requestForBranch(prs: PullRequest[], local: RefInfo | null, remotes: RefInfo[]): PullRequest | undefined {
  return prs.find((pr) => {
    const remote = `${pr.remote}/${pr.sourceBranch}`;
    if (!pr.sameRepo) return local?.name === `${pr.provider === "github" ? "pr" : "mr"}/${pr.number}`;
    if (remotes.some((r) => r.name === remote)) return true;
    if (!local) return false;
    return local.upstream ? local.upstream === remote : local.name === pr.sourceBranch;
  });
}
