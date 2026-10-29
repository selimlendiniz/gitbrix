import { describe, expect, it } from "vitest";

import { PullRequest, PullRequestInbox, PullRequests } from "../../src/api";
import { inboxSources, Memory, newForReview, prLabel, repoSources, wantsReview } from "../../src/prs";

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
