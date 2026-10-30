// Changing an open request, closing it.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

const mr = {
  provider: "gitlab", remote: "origin", account: "a", project: "gitlab.com/team/demo-app", number: 5, title: "Dark theme",
  author: "me", sourceBranch: "feature/ui", targetBranch: "main", sameRepo: true,
  url: "https://gitlab.com/team/demo-app/-/merge_requests/5", draft: true, created: "", updated: "", mine: true,
  reviewRequested: false, assigned: false, canApprove: false, approvedByMe: false, approved: false,
};

test("edit a request: title, reviewers, labels, ready; then close it", async ({ page }) => {
  await page.addInitScript((pr) => {
    window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, mr);
  await page.goto("/?open");
  await page.locator(".pr-item", { hasText: "Dark theme" }).click();
  const panel = page.getByTestId("pull-request");
  await panel.getByRole("button", { name: "Edit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit request" });
  await expect(dialog.locator("input").first()).toHaveValue("Dark theme");
  await expect(dialog.getByLabel("grace")).toBeChecked();
  await expect(dialog.getByRole("button", { name: "ui" })).toHaveAttribute("aria-pressed", "true");
  await dialog.locator("input").first().fill("Dark theme everywhere");
  await dialog.getByLabel("grace").uncheck();
  await dialog.getByLabel("ada").check();
  await dialog.getByRole("button", { name: "bug" }).click();
  await dialog.getByLabel(/Draft/).uncheck();
  await page.screenshot({ path: "test-results/shots/edit-request.png" });
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => lastCall(page, "edit_pull_request")).toMatchObject({
    number: 5,
    edit: { title: "Dark theme everywhere", body: "Makes the UI darker.", draft: false, reviewers: ["ada"], labels: ["ui", "bug"] },
  });
  await expect(dialog).toHaveCount(0);
  await expect(panel.locator(".commit-summary")).toHaveText("Dark theme everywhere");

  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("dialog", { name: "Close !5?" }).getByRole("button", { name: "Close request" }).click();
  await expect.poll(() => lastCall(page, "set_pull_request_open")).toMatchObject({ number: 5, open: false });
  await expect(panel).toHaveCount(0);
});
