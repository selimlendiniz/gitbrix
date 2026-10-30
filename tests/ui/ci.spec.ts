// A commit's CI in the app: jobs by stage, a coloured log, retry.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

const E = "\u001b";

test("CI: jobs, the failed one's log, retry", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/?open");
  const row = page.locator(".graph-row", { hasText: "Tidy up main" });
  await expect(row).toBeVisible();
  const sha = await row.getAttribute("data-commit");
  await page.evaluate(
    ([id, log]) => {
      window.__gitbrixCi = { [id!]: { state: "failed", url: "https://git.test/p/77" } };
      window.__gitbrixCiJobs = {
        url: "https://git.test/p/77",
        state: "failed",
        jobs: [
          { id: "1", name: "build", stage: "build", state: "success", url: "w1", duration: 72, hasLog: true },
          { id: "2", name: "test", stage: "test", state: "failed", url: "w2", duration: 3, hasLog: true },
          { id: "3", name: "codecov", stage: "test", state: "success", url: "https://codecov.example/x", duration: null, hasLog: false },
        ],
      };
      window.__gitbrixCiLog = log;
    },
    [sha, `$ cargo test\n${E}[31;1merror${E}[0m: 1 test failed\n`] as const,
  );
  await page.getByTitle("Refresh (F5)").click();
  await row.locator(".ci-mark.ci-failed").click();
  const dialog = page.getByRole("dialog", { name: "CI" });
  await expect(dialog.locator(".ci-stage-name")).toHaveText(["build", "test"]);
  await expect(dialog.locator(".ci-job", { hasText: "build" })).toContainText("1m 12s");
  // The failed job is picked, its log shown, coloured.
  await expect(dialog.locator(".ci-job.selected")).toContainText("test");
  await expect(dialog.getByTestId("ci-log")).toContainText("1 test failed");
  await expect(dialog.locator(".ansi-fg-1.ansi-bold")).toHaveText("error");
  expect(await lastCall(page, "ci_log")).toMatchObject({ job: "2" });
  await page.screenshot({ path: "test-results/shots/ci.png" });

  // A check without a log here: its page.
  await dialog.locator(".ci-job", { hasText: "codecov" }).click();
  await dialog.getByRole("button", { name: "Open it" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://codecov.example/x" });

  await dialog.locator(".ci-job", { hasText: "test" }).first().getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => lastCall(page, "ci_retry")).toMatchObject({ job: "2" });
  await dialog.getByRole("button", { name: "Open in browser" }).click();
  expect(await lastCall(page, "plugin:opener|open_url")).toMatchObject({ url: "https://git.test/p/77" });
  expect(errors).toEqual([]);
});
