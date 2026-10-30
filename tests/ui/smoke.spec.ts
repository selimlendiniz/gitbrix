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
  // Repository tabs; the pinned Workspaces tab comes first and stays.
  const repoTab = page.locator(".tab:not(.pinned)");
  await expect(page.locator(".tab")).toHaveText(["Workspaces", "demo-app"]);
  await page.getByTitle("Open another repository").click();
  await expect(page.getByRole("button", { name: /Open repository/ })).toBeVisible();
  await repoTab.click();
  await expect(page.locator(".repo-name")).toHaveText("demo-app");
  await repoTab.getByTitle("Close tab").click();
  await expect(repoTab).toHaveCount(0);
  await expect(page.locator(".tab")).toHaveText(["Workspaces"]);
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

test("arrow keys move through files, space stages", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".wip-panel .file-row", { hasText: "notes.txt" }).click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".wip-panel .file-row.active")).toContainText("main.rs");
  await page.keyboard.press(" ");
  const call = await page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "stage").pop()?.args);
  expect(call).toMatchObject({ paths: ["src/main.rs"] });
});

test("code search keeps the query's case", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".graph-row").first().waitFor();
  await page.keyboard.press("Control+f");
  await page.locator(".search-mode").getByRole("button", { name: "Code" }).click();
  await page.getByPlaceholder(/Text added or removed/).fill("ParseConfig");
  await expect.poll(() => page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "search_history")?.args.query)).toBe("ParseConfig");
});

test("hovering a branch label dims commits not on it", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".pill", { hasText: /^feature\/ui/ }).hover();
  await expect(page.locator(".graph-row", { hasText: "UI: dark theme" })).not.toHaveClass(/dim/);
  await expect(page.locator(".graph-row", { hasText: "Experiment: fast path" })).toHaveClass(/dim/);
  await page.screenshot({ path: "test-results/shots/branch-hover.png" });
});

test("ignore whitespace and edit the last commit's message", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Wire parser into main").click();
  await page.locator(".commit-panel .file-row", { hasText: "main.rs" }).click();
  await page.getByLabel("Ignore whitespace").check();
  await expect
    .poll(() => page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "commit_file_diff").pop()?.args.ignoreWs))
    .toBe(true);
  await page.keyboard.press("Escape");
  await page.getByText("Tidy up main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit commit message…" }).click();
  await expect(page.getByRole("dialog").locator("input").first()).toHaveValue("Tidy up main");
  await page.getByRole("dialog").locator("input").first().fill("Tidy up main.rs");
  await page.getByRole("button", { name: "Save message" }).click();
  await expect.poll(() => page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "reword_head")?.args.message)).toBe("Tidy up main.rs\n");
});

test("settings: add a self-hosted GitLab account with a token", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await page.getByTitle("Settings").click();
  const accounts = page.getByTestId("accounts");
  await expect(accounts).toContainText("No accounts");
  await accounts.getByRole("button", { name: "Add account…" }).click();
  await accounts.getByRole("button", { name: "GitLab" }).click();
  const address = accounts.locator("input").first();
  await expect(address).toHaveValue("https://gitlab.com");
  await address.fill("https://git.example.com");
  await accounts.locator("input[type=password]").fill("glpat-secret");
  await accounts.getByRole("button", { name: "Add account" }).click();
  await expect(accounts.locator(".account-row")).toContainText("mock-user");
  await expect(accounts.locator(".account-row")).toContainText("git.example.com");
  await page.screenshot({ path: "test-results/shots/accounts.png" });
  const call = await page.evaluate(() => window.__gitbrixCalls.find((c) => c.cmd === "add_account")?.args);
  expect(call).toMatchObject({ provider: "gitlab", url: "https://git.example.com", token: "glpat-secret" });

  await accounts.getByRole("button", { name: "Remove" }).click();
  await expect(accounts).toContainText("No accounts");
  expect(errors).toEqual([]);
});

// --- drag and drop (mouse-driven, see src/dnd.ts) ---

async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 4, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

test("drag: a commit onto the checked-out branch cherry-picks it", async ({ page }) => {
  await page.goto("/?open");
  await drag(page, page.locator(".graph-row", { hasText: "Experiment: fast path" }).locator(".message"), page.locator(".pill.head"));
  await page.getByRole("menuitem", { name: /^Cherry-pick e5d281b onto main/ }).click();
  expect(await lastCall(page, "cherry_pick")).toMatchObject({ id: expect.stringMatching(/^e5d281b/) });
});

test("drag: a branch onto a commit moves it; the ghost follows the pointer", async ({ page }) => {
  await page.goto("/?open");
  const pill = page.locator(".pill", { hasText: /^fix\/typo/ });
  const row = page.locator(".graph-row", { hasText: "Write getting started guide" }).locator(".message");
  const a = (await pill.boundingBox())!;
  const b = (await row.boundingBox())!;
  await page.mouse.move(a.x + 5, a.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
  await expect(page.locator(".drag-ghost")).toHaveText("fix/typo");
  await expect(page.locator(".graph-row.drop-target")).toHaveCount(1);
  await page.screenshot({ path: "test-results/shots/drag-branch.png" });
  await page.mouse.up();
  await expect(page.locator(".drag-ghost")).toHaveCount(0);
  await page.getByRole("menuitem", { name: /^Move fix\/typo to 0f5fc92/ }).click();
  expect(await lastCall(page, "move_branch")).toMatchObject({ name: "fix/typo", target: expect.stringMatching(/^0f5fc92/) });
});

test("drag: a file between the unstaged and staged lists", async ({ page }) => {
  await page.goto("/?open");
  const staged = page.locator(".wip-section").nth(1);
  await drag(page, page.locator(".file-row", { hasText: "notes.txt" }), staged);
  expect(await lastCall(page, "stage")).toMatchObject({ paths: ["notes.txt"] });
  await drag(page, page.locator(".file-row", { hasText: "CHANGELOG.md" }), page.locator(".wip-section").first());
  expect(await lastCall(page, "unstage")).toMatchObject({ paths: ["CHANGELOG.md"] });
});

test("drag: a stash onto the WIP row; a branch onto a remote; two commits compare", async ({ page }) => {
  await page.goto("/?open");
  await drag(page, page.locator(".side-item", { hasText: "half-written docs" }), page.locator(".graph-row.wip"));
  await page.getByRole("menuitem", { name: /^Pop stash/ }).click();
  expect(await lastCall(page, "stash_apply")).toMatchObject({ pop: true });

  await drag(page, page.locator(".side-item", { hasText: /^parser$/ }), page.locator(".side-item.group", { hasText: "origin" }));
  await page.getByRole("menuitem", { name: "Push feature/parser to origin" }).click();
  expect(await lastCall(page, "push_branch")).toMatchObject({ remote: "origin", branch: "feature/parser" });

  await drag(
    page,
    page.locator(".graph-row", { hasText: "UI: dark theme" }).locator(".message"),
    page.locator(".graph-row", { hasText: "Start UI module" }).locator(".message"),
  );
  await expect(page.locator(".graph-row.compared")).toHaveCount(1);
});

test("drag: a click is still a click, and Escape cancels a drag", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".graph-row", { hasText: "UI: dark theme" }).click();
  await expect(page.locator(".commit-summary")).toHaveText("UI: dark theme");
  const pill = page.locator(".pill", { hasText: /^feature\/ui/ });
  const head = (await page.locator(".pill.head").boundingBox())!;
  const a = (await pill.boundingBox())!;
  await page.mouse.move(a.x + 5, a.y + 5);
  await page.mouse.down();
  await page.mouse.move(head.x + 5, head.y + 5, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator(".drag-ghost")).toHaveCount(0);
});

// --- pull / merge requests ---

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
  reviewRequested: false,
  assigned: false,
  canApprove: true,
  approvedByMe: false,
  approved: false,
  ...over,
});

test("pull requests: listed, new ones notify, approve and check out", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript((first) => {
    window.__gitbrixPrs = { items: [first], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, mr(1, { title: "Polish the toolbar" }));
  await page.goto("/?open");
  const item = (text: string) => page.locator(".pr-item", { hasText: text });
  await expect(item("Polish the toolbar")).toContainText("!1");
  // Open when first seen: no notification.
  expect(await calls(page)).not.toContain("plugin:notification|notify");

  // Clicking selects the source branch's commit.
  await item("Polish the toolbar").click();
  await expect(page.locator(".graph-row.selected")).toBeVisible();

  const fork = mr(2, { title: "Faster parser", sameRepo: false, reviewRequested: true });
  await page.evaluate((items) => {
    window.__gitbrixPrs = { items, problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, [fork, mr(1, { title: "Polish the toolbar" })]);
  await page.getByTitle("Check for requests").click();
  await expect(item("Faster parser")).toContainText("review");
  expect(await lastCall(page, "plugin:notification|notify")).toMatchObject({
    options: { title: "Review requested: !2 Faster parser", body: expect.stringContaining("ada") },
  });
  await page.screenshot({ path: "test-results/shots/pull-requests.png" });

  await item("Faster parser").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Approve…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => lastCall(page, "approve_pull_request")).toMatchObject({
    account: "gitlab|https://gitlab.com|me",
    project: "gitlab.com/team/demo-app",
    number: 2,
  });

  // A fork's request checks out through the service's ref, a same-repo one tracks its branch.
  await item("Faster parser").dblclick();
  await expect.poll(() => lastCall(page, "checkout_pull_request")).toMatchObject({ remote: "origin", number: 2 });
  await item("Polish the toolbar").dblclick();
  await expect.poll(() => lastCall(page, "checkout_remote")).toMatchObject({ remoteBranch: "origin/feature/ui", local: "feature/ui" });
  expect(errors).toEqual([]);
});

test("pull requests: hidden without an account, problems shown", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  await expect(page.locator(".side-title", { hasText: "Pull Requests" })).toHaveCount(0);
  await page.addInitScript(() => {
    window.__gitbrixPrs = { items: [], problems: ["origin: add a github.com account in Settings to see its requests"], covered: false, projects: [] };
  });
  await page.goto("/?open");
  await expect(page.locator(".side-note.error")).toContainText("add a github.com account");
});

test("pull requests window: only the open repository's requests, by involvement", async ({ page }) => {
  const errors = trackErrors(page);
  const here = [
    mr(11, { title: "Review me", reviewRequested: true }),
    mr(12, { title: "My change", mine: true, canApprove: false, assigned: true }),
    mr(13, { title: "Old approval", reviewRequested: true, approvedByMe: true, canApprove: false }),
  ];
  await page.addInitScript((items) => {
    window.__gitbrixPrs = { items, problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
    // Another repository's request, involving the user: not in this window.
    window.__gitbrixInbox = {
      items: [{ ...items[0], number: 99, title: "Elsewhere", project: "gitlab.com/other/service", remote: "" }],
      problems: [],
      accounts: ["gitlab|https://gitlab.com|me"],
    };
  }, here);
  await page.goto("/?open");
  // The toolbar button counts what waits for the user's approval, and stands out.
  const button = page.locator(".pr-button");
  await expect(button.locator(".pr-button-count")).toHaveText("1");
  await expect(button).toHaveClass(/waiting/);
  await page.locator(".toolbar-right").screenshot({ path: "test-results/shots/pr-button.png" });
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Pull requests" });
  await expect(dialog.locator(".modal-title")).toHaveText("Pull requests · demo-app");
  await expect(dialog.locator(".pr-row")).toHaveCount(2);
  await page.screenshot({ path: "test-results/shots/pull-requests-window.png" });
  await dialog.getByRole("button", { name: /^Mine/ }).click();
  await expect(dialog.locator(".pr-row")).toHaveCount(1);
  await expect(dialog.locator(".pr-row")).toContainText("My change");
  await dialog.getByRole("button", { name: /^All/ }).click();
  await expect(dialog.locator(".pr-row")).toHaveCount(3);
  await expect(dialog).not.toContainText("Elsewhere");

  await dialog.locator(".pr-row", { hasText: "Review me" }).getByRole("button", { name: "Approve…" }).click();
  await page.getByRole("dialog").filter({ hasText: "Approve !11" }).getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => lastCall(page, "approve_pull_request")).toMatchObject({ project: "gitlab.com/team/demo-app", number: 11 });

  // A row opens the request in the app.
  await dialog.locator(".pr-row", { hasText: "My change" }).click();
  await expect(page.getByTestId("pull-request").locator(".commit-summary")).toHaveText("My change");
  expect(errors).toEqual([]);
});

test("pull requests button: shows the open count without anything to approve", async ({ page }) => {
  await page.addInitScript((items) => {
    window.__gitbrixPrs = { items, problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, [mr(21, { mine: true, canApprove: false }), mr(22, { mine: true, canApprove: false })]);
  await page.goto("/?open");
  const button = page.locator(".pr-button");
  await expect(button.locator(".pr-button-count")).toHaveText("2");
  await expect(button).toHaveClass(/has/);
  await expect(button).not.toHaveClass(/waiting/);
  await expect(button).toHaveAttribute("title", "Pull requests: 2 open");
});

test("pull requests window: points to Settings without accounts", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".pr-button .pr-button-count")).toHaveCount(0);
  await page.locator(".pr-button").click();
  await page.getByRole("dialog", { name: "Pull requests" }).getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByTestId("accounts")).toBeVisible();
  // Settings can show a sample notification.
  await page.getByRole("button", { name: "Test", exact: true }).click();
  expect(await lastCall(page, "plugin:notification|notify")).toMatchObject({
    options: { title: "Review requested: !1 Example merge request" },
  });
});

test("title bar: own window buttons, also on the welcome screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".titlebar .tab.pinned")).toHaveText("Workspaces");
  await page.getByTitle("Open another repository").click();
  await expect(page.getByRole("button", { name: /Open repository/ })).toBeVisible();
  for (const [name, cmd] of [
    ["Minimize", "plugin:window|minimize"],
    ["Maximize", "plugin:window|toggle_maximize"],
    ["Close", "plugin:window|close"],
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    expect(await calls(page)).toContain(cmd);
  }
  await page.goto("/?open");
  await expect(page.locator(".titlebar .tab.active")).toHaveText("demo-app");
  await expect(page.locator(".titlebar .tab").first()).toHaveText("Workspaces");
  await expect(page.locator(".titlebar-drag")).toHaveAttribute("data-tauri-drag-region", "true");
  await page.locator(".titlebar").screenshot({ path: "test-results/shots/titlebar.png" });
});

test("workspaces: a pinned tab with every workspace; fetch all, open a repository", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    window.__gitbrixFound = ["/home/me/code/api", "/home/me/code/web", "/home/me/code/missing"];
  });
  await page.goto("/?open");
  const pinned = page.locator(".titlebar .tab.pinned");
  await expect(pinned).toHaveText("Workspaces");
  // Pinned: no close button.
  await expect(pinned.locator(".tab-close")).toHaveCount(0);
  await pinned.click();
  const view = page.getByTestId("workspaces");
  await expect(pinned).toHaveClass(/active/);
  await expect(page.locator(".titlebar .tab.active")).toHaveCount(1);
  await view.getByRole("button", { name: "Add the open tabs" }).click();
  await expect(view.locator(".ws-row:not(.ws-cols)")).toHaveCount(1);
  await expect(view.locator(".ws-row", { hasText: "demo-app" })).toContainText("changed");

  // A folder's repositories join it (the folder picker answers in mock mode).
  await view.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("All repositories in a folder…").click();
  await expect(view.locator(".ws-row:not(.ws-cols)")).toHaveCount(4);
  const api = view.locator(".ws-row", { hasText: "api" });
  await expect(api).toContainText("↓2");
  await expect(view.locator(".ws-row", { hasText: "missing" })).toContainText("could not find repository");
  await expect(view.locator(".ws-summary")).toContainText("4 repositories · 1 with changes · 2 behind");

  // A second workspace shows in the list on the left.
  await view.getByTitle("New workspace").click();
  await page.getByRole("dialog").getByRole("textbox").fill("Work");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(view.locator(".ws-item")).toHaveCount(2);
  await expect(view.locator(".ws-item.selected")).toContainText("Work");
  await view.locator(".ws-item", { hasText: "Workspace" }).click();
  await expect(view.locator(".ws-row:not(.ws-cols)")).toHaveCount(4);
  await page.screenshot({ path: "test-results/shots/workspace.png" });

  await view.getByRole("button", { name: "Fetch all" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "fetch").map((c) => c.args.repo)))
    .toHaveLength(4);

  // The repository tab brings the repository back.
  await page.locator(".titlebar .tab", { hasText: "demo-app" }).click();
  await expect(view).toHaveCount(0);
  await expect(page.locator(".graph-row").first()).toBeVisible();

  // Kept across restarts; a row opens its repository.
  await page.reload();
  await pinned.click();
  await expect(view.locator(".ws-item")).toHaveCount(2);
  await api.click();
  await expect(view).toHaveCount(0);
  await expect.poll(() => lastCall(page, "open_repo")).toMatchObject({ path: "/home/me/code/api" });
  expect(errors).toEqual([]);
});

test("profiles: add work and personal, switch, see who commits", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await expect(page.locator(".commit-identity")).toContainText("Demo User <demo@example.com>");
  await expect(page.locator(".profile-button")).toHaveCount(0);

  await page.getByTitle("Settings").click();
  const profiles = page.getByTestId("profiles");
  for (const [name, user, email] of [
    ["Work", "Selim A.", "selim@company.example"],
    ["Personal", "Selim", "selim@home.example"],
  ]) {
    await profiles.getByRole("button", { name: "Add profile…" }).click();
    await profiles.getByPlaceholder("Work", { exact: true }).fill(name);
    await profiles.getByPlaceholder("Selim Ardaçevik").fill(user);
    await profiles.getByPlaceholder("selim@company.com").fill(email);
    await profiles.getByRole("button", { name: "Save profile" }).click();
  }
  // The first profile became the active one.
  await expect(profiles.getByLabel("Use Work")).toBeChecked();
  await page.screenshot({ path: "test-results/shots/profiles.png" });
  await expect.poll(() => lastCall(page, "save_profiles")).toMatchObject({
    profiles: { list: [{ name: "Work" }, { name: "Personal", userEmail: "selim@home.example" }] },
  });

  // A profile without an email is refused with the reason.
  await profiles.getByRole("button", { name: "Add profile…" }).click();
  await profiles.getByPlaceholder("Work", { exact: true }).fill("Broken");
  await profiles.getByRole("button", { name: "Save profile" }).click();
  await expect(profiles.locator(".modal-error")).toContainText("name and an email");
  await profiles.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  await expect(page.locator(".commit-identity")).toContainText("Selim A. <selim@company.example>");
  await page.locator(".profile-button").click();
  await page.getByRole("menuitem", { name: /Personal/ }).click();
  await expect(page.locator(".profile-button")).toHaveText("Personal");
  await expect(page.locator(".commit-identity")).toContainText("selim@home.example");
  expect(errors).toEqual([]);
});

test("terminal: opens under the graph, keys go to the shell, not to shortcuts", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await page.getByTitle("Terminal (Ctrl+`)").click();
  const panel = page.getByTestId("terminal");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".xterm")).toBeVisible();
  await expect.poll(() => lastCall(page, "terminal_open")).toMatchObject({ repo: "/home/demo/codes/demo-app" });
  await page.keyboard.type("ls");
  // Ctrl+K is the shell's (kill line), not the command palette.
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "terminal_write").map((c) => c.args.data).join("")))
    .toBe("ls\u000b");
  await page.screenshot({ path: "test-results/shots/terminal.png" });
  await page.keyboard.press("Control+`");
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("create pull request: from a branch's menu, pushed first, with reviewers", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await page.locator(".pill", { hasText: /^feature\/ui/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create pull request…" }).click();
  const dialog = page.getByRole("dialog", { name: "Create pull request" });
  await expect(dialog.locator(".modal-title")).toHaveText("Create merge request");
  await expect(dialog.getByLabel("Source branch")).toHaveValue("feature/ui");
  await expect(dialog.getByLabel("Target branch")).toHaveValue("main");
  // The title starts from the branch's last commit.
  await expect(dialog.locator("input").first()).toHaveValue("UI: dark theme");
  await dialog.getByPlaceholder("What changes and why").fill("Darker colours.");
  await dialog.getByLabel("grace").check();
  await dialog.getByLabel("Draft").check();
  await page.screenshot({ path: "test-results/shots/create-pr.png" });
  // origin/feature/ui is behind the local branch, so it goes up first.
  await dialog.getByRole("button", { name: "Push and create merge request" }).click();
  await expect(dialog).toHaveCount(0);
  const cmds = await calls(page);
  expect(cmds.indexOf("push_branch")).toBeLessThan(cmds.indexOf("create_pull_request"));
  expect(await lastCall(page, "push_branch")).toMatchObject({ remote: "origin", branch: "feature/ui" });
  expect(await lastCall(page, "create_pull_request")).toMatchObject({
    remote: "origin",
    request: { source: "feature/ui", target: "main", title: "UI: dark theme", body: "Darker colours.", draft: true, reviewers: [8] },
  });
  await expect(page.getByText("Opened !14")).toBeVisible();
  expect(errors).toEqual([]);
});

test("review a request in the app: files, diff, comments, merge", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript((first) => {
    window.__gitbrixPrs = { items: [first], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, mr(5, { title: "Dark theme" }));
  await page.goto("/?open");
  await page.locator(".pr-item", { hasText: "Dark theme" }).click();
  const panel = page.getByTestId("pull-request");
  await expect(panel.locator(".commit-summary")).toHaveText("Dark theme");
  await expect.poll(() => lastCall(page, "pull_request_range")).toMatchObject({ remote: "origin", number: 5, target: "main" });
  // The source branch's commit (origin/feature/ui) is selected in the graph too.
  await expect(page.locator(".graph-row.selected")).toContainText("UI: layout pass");

  await panel.locator(".file-row", { hasText: "ui.rs" }).click();
  const diff = page.getByTestId("diff");
  await expect(diff).toBeVisible();
  // Line comments show under their line; any line takes a new one.
  const line3 = diff.locator(".dl", { hasText: "pub fn theme" });
  await expect(diff.locator(".line-comment")).toContainText("Too dark?");
  await line3.hover();
  await line3.getByRole("button", { name: "Comment on this line" }).click();
  await diff.getByPlaceholder(/Comment on this line/).fill("Use the palette here");
  await diff.locator(".line-composer").getByRole("button", { name: "Comment" }).click();
  await expect.poll(() => lastCall(page, "comment_pull_request_line")).toMatchObject({
    number: 5,
    at: { path: "src/ui.rs", newLine: 3, oldLine: null },
    body: "Use the palette here",
  });
  await expect(diff.locator(".line-composer")).toHaveCount(0);
  await line3.hover();
  await page.screenshot({ path: "test-results/shots/pr-review-files.png" });

  await panel.getByRole("button", { name: /Conversation/ }).click();
  await expect(panel.locator(".pr-description")).toHaveText("Makes the UI darker.");
  await expect(panel.locator(".pr-comment", { hasText: "Too dark?" })).toContainText("src/ui.rs:3");
  await panel.getByPlaceholder("Write a comment").fill("Looks fine to me");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => lastCall(page, "comment_pull_request")).toMatchObject({ number: 5, body: "Looks fine to me" });
  await page.screenshot({ path: "test-results/shots/pr-review-conversation.png" });

  await panel.getByRole("button", { name: "Merge…" }).click();
  await panel.getByRole("button", { name: "Squash" }).click();
  await panel.getByRole("button", { name: "Merge", exact: true }).click();
  await expect.poll(() => lastCall(page, "merge_pull_request")).toMatchObject({ number: 5, method: "squash", deleteBranch: true });
  await expect(page.getByText("Merged !5 into main")).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("CI: marks on commits and requests; a click opens the pipeline", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript((first) => {
    window.__gitbrixPrs = { items: [first], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
  }, mr(6, { title: "Pipeline", ci: "running" }));
  await page.goto("/?open");
  const row = (text: string) => page.locator(".graph-row", { hasText: text });
  await expect(row("Tidy up main")).toBeVisible();
  const ids = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll(".graph-row")].map((r) => [r.textContent ?? "", r.getAttribute("data-commit")])),
  );
  const idOf = (text: string) => Object.entries(ids).find(([t]) => t.includes(text))![1]!;
  await page.evaluate(
    ([a, b]) => {
      window.__gitbrixCi = {
        [a]: { state: "failed", url: "https://ci.example/p/2" },
        [b]: { state: "success", url: "https://ci.example/p/1" },
      };
    },
    [idOf("Tidy up main"), idOf("UI: dark theme")],
  );
  await page.getByTitle("Refresh (F5)").click();
  await expect(row("Tidy up main").locator(".ci-mark.ci-failed")).toBeVisible();
  await expect(row("UI: dark theme").locator(".ci-mark.ci-success")).toBeVisible();
  await expect(row("Experiment: fast path").locator(".ci-mark")).toHaveCount(0);
  await expect(page.locator(".pr-item", { hasText: "Pipeline" }).locator(".ci-running")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/ci-marks.png" });

  await row("Tidy up main").locator(".ci-mark").click();
  await expect.poll(() => lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://ci.example/p/2" });
  expect(errors).toEqual([]);
});

test("LFS: pointers are filled in on their own; untracked files can be tracked", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    (window as { __gitbrixLfsPending?: number }).__gitbrixLfsPending = 2;
  });
  await page.goto("/?open");
  await expect(page.getByText("Downloaded 2 LFS files")).toBeVisible();
  // Once per repository state, not on every refresh.
  await page.getByTitle("Refresh (F5)").click();
  await page.waitForTimeout(600);
  expect((await calls(page)).filter((c) => c === "lfs_pull")).toHaveLength(1);

  await page.locator(".wip-panel .file-row", { hasText: "notes.txt" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Track \*\.txt with Git LFS/ }).click();
  await expect.poll(() => lastCall(page, "lfs_track")).toMatchObject({ pattern: "*.txt" });
  expect(errors).toEqual([]);
});

test("patches: save a commit, copy it, apply a file as commits or to the work tree", async ({ page, context }) => {
  const errors = trackErrors(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?open");
  const row = page.locator(".graph-row", { hasText: "Tidy up main" });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Save as patch…" }).click();
  await expect(page.getByText("Saved 0001-Tidy-up-main.patch")).toBeVisible();
  const id = await row.getAttribute("data-commit");
  expect(await lastCall(page, "format_patch")).toMatchObject({ ids: [id], from: null });
  expect(await lastCall(page, "save_text_file")).toMatchObject({ path: "/home/demo/0001-Tidy-up-main.patch" });
  expect((await lastCall(page, "plugin:dialog|save"))?.options).toMatchObject({ defaultPath: "0001-Tidy-up-main.patch" });

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as patch" }).click();
  await expect(page.getByText("Patch copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Subject: [PATCH] mock");

  await page.locator(".repo-btn").click();
  await page.getByRole("menuitem", { name: /Apply patch as commits/ }).click();
  const confirm = page.getByRole("dialog").filter({ hasText: "Apply patches as commits" });
  await expect(confirm).toContainText("• Add two");
  await confirm.getByRole("button", { name: "Commit 2" }).click();
  await expect.poll(() => lastCall(page, "apply_patch_file")).toMatchObject({ commit: true });

  await page.locator(".repo-btn").click();
  await page.getByRole("menuitem", { name: /Apply patch to working tree/ }).click();
  await expect.poll(() => lastCall(page, "apply_patch_file")).toMatchObject({ commit: false });
  expect(errors).toEqual([]);
});

test("start: the Workspaces tab is selected, the last repository waits in its tab", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gitbrix.tabs", JSON.stringify({ tabs: [{ path: "/home/demo/codes/demo-app", name: "demo-app" }], active: "/home/demo/codes/demo-app" }));
  });
  await page.goto("/");
  await expect(page.getByTestId("workspaces")).toBeVisible();
  await expect(page.locator(".titlebar .tab.active")).toHaveText("Workspaces");
  await expect.poll(() => lastCall(page, "open_repo")).toMatchObject({ path: "/home/demo/codes/demo-app" });
  // Still on Workspaces once the repository has loaded.
  await page.waitForTimeout(300);
  await expect(page.getByTestId("workspaces")).toBeVisible();
  await page.locator(".titlebar .tab", { hasText: "demo-app" }).click();
  await expect(page.locator(".graph-row").first()).toBeVisible();
});

test("workspaces: every repository's requests together; one opens in its repository", async ({ page }) => {
  const errors = trackErrors(page);
  const demo = "/home/demo/codes/demo-app";
  await page.addInitScript(
    ([demo, a, b]) => {
      localStorage.setItem("gitbrix.workspaces", JSON.stringify({ list: [{ id: "w", name: "Work", repos: [demo, "/home/me/code/api"] }], active: "w" }));
      window.__gitbrixPrsByRepo = {
        [demo]: { items: [a], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] },
        "/home/me/code/api": { items: [b], problems: [], covered: true, projects: ["gitlab.com/team/api"] },
      };
    },
    [
      demo,
      mr(31, { title: "Demo change", canApprove: false, created: "2026-10-28T10:00:00Z" }),
      mr(32, { title: "API change", project: "gitlab.com/team/api", reviewRequested: true, created: "2026-10-29T10:00:00Z" }),
    ] as const,
  );
  await page.goto("/");
  const view = page.getByTestId("workspaces");
  // Request counts on the repository rows.
  await expect(view.locator(".ws-row", { hasText: "api" }).locator(".ws-prs.waiting")).toHaveText("1");
  await view.getByRole("button", { name: /^Pull requests/ }).click();
  await expect(view.getByRole("button", { name: /^Pull requests/ })).toContainText("2");
  // Starts on what waits for the user.
  await expect(view.locator(".pr-row")).toHaveCount(1);
  await expect(view.locator(".pr-row")).toContainText("API change");
  await view.getByRole("button", { name: /^All/ }).click();
  await expect(view.locator(".pr-row .pr-title")).toHaveText(["API change", "Demo change"]);
  await expect(view.locator(".pr-row", { hasText: "Demo change" })).toContainText("demo-app");
  await page.screenshot({ path: "test-results/shots/workspace-prs.png" });

  await view.locator(".pr-row", { hasText: "Demo change" }).click();
  await expect(view).toHaveCount(0);
  await expect(page.getByTestId("pull-request").locator(".commit-summary")).toHaveText("Demo change");
  expect(errors).toEqual([]);
});

test("several commits: Ctrl/Shift+click selects them; cherry-pick, revert, squash", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  const row = (text: string) => page.locator(".graph-row", { hasText: text });
  await row("Tidy up main").click();
  // Two commits still compare.
  await row("Update changelog").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("compare")).toBeVisible();
  // A third makes a selection.
  await row("Wire parser into main").click({ modifiers: ["Control"] });
  const panel = page.getByTestId("multi");
  await expect(panel.locator(".stash-kicker")).toHaveText("3 commits selected");
  await expect(page.locator(".graph-row.selected")).toHaveCount(3);
  // Ctrl+click again takes one out (back to comparing two).
  await row("Wire parser into main").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("compare")).toBeVisible();
  // Shift+click: everything between, branches included.
  await row("Tidy up main").click();
  await row("Update changelog").click({ modifiers: ["Shift"] });
  await expect(panel.locator(".multi-row")).toHaveCount(4);
  await page.screenshot({ path: "test-results/shots/multi-select.png" });
  const ids = await page.evaluate(() => window.__gitbrixStore.getState().multi);

  await panel.getByRole("button", { name: /Cherry-pick onto main/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cherry-pick 4" }).click();
  // Oldest first.
  await expect.poll(() => lastCall(page, "cherry_pick_many")).toMatchObject({ ids: [...ids].reverse() });

  await row("Tidy up main").click();
  await row("UI: dark theme").click({ modifiers: ["Shift"] });
  await row("Tidy up main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Revert 3 commits…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revert 3" }).click();
  const reverted = await page.evaluate(() => window.__gitbrixStore.getState().multi);
  await expect.poll(() => lastCall(page, "revert_many")).toMatchObject({ ids: reverted });

  // Squash: the recorded line after "Wire parser into main" is
  // "Update changelog", "Tidy up main"; with a commit off the line selected
  // it refuses, with consecutive ones it plans an interactive rebase.
  await row("Tidy up main").click();
  await row("Update changelog").click({ modifiers: ["Control"] });
  await row("UI: dark theme").click({ modifiers: ["Control"] });
  await panel.getByRole("button", { name: "Squash into one…" }).click();
  await expect(page.getByText("Squash needs consecutive commits")).toBeVisible();
  expect(await lastCall(page, "interactive_rebase")).toBeUndefined();
  expect(errors).toEqual([]);
});

test("clean up branches: merged ones ticked, gone and remote ones on request", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await page.getByTitle("Clean up branches…").click();
  const dialog = page.getByRole("dialog", { name: "Clean up branches" });
  await expect(dialog.getByLabel("fix/typo")).toBeChecked();
  await expect(dialog.getByLabel("experiment/fast-path")).not.toBeChecked();
  await expect(dialog.getByLabel("origin/feature/ui")).not.toBeChecked();
  await expect(dialog).toContainText("origin/experiment/fast-path was deleted");
  await dialog.getByLabel("experiment/fast-path").check();
  await expect(dialog.locator(".cleanup-warn")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/cleanup.png" });
  await dialog.getByRole("button", { name: "Delete 2 branches" }).click();
  await expect(page.getByText("Deleted 2 branches")).toBeVisible();
  const deletes = await page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "delete_branch").map((c) => c.args));
  expect(deletes).toEqual([
    { repo: "/home/demo/codes/demo-app", name: "fix/typo", force: false },
    { repo: "/home/demo/codes/demo-app", name: "experiment/fast-path", force: true },
  ]);
  expect(await calls(page)).not.toContain("delete_remote_branch");
  expect(errors).toEqual([]);
});

test("auto-stash: changes in the way are stashed, the checkout runs, they come back", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await page.evaluate(() => {
    window.__gitbrixFailOnce = { checkout_branch: "Your local changes to notes.txt would be overwritten. Commit or stash them first." };
  });
  await page.locator(".pill", { hasText: /^fix\/typo/ }).dblclick();
  const confirm = page.getByRole("dialog").filter({ hasText: "Local changes in the way" });
  await expect(confirm).toContainText("notes.txt would be overwritten");
  await confirm.getByRole("button", { name: "Stash and carry on" }).click();
  await expect(page.getByText("(local changes stashed and put back)")).toBeVisible();
  const cmds = (await calls(page)).filter((c) => ["stash_save", "checkout_branch", "stash_apply"].includes(c));
  expect(cmds).toEqual(["checkout_branch", "stash_save", "checkout_branch", "stash_apply"]);
  expect(await lastCall(page, "stash_save")).toMatchObject({ includeUntracked: true });
  expect(await lastCall(page, "stash_apply")).toMatchObject({ pop: true });

  // "Always" skips the question.
  await page.evaluate(() => {
    localStorage.setItem("gitbrix.settings", JSON.stringify({ autoStash: "always" }));
  });
  await page.reload();
  await page.evaluate(() => {
    window.__gitbrixFailOnce = { checkout_branch: "Your local changes would be overwritten. Commit or stash them first. (x)" };
  });
  await page.locator(".pill", { hasText: /^fix\/typo/ }).dblclick();
  await expect(page.getByText("(local changes stashed and put back)")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("bisect: mark bad and good to start, verdicts from the banner, the culprit at the end", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  const row = (text: string) => page.locator(".graph-row", { hasText: text });
  await expect(row("Tidy up main")).toBeVisible();
  const id = async (text: string) => (await row(text).getAttribute("data-commit"))!;
  const [bad, good, testing] = [await id("Tidy up main"), await id("Initial commit"), await id("Wire parser into main")];

  await row("Tidy up main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bisect: mark bad" }).click();
  await expect(page.locator(".op-banner.bisect")).toContainText("marked bad");
  await expect(row("Tidy up main").locator(".bisect-mark")).toHaveText("bad");

  // Starting answers with the first commit to test.
  await page.evaluate(
    ([bad, good, testing]) => {
      window.__gitbrixBisect = { active: true, bad, good: [good], skipped: [], current: testing, remaining: 9, steps: 4, found: null };
    },
    [bad, good, testing],
  );
  await row("Initial commit").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bisect: this one is good (start)" }).click();
  await expect.poll(() => lastCall(page, "bisect_start")).toMatchObject({ bad, good });
  const banner = page.locator(".op-banner.bisect");
  await expect(banner).toContainText("9 commits left, about 4 steps");
  await expect(row("Wire parser into main").locator(".bisect-mark")).toHaveText("testing");
  await page.screenshot({ path: "test-results/shots/bisect.png" });

  await page.evaluate(
    ([bad, good, found]) => {
      window.__gitbrixBisect = { active: true, bad: found, good: [good], skipped: [], current: found, remaining: 1, steps: 0, found };
      void bad;
    },
    [bad, good, testing],
  );
  await banner.getByRole("button", { name: "Bad", exact: true }).click();
  await expect.poll(() => lastCall(page, "bisect_mark")).toMatchObject({ verdict: "bad", rev: null });
  await expect(banner).toContainText("First bad commit");
  await expect(row("Wire parser into main").locator(".bisect-mark")).toHaveText("first bad");
  await expect(row("Wire parser into main")).toHaveClass(/selected/);

  await page.evaluate(() => {
    window.__gitbrixBisect = undefined;
  });
  await banner.getByRole("button", { name: "Stop bisecting" }).click();
  await expect.poll(() => calls(page)).toContain("bisect_reset");
  await expect(page.locator(".op-banner.bisect")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("release: a tag's menu pushes the tag, then releases it with the notes", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/?open");
  await page.locator(".pill", { hasText: /^v0\.2\.0/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Create release/ }).click();
  const dialog = page.getByRole("dialog", { name: "Create release" });
  await expect(dialog.locator("textarea")).toHaveValue("- Parser: tokenizer\n- Write getting started guide");
  await dialog.locator("input").first().fill("Version 0.2");
  await page.screenshot({ path: "test-results/shots/release.png" });
  await dialog.getByRole("button", { name: "Push tag and release" }).click();
  await expect(page.getByText("Released v0.2.0")).toBeVisible();
  const cmds = await calls(page);
  expect(cmds.indexOf("push_tag")).toBeLessThan(cmds.indexOf("create_release"));
  expect(await lastCall(page, "push_tag")).toMatchObject({ remote: "origin", tag: "v0.2.0", delete: false });
  expect(await lastCall(page, "create_release")).toMatchObject({
    remote: "origin",
    release: { tag: "v0.2.0", name: "Version 0.2", draft: false, prerelease: false },
  });
  expect(errors).toEqual([]);
});
