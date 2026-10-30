import { describe, expect, it } from "vitest";

import { PullRequest, PullRequestInbox, PullRequests, RefInfo } from "../../src/api";
import { inboxSources, Memory, newForReview, prLabel, repoSources, requestForBranch, wantsReview } from "../../src/prs";

const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  provider: "gitlab",
  remote: "origin",
  account: "acct",
  project: "gitlab.com/team/app",
  number,
  title: `MR ${number}`,
  author: "ada",
  sourceBranch: "feature",
  targetBranch: "main",
  sameRepo: true,
  url: "",
  draft: false,
  created: "",
  updated: "",
  mine: false,
  reviewRequested: false,
  assigned: false,
  canApprove: true,
  approvedByMe: false,
  approved: false,
  ...over,
});

const res = (items: PullRequest[], projects = ["gitlab.com/team/app"]): PullRequests => ({
  items,
  problems: [],
  covered: true,
  projects,
});

const empty: Memory = { seen: {}, notified: [] };
const check = (r: PullRequests, mem: Memory) => newForReview(repoSources(r), mem);

describe("newForReview", () => {
  it("only records what is open the first time a list is seen", () => {
    const { fresh, mem } = check(res([pr(1), pr(2)]), empty);
    expect(fresh).toEqual([]);
    expect(mem.seen).toEqual({ "gitlab.com/team/app": ["gitlab.com/team/app#1", "gitlab.com/team/app#2"] });
  });

  it("notifies once about a new request the user can approve", () => {
    let mem = check(res([]), empty).mem;
    expect(mem.seen).toEqual({ "gitlab.com/team/app": [] });
    const first = check(res([pr(3), pr(4, { mine: true }), pr(5, { canApprove: false })]), mem);
    expect(first.fresh.map((p) => p.number)).toEqual([3]);
    mem = first.mem;
    expect(check(res([pr(3)]), mem).fresh).toEqual([]);
  });

  it("waits for drafts to become ready", () => {
    let { mem } = check(res([]), empty);
    const draft = check(res([pr(6, { draft: true })]), mem);
    expect(draft.fresh).toEqual([]);
    mem = draft.mem;
    expect(check(res([pr(6)]), mem).fresh.map((p) => p.number)).toEqual([6]);
  });

  it("forgets closed requests and leaves unlisted lists alone", () => {
    const mem: Memory = { seen: { "gitlab.com/team/app": ["gitlab.com/team/app#1", "gitlab.com/team/app#2"], "inbox:x": ["a#9"] }, notified: [] };
    expect(check(res([pr(2)]), mem).mem.seen).toEqual({ "gitlab.com/team/app": ["gitlab.com/team/app#2"], "inbox:x": ["a#9"] });
    // A project that failed to list this time keeps its memory.
    expect(check(res([], []), mem).mem.seen).toEqual(mem.seen);
  });

  it("notifies once when both the project and the inbox see a request", () => {
    const inbox = (items: PullRequest[]): PullRequestInbox => ({ items, problems: [], accounts: ["acct"] });
    let mem = check(res([]), empty).mem;
    mem = newForReview(inboxSources(inbox([])), mem).mem;
    const mr = pr(8, { account: "acct" });
    const fromRepo = check(res([mr]), mem);
    expect(fromRepo.fresh).toHaveLength(1);
    const fromInbox = newForReview(inboxSources(inbox([mr])), fromRepo.mem);
    expect(fromInbox.fresh).toEqual([]);
    expect(fromInbox.mem.seen["inbox:acct"]).toEqual(["gitlab.com/team/app#8"]);
  });
});

describe("pull request labels", () => {
  it("use each service's notation", () => {
    expect(prLabel(pr(7))).toBe("!7");
    expect(prLabel(pr(7, { provider: "github" }))).toBe("#7");
    expect(wantsReview(pr(7, { approvedByMe: true }))).toBe(false);
  });
});

describe("the request of a branch", () => {
  const pr = (over: Partial<PullRequest> = {}) =>
    ({ provider: "gitlab", remote: "origin", number: 4, sourceBranch: "feature/ui", sameRepo: true, ...over }) as PullRequest;
  const ref = (name: string, kind: "local" | "remote", upstream: string | null = null) =>
    ({ name, kind, upstream, fullName: name, target: "x", isHead: false, ahead: 0, behind: 0 }) as RefInfo;

  it("matches the remote branch, a local one tracking it, or one of the same name", () => {
    expect(requestForBranch([pr()], null, [ref("origin/feature/ui", "remote")])?.number).toBe(4);
    expect(requestForBranch([pr()], ref("ui-work", "local", "origin/feature/ui"), [])?.number).toBe(4);
    expect(requestForBranch([pr()], ref("feature/ui", "local"), [])?.number).toBe(4);
    // Same name, tracking something else: another branch.
    expect(requestForBranch([pr()], ref("feature/ui", "local", "upstream/feature/ui"), [])).toBeUndefined();
    expect(requestForBranch([pr()], null, [ref("upstream/feature/ui", "remote")])).toBeUndefined();
  });

  it("matches a fork's request by its checked-out branch", () => {
    const fork = pr({ sameRepo: false, number: 7 });
    expect(requestForBranch([fork], ref("mr/7", "local"), [])?.number).toBe(7);
    expect(requestForBranch([fork], ref("feature/ui", "local"), [])).toBeUndefined();
    expect(requestForBranch([pr({ provider: "github", sameRepo: false, number: 7 })], ref("pr/7", "local"), [])?.number).toBe(7);
  });
});
