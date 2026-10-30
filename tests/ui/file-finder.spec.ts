// Ctrl+P finds a file by name; the file browser shows Markdown as a page,
// and the README when no file is picked.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

test("file finder: by name, then view, history or blame", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  await page.keyboard.press("Control+p");
  const finder = page.getByRole("dialog", { name: "Find a file" });
  await finder.locator("input").fill("lex");
  await expect(finder.locator(".palette-item").first()).toContainText("lexer.rs");
  await expect(finder.locator(".palette-item").first().locator(".finder-dir")).toHaveText("src/parser");
  // The name counts more than the folders: "ui" finds ui.rs before guide.md.
  await finder.locator("input").fill("ui");
  await expect(finder.locator(".palette-item").first()).toContainText("ui.rs");
  await page.screenshot({ path: "test-results/shots/file-finder.png" });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tree")).toBeVisible();
  expect(await lastCall(page, "file_at")).toMatchObject({ path: "src/ui.rs" });

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+p");
  await page.getByRole("dialog", { name: "Find a file" }).locator("input").fill("main.rs");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".view-kind")).toContainText(/history/i);
  expect(await lastCall(page, "file_history")).toMatchObject({ path: "src/main.rs" });
});

test("file browser: README as a page, Markdown with a source view", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Tidy up main").click();
  await page.getByRole("button", { name: "Browse files" }).click();
  const view = page.getByTestId("tree");
  // No file picked: the README.
  await expect(view.locator(".tree-markdown h1")).toHaveText("Demo");
  await expect(view.locator(".tree-markdown strong")).toHaveText("demo");
  await view.getByRole("button", { name: "Source" }).click();
  await expect(view.locator(".tree-code")).toContainText("# Demo");
  await view.getByRole("button", { name: "Preview" }).click();
  await expect(view.locator(".tree-markdown h1")).toHaveText("Demo");
});
