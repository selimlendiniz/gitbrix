// Comments on the user's requests and mentions raise a desktop
// notification; the first look only records.

import { expect, Page, test } from "@playwright/test";

const notes = (page: Page) =>
  page.evaluate(() =>
    window.__gitbrixCalls.filter((c) => c.cmd === "plugin:notification|notify").map((c) => (c.args.options as { title: string; body: string })),
  );

const mr = (over: Record<string, unknown> = {}) => ({
  provider: "gitlab",
  remote: "",
  account: "gitlab|https://gitlab.com|me",
  project: "gitlab.com/team/demo-app",
  number: 4,
  title: "Dark theme",
  author: "me",
  sourceBranch: "feature/ui",
  targetBranch: "main",
  sameRepo: true,
  url: "https://gitlab.com/team/demo-app/-/merge_requests/4",
  draft: false,
  created: "2026-10-29T10:00:00Z",
  updated: "2026-10-29T10:00:00Z",
  mine: true,
  reviewRequested: false,
  assigned: false,
  canApprove: false,
  approvedByMe: false,
  approved: false,
  comments: 1,
  mentioned: false,
  ...over,
});

const inbox = (items: unknown[]) => ({ items, problems: [], accounts: ["gitlab|https://gitlab.com|me"] });

test("comments: new ones by others, and mentions, are told once", async ({ page }) => {
  await page.addInitScript((first) => {
    window.__gitbrixInbox = first;
  }, inbox([mr()]));
  await page.goto("/?open");
  const bell = page.getByRole("button", { name: "Pull requests for you" });
  await expect(bell).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("gitbrix.prs.memory") ?? "")).toContain('"comments"');
  expect(await notes(page)).toEqual([]);

  // Two more comments: one by the user, one by ada mentioning them.
  await page.evaluate(
    ([next]) => {
      const later = new Date(Date.now() + 60_000).toISOString();
      window.__gitbrixInbox = next;
      window.__gitbrixCommentsFor = [
        { id: "1", thread: null, resolvable: false, resolved: false, author: "ada", body: "old", created: "2020-01-01T00:00:00Z", path: null, line: null, verdict: null, system: false },
        { id: "2", thread: null, resolvable: false, resolved: false, author: "me", body: "mine", created: later, path: null, line: null, verdict: null, system: false },
        { id: "3", thread: null, resolvable: false, resolved: false, author: "ada", body: "@me can you look at the colours?", created: later, path: null, line: null, verdict: null, system: false },
      ];
    },
    [inbox([mr({ comments: 3 }), mr({ number: 7, title: "Docs", author: "grace", mine: false, mentioned: true, comments: 0 })])] as const,
  );
  await bell.click();
  await page.getByRole("dialog", { name: "Pull requests for you" }).getByTitle("Check again").click();
  await expect.poll(() => notes(page)).toEqual([
    { title: "ada mentioned you on !4 Dark theme", body: "@me can you look at the colours? · demo-app" },
    { title: "You were mentioned on !7 Docs", body: "grace · demo-app" },
  ]);

  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "pull_request_conversation_for").length)).toBe(1);
});
