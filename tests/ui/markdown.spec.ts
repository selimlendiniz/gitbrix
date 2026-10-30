// Request descriptions and comments are shown as Markdown: formatting,
// highlighted code, links to the browser, no raw HTML.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

const DESCRIPTION = [
  "## Why",
  "",
  "The UI is **too bright**, see [the issue](/team/demo-app/-/issues/12).",
  "",
  "- [x] dark theme",
  "- [ ] light theme",
  "",
  "```rust",
  "fn main() {}",
  "```",
  "",
  "![screenshot](/uploads/abc/shot.png)",
  "",
  '<img src="x" onerror="window.__pwned = true"> <b>raw</b>',
  "",
  "[bad](javascript:window.__pwned=true)",
].join("\n");

test("markdown: a request's description", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(
    ([pr, description]) => {
      window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
      window.__gitbrixDescription = description;
    },
    [
      {
        provider: "gitlab", remote: "origin", account: "a", project: "gitlab.com/team/demo-app", number: 5, title: "Dark theme",
        author: "ada", sourceBranch: "feature/ui", targetBranch: "main", sameRepo: true,
        url: "https://gitlab.com/team/demo-app/-/merge_requests/5", draft: false, created: "", updated: "", mine: false,
        reviewRequested: false, assigned: false, canApprove: false, approvedByMe: false, approved: false,
      },
      DESCRIPTION,
    ] as const,
  );
  await page.goto("/?open");
  await page.locator(".pr-item", { hasText: "Dark theme" }).click();
  const panel = page.getByTestId("pull-request");
  await panel.getByRole("button", { name: /Conversation/ }).click();
  const md = panel.locator(".pr-description");
  await expect(md.locator("h2")).toHaveText("Why");
  await expect(md.locator("strong")).toHaveText("too bright");
  await expect(md.locator("input[type=checkbox]")).toHaveCount(2);
  await expect(md.locator("input[type=checkbox]").first()).toBeChecked();
  // Highlighted.
  await expect(md.locator("pre .hl-keyword")).toHaveText("fn");
  // Raw HTML is left out, a javascript: link isn't one.
  await expect(md.locator("img")).toHaveCount(0);
  await expect(md.locator("b")).toHaveCount(0);
  await expect(md.locator("a", { hasText: "bad" })).toHaveCount(0);
  await expect(md.locator(".md-dead-link")).toHaveText("bad");
  await page.screenshot({ path: "test-results/shots/markdown.png" });

  // Links go to the browser, resolved against the project.
  await md.getByRole("link", { name: "the issue" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://gitlab.com/team/demo-app/-/issues/12" });
  await md.getByRole("link", { name: "[screenshot]" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://gitlab.com/team/demo-app/uploads/abc/shot.png" });
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();
  // Still in the app.
  await expect(panel).toBeVisible();
  expect(errors).toEqual([]);
});
