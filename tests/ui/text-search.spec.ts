// Searching the work tree's text, opening hits in the editor.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

test("search in files: grouped hits, open in the editor at the line", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gitbrix.settings", JSON.stringify({ editor: "code" })));
  await page.goto("/?open");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  await page.keyboard.press("Control+Shift+F");
  const dialog = page.getByRole("dialog", { name: "Search in files" });
  await dialog.getByPlaceholder(/Search the work tree/).fill("println");
  await expect(dialog.locator(".text-search-file")).toHaveCount(2);
  await expect(dialog.locator(".text-search-status")).toHaveText("3 matches in 2 files (12 searched)");
  await expect(dialog.locator(".text-search-hit mark").first()).toHaveText("println!");
  await dialog.getByRole("button", { name: "Regular expression" }).click();
  await expect.poll(() => lastCall(page, "search_text")).toMatchObject({ query: "println", regex: true, caseSensitive: false });
  await page.screenshot({ path: "test-results/shots/text-search.png" });
  await dialog.locator(".text-search-hit", { hasText: "bye" }).click();
  await expect.poll(() => lastCall(page, "open_in_editor")).toMatchObject({ command: "code --goto {file}:{line}", path: "src/main.rs", line: 7 });

  // A bad pattern says so.
  await dialog.getByPlaceholder(/Search the work tree/).fill("(");
  await expect(dialog.locator(".text-search-status")).toContainText("Not a valid pattern");
});

test("editor: chosen in Settings; files, diffs and the repository open in it", async ({ page }) => {
  await page.goto("/?open");
  // The default is the desktop's app, without a line.
  await page.locator(".wip-panel .file-row", { hasText: "main.rs" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in editor" }).click();
  await expect.poll(() => lastCall(page, "open_in_editor")).toMatchObject({ command: "", path: "src/main.rs" });

  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Editor", { exact: true }).selectOption("idea");
  await expect(settings).toContainText("idea --line {line} {file}");
  await settings.getByRole("button", { name: "Done" }).click();

  await page.locator(".wip-panel .file-row", { hasText: "main.rs" }).click();
  await page.getByTestId("diff").getByRole("button", { name: "Edit" }).click();
  await expect.poll(() => lastCall(page, "open_in_editor")).toMatchObject({ command: "idea --line {line} {file}", path: "src/main.rs" });
  expect(((await lastCall(page, "open_in_editor")) as { line: number }).line).toBeGreaterThan(0);

  await page.locator(".repo-btn").click();
  await page.getByRole("menuitem", { name: "Open in editor" }).click();
  await expect.poll(() => lastCall(page, "open_in_editor")).toMatchObject({ command: "idea {dir}", path: null });
});
