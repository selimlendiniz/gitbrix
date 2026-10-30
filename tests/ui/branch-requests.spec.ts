// Branches with an open pull/merge request carry its number, in the graph
// and in the sidebar; a click opens it for review.

import { expect, test } from "@playwright/test";

const mr = (number: number, over: Record<string, unknown> = {}) => ({
  provider: "gitlab",
  remote: "origin",
  account: "gitlab|https://gitlab.com|me",
  project: "gitlab.com/team/demo-app",
  number,
  title: `Merge request ${number}`,
  author: "ada",
  sourceBranch: "feature/ui",
  targetBranch: "main",
  sameRepo: true,
  url: `https://gitlab.com/team/demo-app/-/merge_requests/${number}`,
  draft: false,
  created: "2026-10-29T10:00:00Z",
  updated: "2026-10-29T10:00:00Z",
  mine: false,
  reviewRequested: true,
  assigned: false,
  canApprove: true,
  approvedByMe: false,
  approved: false,
  ...over,
});

test("branch requests: marked in the graph and the sidebar, opened by a click", async ({ page }) => {
  await page.addInitScript((pr) => {
    window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, mr(5, { title: "Dark theme" }));
  await page.goto("/?open");
  // The local branch and its remote branch (on different commits) both.
  const local = page.locator(".pill", { hasText: /^✓?\s*feature\/ui/ }).first();
  await expect(local.locator(".pr-mark")).toHaveText("!5");
  await expect(local.locator(".pr-mark")).toHaveClass(/review/);
  await expect(page.locator(".pill", { hasText: "origin/feature/ui" }).locator(".pr-mark")).toHaveText("!5");
  // Other branches: none.
  await expect(page.locator(".pill", { hasText: /^main/ }).locator(".pr-mark")).toHaveCount(0);
  await expect(page.locator(".side-item .pr-mark")).toHaveCount(2);
  await page.screenshot({ path: "test-results/shots/branch-requests.png" });

  await local.locator(".pr-mark").click();
  await expect(page.getByTestId("pull-request")).toContainText("Dark theme");
});

test("branch requests: a fork's request checked out as mr/N", async ({ page }) => {
  await page.addInitScript((pr) => {
    window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, mr(9, { sameRepo: false, sourceBranch: "fix/typo", approved: true, reviewRequested: false, canApprove: false }));
  await page.goto("/?open");
  // The fixture has no mr/9 branch, and fix/typo here isn't the fork's.
  await expect(page.locator(".graph-row").first()).toBeVisible();
  await expect(page.locator(".pr-mark")).toHaveCount(0);
});
