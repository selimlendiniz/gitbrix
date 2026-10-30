// Merging a request from the app: when checks pass, and tidying up the
// local branch afterwards.

import { expect, Page, test } from "@playwright/test";

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

async function calls(page: Page) {
  return page.evaluate(() => window.__gitbrixCalls.map((c) => c.cmd));
}

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
  mine: true,
  reviewRequested: false,
  assigned: false,
  canApprove: false,
  approvedByMe: false,
  approved: true,
  ...over,
});

async function openMerge(page: Page, title: string) {
  await page.locator(".pr-item", { hasText: title }).click();
  const panel = page.getByTestId("pull-request");
  await panel.getByRole("button", { name: "Merge…" }).click();
  return panel;
}

test("merge: while checks run, the service merges once they pass", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript((pr) => {
    window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, mr(5, { title: "Dark theme", ci: "running" }));
  await page.goto("/?open");
  const panel = await openMerge(page, "Dark theme");
  const auto = panel.getByLabel(/Merge when checks pass/);
  await expect(auto).toBeChecked();
  // Nothing to tidy until it's merged.
  await expect(panel.getByLabel(/delete the local feature\/ui/)).toHaveCount(0);
  await page.screenshot({ path: "test-results/shots/merge-when-checks-pass.png" });
  await panel.getByRole("button", { name: "Merge when checks pass" }).click();
  await expect.poll(() => lastCall(page, "merge_pull_request")).toMatchObject({ number: 5, whenChecksPass: true });
  await expect(page.getByText("!5 will be merged into main when its checks pass")).toBeVisible();
  expect(await calls(page)).not.toContain("fetch");

  // Unticked: merged now.
  await openMerge(page, "Dark theme");
  await page.getByTestId("pull-request").getByLabel(/Merge when checks pass/).uncheck();
  await page.getByTestId("pull-request").getByRole("button", { name: "Merge", exact: true }).click();
  await expect.poll(() => lastCall(page, "merge_pull_request")).toMatchObject({ whenChecksPass: false });
  expect(errors).toEqual([]);
});

test("merge: then switch to the target, pull, keep a branch with unpushed commits", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript((pr) => {
    window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
    // Working on the request's branch.
    window.__gitbrixHead = "feature/ui";
  }, mr(6, { title: "Toolbar" }));
  await page.goto("/?open");
  const panel = await openMerge(page, "Toolbar");
  const tidy = panel.getByLabel("Then switch to main, pull, and delete the local feature/ui");
  await expect(tidy).toBeChecked();
  await panel.getByRole("button", { name: "Merge", exact: true }).click();
  await expect.poll(() => calls(page)).toContain("pull");
  const cmds = await calls(page);
  const at = (c: string) => cmds.indexOf(c);
  expect(at("merge_pull_request")).toBeLessThan(at("fetch"));
  expect(at("fetch")).toBeLessThan(at("checkout_branch"));
  expect(at("checkout_branch")).toBeLessThan(at("pull"));
  expect(await lastCall(page, "checkout_branch")).toMatchObject({ name: "main" });
  expect(await lastCall(page, "pull")).toMatchObject({ mode: "ff-only" });
  // The local feature/ui is a commit ahead of origin: kept.
  expect(cmds).not.toContain("delete_branch");
  await expect(page.getByText("On main, up to date; kept feature/ui: it has commits that aren't on origin")).toBeVisible();
  expect(errors).toEqual([]);
});
