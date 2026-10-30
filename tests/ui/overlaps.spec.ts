// Branches that clash with the work here: the toolbar's warning, its
// list, and the marks on changed files.

import { expect, test } from "@playwright/test";

const OVERLAPS = [
  {
    branch: "origin/feature/ui",
    target: "269db4a11d13e8ce8d4878a75b0d5e03f052c742",
    conflicts: ["src/main.rs"],
    edited: [],
    author: "Grace Hopper",
    time: 1767600000,
  },
  {
    branch: "origin/docs",
    target: "2fbac1a8bf4dac4609c24739c70e8d2bfdc2a021",
    conflicts: [],
    edited: ["notes.txt"],
    author: "Ada Lovelace",
    time: 1767500000,
  },
];

test("clashing branches: warning, list, marks on files", async ({ page }) => {
  await page.addInitScript(
    ([overlaps, pr]) => {
      window.__gitbrixOverlaps = overlaps;
      window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
    },
    [
      OVERLAPS,
      {
        provider: "gitlab",
        remote: "origin",
        account: "a",
        project: "gitlab.com/team/demo-app",
        number: 4,
        title: "New toolbar",
        author: "grace",
        sourceBranch: "feature/ui",
        targetBranch: "main",
        sameRepo: true,
        url: "u",
        draft: false,
        created: "",
        updated: "",
        mine: false,
        reviewRequested: false,
        assigned: false,
        canApprove: false,
        approvedByMe: false,
        approved: false,
      },
    ] as const,
  );
  await page.goto("/?open");
  const button = page.getByRole("button", { name: "Clashing branches" });
  await expect(button).toHaveText("Conflicts with 1 branch");
  await expect(button).toHaveClass(/conflict/);

  // The changed files they touch.
  const notes = page.locator(".wip-panel .file-row", { hasText: "notes.txt" }).locator(".clash-mark");
  await expect(notes).toHaveAttribute("title", "Also changed on origin/docs");
  await expect(notes).not.toHaveClass(/conflict/);
  await expect(page.locator(".wip-panel .file-row", { hasText: "main.rs" }).locator(".clash-mark.conflict")).toHaveAttribute(
    "title",
    "Would conflict with origin/feature/ui",
  );

  await button.click();
  const pop = page.getByRole("dialog", { name: "Clashing branches" });
  const first = pop.locator(".overlap-row").first();
  await expect(first).toContainText("origin/feature/ui");
  // Its pull request.
  await expect(first.locator(".pr-number")).toHaveText("!4");
  await expect(first.locator(".overlap-files.conflict")).toContainText("src/main.rs");
  await expect(pop.locator(".overlap-row").nth(1).locator(".overlap-files.edited")).toContainText("notes.txt");
  await page.screenshot({ path: "test-results/shots/overlaps.png" });
  await first.click();
  await expect(pop).toHaveCount(0);
  await expect(page.locator(".graph-row.selected")).toContainText("UI: layout pass");
});

test("clashing branches: nothing shown without any", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".toolbar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clashing branches" })).toHaveCount(0);
  await expect(page.locator(".clash-mark")).toHaveCount(0);
});
