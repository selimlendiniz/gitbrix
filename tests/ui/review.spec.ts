// Reviewing a request: threads (reply, resolve), a pending review sent
// together, suggested changes.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

const pr = (over: Record<string, unknown> = {}) => ({
  provider: "github",
  remote: "origin",
  account: "github|https://github.com|me",
  project: "github.com/team/demo-app",
  number: 5,
  title: "Dark theme",
  author: "ada",
  sourceBranch: "feature/ui",
  targetBranch: "main",
  sameRepo: true,
  url: "https://github.com/team/demo-app/pull/5",
  draft: false,
  created: "",
  updated: "",
  mine: false,
  reviewRequested: true,
  assigned: false,
  canApprove: true,
  approvedByMe: false,
  approved: false,
  ...over,
});

const c = (id: string, over: Record<string, unknown>) => ({
  id,
  thread: null,
  resolvable: false,
  resolved: false,
  author: "ada",
  body: "",
  created: `2026-10-0${id}T00:00:00Z`,
  path: null,
  line: null,
  verdict: null,
  system: false,
  ...over,
});

const COMMENTS = [
  c("1", { body: "Looks good overall" }),
  c("2", { thread: "PRRT_a", resolvable: true, body: "Too dark?", path: "src/ui.rs", line: 3 }),
  c("3", { thread: "PRRT_a", resolvable: true, author: "me", body: "Lighter now", path: "src/ui.rs", line: 3 }),
  c("4", { thread: "PRRT_b", resolvable: true, resolved: true, author: "grace", body: "Typo in the name", path: "src/ui.rs", line: 1 }),
  c("5", {
    thread: "PRRT_c",
    resolvable: true,
    author: "grace",
    body: "Name it after the palette:\n```suggestion\npub fn palette() -> Theme {\n```",
    path: "src/ui.rs",
    line: 3,
  }),
];

async function open(page: Page, request = pr(), head?: string) {
  await page.addInitScript(
    ([p, comments, h]) => {
      window.__gitbrixPrs = { items: [p], problems: [], covered: true, projects: [String(p.project)] };
      window.__gitbrixComments = comments as unknown[];
      if (h) window.__gitbrixHead = h as string;
    },
    [request, COMMENTS, head ?? null] as const,
  );
  await page.goto("/?open");
  await page.locator(".pr-item", { hasText: "Dark theme" }).click();
  return page.getByTestId("pull-request");
}

test("threads: replies nested, reply and resolve, resolved ones folded", async ({ page }) => {
  const panel = await open(page);
  await panel.getByRole("button", { name: /Conversation/ }).click();
  const thread = panel.locator('.thread[data-thread="PRRT_a"]');
  await expect(thread.locator(".thread-replies")).toContainText("Lighter now");
  // Resolved: folded to one line, opened on a click.
  const done = panel.locator('.thread[data-thread="PRRT_b"]');
  await expect(done.locator(".thread-folded")).toContainText("Typo in the name");
  await done.locator(".thread-folded").click();
  await expect(done.getByRole("button", { name: "Reopen thread" })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/threads.png" });

  await thread.getByRole("button", { name: "Reply…" }).click();
  await thread.locator("textarea").fill("Even lighter?");
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  await expect
    .poll(() => lastCall(page, "reply_pull_request"))
    .toEqual({ repo: expect.any(String), remote: "origin", number: 5, thread: "PRRT_a", first: "2", body: "Even lighter?" });
  await thread.getByRole("button", { name: "Resolve thread" }).click();
  await expect.poll(() => lastCall(page, "resolve_pull_request_thread")).toMatchObject({ thread: "PRRT_a", resolved: true });
});

test("review: line comments wait, then go out together with a verdict", async ({ page }) => {
  const panel = await open(page);
  await panel.locator(".file-row", { hasText: "ui.rs" }).click();
  const diff = page.getByTestId("diff");
  const line = diff.locator(".dl", { hasText: "pub fn theme" });
  // The thread on the line, with its reply box.
  await expect(line.locator("xpath=following-sibling::div[contains(@class,'line-comments')][1]").locator(".thread")).toHaveCount(2);
  await line.hover();
  await line.getByRole("button", { name: "Comment on this line" }).click();
  await diff.locator(".line-composer textarea").fill("Use the palette here");
  await diff.locator(".line-composer").getByRole("button", { name: "Add to review" }).click();
  await expect(diff.locator(".pr-comment.pending")).toContainText("Use the palette here");
  // Nothing sent yet.
  expect(await lastCall(page, "comment_pull_request_line")).toBeUndefined();
  await expect(panel.getByRole("button", { name: /Conversation/ })).toContainText("1 pending");

  await panel.getByRole("button", { name: /Conversation/ }).click();
  const box = panel.getByTestId("review");
  await expect(box).toContainText("1 comment waiting to be sent");
  await expect(box.locator(".review-pending")).toContainText("src/ui.rs:3");
  await box.locator("textarea").fill("A few things");
  await box.getByRole("button", { name: "Request changes" }).click();
  await page.screenshot({ path: "test-results/shots/review-box.png" });
  await box.getByRole("button", { name: "Send review" }).click();
  await expect.poll(() => lastCall(page, "review_pull_request")).toMatchObject({
    number: 5,
    review: {
      body: "A few things",
      verdict: "request_changes",
      comments: [{ path: "src/ui.rs", newLine: 3, oldLine: null, body: "Use the palette here" }],
    },
  });
  await expect(box).toContainText("Add line comments to it from the diffs");
  await expect(page.getByText("Review sent")).toBeVisible();
});

test("review: GitLab has no request-changes verdict", async ({ page }) => {
  const panel = await open(page, pr({ provider: "gitlab", project: "gitlab.com/team/demo-app", url: "https://gitlab.com/team/demo-app/-/merge_requests/5" }));
  await panel.getByRole("button", { name: /Conversation/ }).click();
  const box = panel.getByTestId("review");
  await expect(box.getByRole("button", { name: "Approve" })).toBeVisible();
  await expect(box.getByRole("button", { name: "Request changes" })).toHaveCount(0);
});

test("suggestions: written from a line, applied on the request's branch", async ({ page }) => {
  const panel = await open(page, pr(), "feature/ui");
  await panel.locator(".file-row", { hasText: "ui.rs" }).click();
  const diff = page.getByTestId("diff");
  const line = diff.locator(".dl", { hasText: "pub fn theme" });
  await line.hover();
  await line.getByRole("button", { name: "Comment on this line" }).click();
  await diff.locator(".line-composer").getByRole("button", { name: "Suggest change" }).click();
  await expect(diff.locator(".line-composer textarea")).toHaveValue(/^```suggestion\npub fn theme.*\n```\n$/);
  await diff.locator(".line-composer").getByRole("button", { name: "Cancel" }).click();

  await panel.getByRole("button", { name: /Conversation/ }).click();
  await panel.locator('.thread[data-thread="PRRT_c"]').getByRole("button", { name: "Apply suggestion" }).click();
  await expect
    .poll(() => lastCall(page, "apply_suggestion"))
    .toEqual({ repo: expect.any(String), path: "src/ui.rs", from: 3, to: 3, text: "pub fn palette() -> Theme {" });
});

test("suggestions: not applied off the request's branch", async ({ page }) => {
  const panel = await open(page);
  await panel.getByRole("button", { name: /Conversation/ }).click();
  await panel.locator('.thread[data-thread="PRRT_c"]').getByRole("button", { name: "Apply suggestion" }).click();
  await expect(page.getByText("Check out feature/ui first")).toBeVisible();
  expect(await lastCall(page, "apply_suggestion")).toBeUndefined();
});
