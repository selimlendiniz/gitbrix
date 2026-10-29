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

test("search highlights matching commits", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".graph-row").first().waitFor();
  await page.keyboard.press("Control+f");
  await page.getByPlaceholder("Search message, author or SHA").fill("parser");
  await expect(page.locator(".search-count")).toHaveText(/of 5/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".graph-row.selected")).toContainText(/parser/i);
  await page.screenshot({ path: "test-results/shots/search.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".graph-search")).toBeHidden();
});

test("file history and blame", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Wire parser into main").click();
  await page.locator(".commit-panel .file-row", { hasText: "main.rs" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "File history" }).click();
  await expect(page.getByTestId("history")).toBeVisible();
  await expect(page.locator(".history-item")).toHaveCount(3);
  await expect(page.locator(".dl.add").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shots/history.png" });
  await page.getByRole("button", { name: /Blame at/ }).click();
  await expect(page.getByTestId("blame")).toBeVisible();
  await expect(page.locator(".blame-line").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shots/blame.png" });
});

test("interactive rebase editor builds a plan", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Wire parser into main").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Interactive rebase from here/ }).click();
  const rows = page.locator(".rebase-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Start rebase" })).toBeDisabled();
  // Newest first: "Tidy up main" on top. Squash the older one → invalid.
  await rows.nth(1).getByRole("button", { name: "Squash" }).click();
  await expect(page.locator(".rebase-problems")).toBeVisible();
  await rows.nth(1).getByRole("button", { name: "Pick" }).click();
  await rows.nth(0).focus();
  await page.keyboard.press("f");
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".rebase-problems")).toBeVisible();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator(".rebase-problems")).toBeHidden();
  await page.screenshot({ path: "test-results/shots/rebase.png" });
  await page.getByRole("button", { name: "Start rebase" }).click();
  const call = await page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "interactive_rebase")?.args);
  const steps = (call as { steps: { action: string }[] }).steps.map((s) => s.action);
  expect(steps).toEqual(["pick", "fixup"]);
});
