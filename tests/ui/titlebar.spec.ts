// The title bar's own items: app menu, search box, pull requests for the
// user, background work, account; tab marks and overflow; author pictures.

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

async function callCount(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).length, cmd);
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
  mine: false,
  reviewRequested: false,
  assigned: false,
  canApprove: true,
  approvedByMe: false,
  approved: false,
  ...over,
});

// A square in a colour, as a picture service would send it.
const picture = (color: string) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${color}"/></svg>`).toString("base64")}`;

test("title bar: app menu, search box, about", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("gitbrix.recent", JSON.stringify([{ path: "/home/me/code/api", name: "api", openedAt: Date.now() }]));
  });
  await page.goto("/?open");
  await page.getByRole("button", { name: "gitbrix menu" }).click();
  for (const name of ["Open repository…", "Clone repository…", "Settings…", "About gitbrix", "Quit"]) {
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  }
  // Recent repositories, path shortened.
  await expect(page.getByRole("menuitem", { name: /^api/ })).toContainText("~/code/api");
  await page.getByRole("menuitem", { name: "About gitbrix" }).click();
  await expect(page.getByRole("dialog", { name: "About gitbrix" })).toContainText("Version 0.1.0");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "About gitbrix" })).toHaveCount(0);

  await page.locator(".title-search").click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await page.getByRole("menuitem", { name: "Quit" }).click();
  expect(await callCount(page, "plugin:window|close")).toBe(1);
  expect(errors).toEqual([]);
});

test("title bar: pull requests for the user, across accounts", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(
    ([local, inbox]) => {
      window.__gitbrixPrs = { items: [local], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
      window.__gitbrixInbox = { items: inbox, problems: [], accounts: ["gitlab|https://gitlab.com|me"] };
    },
    [
      mr(1, { title: "Polish the toolbar" }),
      [
        { ...mr(1, { title: "Polish the toolbar" }), remote: "" },
        { ...mr(7, { title: "Faster lexer", project: "gitlab.com/team/lib", url: "https://gitlab.com/team/lib/-/merge_requests/7" }), remote: "" },
        { ...mr(9, { title: "My own change", mine: true, canApprove: false }), remote: "" },
      ],
    ] as const,
  );
  await page.goto("/?open");
  const bell = page.getByRole("button", { name: "Pull requests for you" });
  await expect(bell.locator(".title-count")).toHaveText("2");
  await bell.click();
  const pop = page.getByRole("dialog", { name: "Pull requests for you" });
  await expect(pop.locator(".inbox-group")).toHaveCount(2);
  await expect(pop.locator(".inbox-group").first()).toContainText("Waiting for you 2");
  await expect(pop.locator(".inbox-group").nth(1)).toContainText("My own change");
  await page.locator(".title-popover").screenshot({ path: "test-results/shots/titlebar-inbox.png" });

  // Not cloned here: the browser.
  await pop.locator(".pr-row", { hasText: "Faster lexer" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://gitlab.com/team/lib/-/merge_requests/7" });

  // The open repository has it: reviewed in the app.
  await bell.click();
  await page.getByRole("dialog", { name: "Pull requests for you" }).locator(".pr-row", { hasText: "Polish the toolbar" }).click();
  await expect(page.getByTestId("pull-request")).toContainText("Polish the toolbar");
  expect(errors).toEqual([]);
});

test("title bar: without accounts the bell says how to add one", async ({ page }) => {
  await page.goto("/?open");
  await page.getByRole("button", { name: "Pull requests for you" }).click();
  await page.getByRole("dialog", { name: "Pull requests for you" }).getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("title bar: background problems are kept until cleared", async ({ page }) => {
  await page.addInitScript(() => {
    window.__gitbrixFailOnce = { pull_request_inbox: "Couldn't reach gitlab.com" };
  });
  await page.goto("/?open");
  const button = page.getByRole("button", { name: "Background work" });
  await expect(button).toHaveClass(/problem/);
  await expect(button.locator(".title-count")).toHaveText("1");
  await button.click();
  const pop = page.getByRole("dialog", { name: "Background work" });
  await expect(pop.locator(".activity-row.problem")).toContainText("Checking your pull requests");
  await expect(pop.locator(".activity-row.problem")).toContainText("Couldn't reach gitlab.com");
  // Seen: no longer counted, still listed.
  await expect(button).not.toHaveClass(/problem/);
  await pop.getByRole("button", { name: "Clear" }).click();
  await expect(button).toHaveCount(0);
});

test("tabs: marks for changes and commits to push; a list when they don't fit", async ({ page }) => {
  await page.addInitScript(() => {
    const tabs = [
      { path: "/home/demo/demo-app", name: "demo-app" },
      ...Array.from({ length: 14 }, (_, i) => ({ path: `/home/me/code/project-${i}`, name: `project-${i}` })),
    ];
    localStorage.setItem("gitbrix.tabs", JSON.stringify({ tabs, active: null }));
  });
  await page.goto("/?open");
  const active = page.locator(".tab.active");
  await expect(active.locator(".tab-name")).toHaveText("demo-app");
  // The fixture: changes in the work tree, one commit to push.
  await expect(active.locator(".tab-dirty")).toBeVisible();
  await expect(active.locator(".tab-ahead")).toHaveText("↑1");
  await expect(active.locator(".tab-marks")).toHaveAttribute("title", /uncommitted change.*1 commit to push/);
  // Other tabs: from their summaries (the mock: 2 behind, clean).
  await expect(page.locator(".tab", { hasText: "project-3" }).locator(".tab-behind")).toHaveText("↓2");
  await expect(page.locator(".tab", { hasText: "project-3" }).locator(".tab-dirty")).toHaveCount(0);

  await page.getByRole("button", { name: "All tabs" }).click();
  await page.getByRole("menuitem", { name: /^project-13/ }).click();
  await expect.poll(() => lastCall(page, "open_repo")).toMatchObject({ path: "/home/me/code/project-13" });
});

test("author pictures: in the graph, the author column and the commit; off in Settings", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript((pic) => {
    window.__gitbrixAvatars = { "ada@example.com": pic };
  }, picture("#d94"));
  await page.goto("/?open");
  const row = page.locator(".graph-row", { hasText: "Tidy up main" });
  await expect(row.locator("img.avatar")).toBeVisible();
  // Asked once for every author on screen together.
  await expect.poll(() => callCount(page, "avatars")).toBe(1);
  expect(((await lastCall(page, "avatars")) as { emails: string[] }).emails.length).toBeGreaterThan(1);
  // Someone without a picture: initials.
  await expect(page.locator(".graph-row", { hasText: "Parser: tokenizer" }).locator(".avatar.initials")).toHaveText("GH");
  await row.locator(".message").click();
  await expect(page.locator(".commit-meta img.avatar")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/avatars.png" });

  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  await page.getByRole("button", { name: "Initials only" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator("img.avatar")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("account button: who commits, accounts, profiles", async ({ page }) => {
  await page.goto("/?open");
  await page.getByRole("button", { name: "Accounts and profiles" }).click();
  await expect(page.getByRole("menuitem", { name: /Demo User/ })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "No GitHub or GitLab account" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Accounts and profiles…" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});
