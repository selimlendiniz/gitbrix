// Issues: listed in the sidebar, shown in a window, a branch started for
// one, and "Closes #N" offered on that branch.

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

const issue = (number: number, over: Record<string, unknown> = {}) => ({
  provider: "gitlab",
  remote: "origin",
  project: "gitlab.com/team/demo-app",
  number,
  title: `Issue ${number}`,
  body: "",
  author: "ada",
  url: `https://gitlab.com/team/demo-app/-/issues/${number}`,
  labels: [],
  assignees: [],
  assignedToMe: false,
  mine: false,
  comments: 0,
  created: "2026-10-20T10:00:00Z",
  updated: "2026-10-20T10:00:00Z",
  ...over,
});

const ISSUES = {
  items: [
    issue(4, { title: "Tidy the docs", updated: "2026-10-29T10:00:00Z" }),
    issue(12, {
      title: "Login fails on Safari",
      body: "Steps:\n1. Open login\n2. Nothing happens",
      labels: [{ name: "bug", color: "#d73a4a" }],
      assignees: ["me"],
      assignedToMe: true,
      comments: 2,
    }),
  ],
  problems: [],
  covered: true,
  projects: ["gitlab.com/team/demo-app"],
};

test("issues: listed, shown, and a branch started from origin/main", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript((issues) => {
    window.__gitbrixIssues = issues;
  }, ISSUES);
  await page.goto("/?open");
  const section = page.locator(".side-section", { has: page.locator(".side-title-text", { hasText: "Issues" }) });
  const rows = section.locator(".issue-item");
  await expect(rows).toHaveCount(2);
  // Assigned to the user first.
  await expect(rows.first()).toContainText("#12");
  await expect(rows.first().locator(".pr-badge")).toHaveText("you");

  await section.getByRole("button", { name: "mine" }).click();
  await expect(rows).toHaveCount(1);
  await section.getByRole("button", { name: "mine" }).click();

  await rows.first().click();
  const dialog = page.getByRole("dialog", { name: "Issue #12" });
  await expect(dialog).toContainText("Login fails on Safari");
  await expect(dialog.locator(".issue-body")).toContainText("Nothing happens");
  await expect(dialog.locator(".issue-label")).toHaveText("bug");
  await expect(dialog).toContainText("Assigned to me");
  await page.screenshot({ path: "test-results/shots/issue.png" });

  await dialog.getByRole("button", { name: "Open in browser" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://gitlab.com/team/demo-app/-/issues/12" });

  await dialog.getByRole("button", { name: "Start work on a branch…" }).click();
  const prompt = page.getByRole("dialog", { name: "Start work on #12" });
  await expect(prompt).toContainText("New branch from origin/main");
  await expect(prompt.locator("input")).toHaveValue("12-login-fails-on-safari");
  await prompt.getByRole("button", { name: "Create and check out" }).click();
  // From origin/main's commit, so the branch doesn't track main.
  await expect
    .poll(() => lastCall(page, "create_branch"))
    .toMatchObject({ name: "12-login-fails-on-safari", start: "2fbac1a8bf4dac4609c24739c70e8d2bfdc2a021", checkout: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("issues: on an issue's branch the commit form offers Closes #N", async ({ page }) => {
  await page.addInitScript((issues) => {
    window.__gitbrixIssues = issues;
    window.__gitbrixHead = "feature/12-login-fails-on-safari";
  }, ISSUES);
  await page.goto("/?open");
  await expect(page.locator(".issue-item", { hasText: "#12" }).locator(".pr-badge.ok")).toHaveText("here");
  await page.locator(".graph-row.wip").click();
  const hint = page.getByRole("button", { name: "+ Closes #12" });
  await expect(hint).toBeVisible();
  await page.locator(".commit-body-input").fill("Safari drops the cookie");
  await hint.click();
  await expect(page.locator(".commit-body-input")).toHaveValue("Safari drops the cookie\n\nCloses #12");
  await expect(hint).toHaveCount(0);
});

test("issues: nothing shown where no account covers the remotes", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".side-title-text", { hasText: "Pull Requests" })).toHaveCount(0);
  await expect(page.locator(".side-title-text", { hasText: "Issues" })).toHaveCount(0);
});
