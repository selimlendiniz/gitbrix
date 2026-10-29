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

test("selecting a stash shows its changes and actions", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".side-item", { hasText: "half-written docs" }).click();
  await expect(page.locator(".stash-kicker")).toBeVisible();
  await expect(page.locator(".commit-panel .file-row", { hasText: "guide.md" })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/stash.png" });
  await page.getByRole("button", { name: "Pop" }).first().click();
  const cmds = await page.evaluate(() => window.__gitbrixCalls.map((c) => c.cmd));
  expect(cmds).toContain("stash_apply");
});

test("diffs are syntax highlighted with intra-line marks", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Wire parser into main").click();
  await page.locator(".commit-panel .file-row", { hasText: "main.rs" }).click();
  await expect(page.locator(".diff-table .hl-comment").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shots/diff-highlighted.png" });
});

test("tabs: new tab shows the welcome screen, closing returns", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".tab")).toHaveText(["demo-app"]);
  await page.getByTitle("Open another repository").click();
  await expect(page.getByRole("button", { name: /Open repository/ })).toBeVisible();
  await page.locator(".tab").click();
  await expect(page.locator(".repo-name")).toHaveText("demo-app");
  await page.locator(".tab").getByTitle("Close tab").click();
  await expect(page.locator(".tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Open repository/ })).toBeVisible();
});

test("command palette checks out a branch", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".graph-row").first().waitFor();
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Type a command/).fill("checkout fixtypo");
  await expect(page.locator(".palette-item.active")).toContainText("fix/typo");
  await page.screenshot({ path: "test-results/shots/palette.png" });
  await page.keyboard.press("Enter");
  await expect(page.locator(".palette")).toBeHidden();
  const call = await page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "checkout_branch")?.args);
  expect(call).toMatchObject({ name: "fix/typo" });
});

test("settings: light theme and absolute dates", async ({ page }) => {
  await page.goto("/?open");
  await page.getByTitle("Settings").click();
  await page.getByRole("button", { name: "Light" }).click();
  await page.getByRole("button", { name: /Oct 26, 14:05/ }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".graph-row .date").nth(1)).toContainText(":");
  await page.screenshot({ path: "test-results/shots/light.png" });
  // Persisted for the next start.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("remote and branch menus offer remote operations", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".side-item.group", { hasText: "origin" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Fetch origin" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Fetch origin" }).click();
  await page.locator(".side-item:not(.folder)", { hasText: /^parser$/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Push to origin" }).click();
  const calls = await page.evaluate(() => window.__gitbrixCalls.map((c) => [c.cmd, c.args]));
  expect(calls).toContainEqual(["fetch_remote", expect.objectContaining({ remote: "origin" })]);
  expect(calls).toContainEqual(["push_branch", expect.objectContaining({ remote: "origin", branch: "feature/parser" })]);
});

test("ctrl+click compares two commits", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Add Cargo manifest").click();
  await page.getByText("Wire parser into main").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("compare")).toBeVisible();
  await expect(page.locator(".graph-row.compared")).toContainText("Wire parser into main");
  await page.locator("[data-testid=compare] .file-row").first().click();
  await expect(page.locator(".diff-where")).toContainText("→");
  await page.screenshot({ path: "test-results/shots/compare.png" });
  await page.getByRole("button", { name: "Stop comparing" }).click();
  await expect(page.getByTestId("compare")).toBeHidden();
});

test("untracked file menu offers ignore patterns", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".wip-panel .file-row", { hasText: "notes.txt" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Ignore *.txt" }).click();
  const call = await page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "ignore")?.args);
  expect(call).toMatchObject({ pattern: "*.txt" });
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("dragging a branch onto HEAD offers merge and rebase", async ({ page }) => {
  await page.goto("/?open");
  const source = page.locator(".pill", { hasText: /^feature\/ui/ });
  const target = page.locator(".pill.head");
  await source.dragTo(target);
  await expect(page.getByRole("menuitem", { name: "Merge feature/ui into main" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rebase main onto feature/ui" })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/drag-drop.png" });
});

test("commit panel lists refs; double-click stages a file", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/?open");
  await page.getByText("Tidy up main").click();
  await expect(page.locator(".ref-chip.head")).toHaveText("main");
  await page.locator(".graph-row.wip").click();
  await page.locator(".wip-panel .file-row", { hasText: "notes.txt" }).dblclick();
  const call = await page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "stage")?.args);
  expect(call).toMatchObject({ paths: ["notes.txt"] });
  expect(errors).toEqual([]);
});

test("hiding a branch sends a graph filter and shows a banner", async ({ page }) => {
  await page.goto("/?open");
  const item = page.locator(".side-item:not(.folder)", { hasText: /^typo$/ });
  await item.hover();
  await item.getByTitle("Hide in graph").click();
  await expect(page.locator(".filter-banner")).toContainText("1 branch hidden");
  const graphCalls = await page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "get_graph").map((c) => c.args));
  expect(graphCalls[graphCalls.length - 1]).toMatchObject({ filter: { hidden: ["refs/heads/fix/typo"], solo: [] } });
  await page.screenshot({ path: "test-results/shots/hidden-branch.png" });
  await page.locator(".filter-banner").getByRole("button", { name: "Show all" }).click();
  await expect(page.locator(".filter-banner")).toBeHidden();
});

test("branch name in the toolbar opens a branch switcher", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".branch-name").click();
  await page.getByRole("menuitem", { name: "feature/ui" }).click();
  const call = await page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "checkout_branch")?.args);
  expect(call).toMatchObject({ name: "feature/ui" });
});

test("file lists switch to a tree", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".wip-panel").getByTitle("Show as tree").click();
  await expect(page.locator(".wip-panel .dir-row", { hasText: "src" })).toBeVisible();
  await page.locator(".wip-panel .dir-row", { hasText: "src" }).click();
  await expect(page.locator(".wip-panel .file-row", { hasText: "main.rs" })).toBeHidden();
  await page.screenshot({ path: "test-results/shots/file-tree.png" });
});

test("search by file path across history", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".graph-row").first().waitFor();
  await page.keyboard.press("Control+f");
  await page.locator(".search-mode").getByRole("button", { name: "Files" }).click();
  await page.getByPlaceholder(/File path contains/).fill("parser.rs");
  await expect(page.locator(".search-count")).toHaveText(/of [1-9]/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".graph-row.selected")).toContainText(/[Pp]arser/);
});
