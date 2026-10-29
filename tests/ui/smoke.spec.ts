import { expect, Page, test } from "@playwright/test";

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
}

async function calls(page: Page) {
  return page.evaluate(() => window.__gitbrixCalls.map((c) => c.cmd));
}

test("opens the fixture repo and shows the graph", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await expect(page.locator(".repo-name")).toHaveText("demo-app");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  // WIP row first, selected, with the staging panel open.
  await expect(page.locator(".graph-row").first()).toHaveClass(/wip/);
  await expect(page.getByText("Unstaged files (2)")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/graph.png" });
  expect(errors).toEqual([]);
});

test("selecting a commit shows details and a file diff", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await page.getByText("Merge branch 'feature/parser'").click();
  await expect(page.locator(".commit-summary")).toHaveText("Merge branch 'feature/parser'");
  await page.locator(".file-row", { hasText: "parser.rs" }).click();
  await expect(page.getByTestId("diff")).toBeVisible();
  await expect(page.locator(".dl.add").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shots/diff-unified.png" });
  await page.getByRole("button", { name: "Split" }).click();
  await expect(page.locator(".split-row").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shots/diff-split.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("graph")).toBeVisible();
  expect(errors).toEqual([]);
});

test("context menu and branch dialog", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Wire parser into main").click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/context-menu.png" });
  await page.getByRole("menuitem", { name: "Create branch here…" }).click();
  await page.getByRole("dialog").locator("input").first().fill("feature/new");
  await page.screenshot({ path: "test-results/shots/branch-dialog.png" });
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await calls(page)).toContain("create_branch");
});

test("staging and committing call the backend", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".file-row", { hasText: "notes.txt" }).hover();
  await page.locator(".file-row", { hasText: "notes.txt" }).getByTitle("Stage file").click();
  await page.getByPlaceholder("Summary (required)").fill("Add notes");
  await page.getByRole("button", { name: /Commit changes to 1 file/ }).click();
  const cmds = await calls(page);
  expect(cmds).toContain("stage");
  expect(cmds).toContain("commit");
});

test("selecting diff lines stages just those lines", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".wip-panel .file-row", { hasText: "main.rs" }).click();
  await expect(page.getByTestId("diff")).toBeVisible();
  await page.locator(".dl.add").first().click();
  await expect(page.getByRole("button", { name: "Stage 1 line" })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/line-staging.png" });
  await page.getByRole("button", { name: "Stage 1 line" }).click();
  const call = await page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "apply_patch")?.args);
  expect(call).toMatchObject({ target: "index", reverse: false, intentToAdd: null });
  expect(call!.patch as string).toContain("+// unstaged edit");
});
