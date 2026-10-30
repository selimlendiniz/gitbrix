// Stashing some files only: from a file's menu, or picked in a window.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

test("stash files: one from its menu, several picked", async ({ page }) => {
  await page.goto("/?open");
  await page.locator(".wip-panel .file-row", { hasText: "notes.txt" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stash this file…" }).click();
  const prompt = page.getByRole("dialog", { name: "Stash notes.txt" });
  await prompt.locator("input").fill("notes for later");
  await prompt.getByRole("button", { name: "Stash" }).click();
  await expect.poll(() => lastCall(page, "stash_paths")).toMatchObject({ paths: ["notes.txt"], message: "notes for later" });

  await page.locator(".wip-panel").getByRole("button", { name: "Stash", exact: true }).click();
  await page.getByRole("menuitem", { name: "Stash some files…" }).click();
  const pick = page.getByRole("dialog", { name: "Stash files" });
  await expect(pick.locator(".stash-pick .checkbox")).toHaveCount(3);
  const send = pick.getByRole("button", { name: /^Stash/ });
  await expect(send).toBeDisabled();
  await pick.getByLabel(/main\.rs/).check();
  await pick.getByLabel(/CHANGELOG\.md/).check();
  await page.screenshot({ path: "test-results/shots/stash-files.png" });
  await send.click();
  await page.getByRole("dialog", { name: "Stash 2 files" }).getByRole("button", { name: "Stash" }).click();
  await expect.poll(() => lastCall(page, "stash_paths")).toMatchObject({ paths: ["CHANGELOG.md", "src/main.rs"], message: null });
});
