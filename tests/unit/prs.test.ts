import { describe, expect, it } from "vitest";

import { PullRequest, PullRequests } from "../../src/api";
import { newForReview, prLabel, wantsReview } from "../../src/prs";

const pr = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  provider: "gitlab",
  remote: "origin",
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

describe("newForReview", () => {
  it("only records what is open the first time a project is seen", () => {
    const { fresh, seen } = newForReview(res([pr(1), pr(2)]), {});
    expect(fresh).toEqual([]);
    expect(seen).toEqual({ "gitlab.com/team/app": [1, 2] });
  });

  it("notifies once about a new request the user can approve", () => {
    let seen = newForReview(res([]), {}).seen;
    expect(seen).toEqual({ "gitlab.com/team/app": [] });
    const first = newForReview(res([pr(3), pr(4, { mine: true }), pr(5, { canApprove: false })]), seen);
    expect(first.fresh.map((p) => p.number)).toEqual([3]);
    seen = first.seen;
    expect(newForReview(res([pr(3)]), seen).fresh).toEqual([]);
  });

  it("waits for drafts to become ready", () => {
    let { seen } = newForReview(res([]), {});
    const draft = newForReview(res([pr(6, { draft: true })]), seen);
    expect(draft.fresh).toEqual([]);
    seen = draft.seen;
    expect(newForReview(res([pr(6)]), seen).fresh.map((p) => p.number)).toEqual([6]);
  });

  it("forgets closed requests and leaves unlisted projects alone", () => {
    const seen = { "gitlab.com/team/app": [1, 2], "github.com/o/r": [9] };
    const next = newForReview(res([pr(2)]), seen).seen;
    expect(next).toEqual({ "gitlab.com/team/app": [2], "github.com/o/r": [9] });
    // A project that failed to list this time keeps its memory.
    expect(newForReview(res([], []), seen).seen).toEqual(seen);
  });
});

describe("pull request labels", () => {
  it("use each service's notation", () => {
    expect(prLabel(pr(7))).toBe("!7");
    expect(prLabel(pr(7, { provider: "github" }))).toBe("#7");
    expect(wantsReview(pr(7, { approvedByMe: true }))).toBe(false);
  });
});
