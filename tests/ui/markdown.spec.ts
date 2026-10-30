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
  "<ul><li>first from HTML</li><li>second from <i>HTML</i></li></ul>",
  "",
  "<details><summary>More</summary>hidden text</details>",
  "",
  '<script>window.__pwned = true</script><a href="javascript:window.__pwned=true" onclick="window.__pwned=true">click</a>',
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
  // HTML the services allow is shown; scripts, handlers and pictures aren't.
  await expect(md.locator("ul", { hasText: "first from HTML" }).locator("li")).toHaveCount(2);
  await expect(md.locator("li i")).toHaveText("HTML");
  await expect(md.locator("b")).toHaveText("raw");
  await expect(md.locator("details summary")).toHaveText("More");
  await expect(md.locator("script")).toHaveCount(0);
  await expect(md.locator("img")).toHaveCount(0);
  await expect(md.locator("[onclick], [onerror]")).toHaveCount(0);
  // A javascript: link isn't one.
  await expect(md.locator("a", { hasText: /^(bad|click)$/ })).toHaveCount(0);
  await expect(md.locator(".md-dead-link")).toHaveText(["click", "bad"]);
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

// What GitLab sends (trimmed from a real answer's shape).
const GITLAB_HTML = `<h2 data-sourcepos="1:1-1:6" dir="auto"><a href="#why" aria-hidden="true" class="anchor" id="user-content-why"></a>Why</h2>
<p dir="auto">The UI is <strong>too bright</strong>, see <a href="/team/demo-app/-/issues/12" data-reference-type="issue" title="Dark UI" class="gfm gfm-issue">#12</a> and <a href="/ada" class="gfm gfm-project_member js-user-link">@ada</a> <gl-emoji title="thumbs up" data-name="thumbsup">👍</gl-emoji></p>
<ul class="task-list" dir="auto">
<li class="task-list-item"><task-button></task-button><input type="checkbox" class="task-list-item-checkbox" checked disabled> dark theme</li>
<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> light theme</li>
</ul>
<div class="gl-relative markdown-code-block js-markdown-code"><pre lang="rust" class="code highlight js-syntax-highlight language-rust"><code><span id="LC1" class="line" lang="rust"><span class="k">fn</span> <span class="nf">main</span><span class="p">()</span> <span class="p">{}</span></span></code></pre><copy-code></copy-code></div>
<p><a class="no-attachment-icon" href="/-/project/1/uploads/abc/shot.png" target="_blank" rel="noopener noreferrer"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" alt="screenshot" class="lazy" data-src="/-/project/1/uploads/abc/shot.png"></a></p>
<p><a href="javascript:window.__pwned=true" onclick="window.__pwned=true" style="position:fixed;inset:0">x</a><span class="modal-backdrop">styled?</span><script>window.__pwned = true</script></p>`;

test("markdown: GitLab's own rendering is shown", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(
    ([pr, html]) => {
      window.__gitbrixPrs = { items: [pr], problems: [], covered: true, projects: ["gitlab.com/team/demo-app"] };
      window.__gitbrixDescription = "raw markdown, not shown";
      window.__gitbrixDescriptionHtml = html;
    },
    [
      {
        provider: "gitlab", remote: "origin", account: "a", project: "gitlab.com/team/demo-app", number: 5, title: "Dark theme",
        author: "ada", sourceBranch: "feature/ui", targetBranch: "main", sameRepo: true,
        url: "https://gitlab.com/team/demo-app/-/merge_requests/5", draft: false, created: "", updated: "", mine: false,
        reviewRequested: false, assigned: false, canApprove: false, approvedByMe: false, approved: false,
      },
      GITLAB_HTML,
    ] as const,
  );
  await page.goto("/?open");
  await page.locator(".pr-item", { hasText: "Dark theme" }).click();
  const panel = page.getByTestId("pull-request");
  await panel.getByRole("button", { name: /Conversation/ }).click();
  const md = panel.locator(".pr-description");
  await expect(md).not.toContainText("raw markdown");
  await expect(md.locator("h2")).toHaveText("Why");
  await expect(md).toContainText("👍");
  await expect(md.locator("li input[type=checkbox]")).toHaveCount(2);
  // GitLab's highlighting, in the app's colours.
  await expect(md.locator("pre .hl-keyword")).toHaveText("fn");
  await expect(md.locator("pre .hl-title")).toHaveText("main");
  // Nothing from the page reaches the app's styles or runs.
  await expect(md.locator(".modal-backdrop, [style], [onclick], script, img")).toHaveCount(0);
  await expect(md.locator(".md-dead-link", { hasText: /^x$/ })).toHaveCount(1);
  await page.screenshot({ path: "test-results/shots/markdown-gitlab.png" });

  await md.getByRole("link", { name: "#12" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://gitlab.com/team/demo-app/-/issues/12" });
  await md.getByRole("link", { name: "@ada" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://gitlab.com/ada" });
  await md.getByRole("link", { name: "[screenshot]" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://gitlab.com/-/project/1/uploads/abc/shot.png" });
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});
