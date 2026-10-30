// Moving through the graph from the keyboard.

import { expect, test } from "@playwright/test";

test("graph keys: j/k, ends, search matches, Enter, b, without focusing anything", async ({ page }) => {
  await page.goto("/?open");
  const selected = page.locator(".graph-row.selected");
  await page.getByText("Tidy up main").click();
  // Nothing focused: the keys still reach the graph.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("j");
  await expect(selected).toContainText("Experiment: fast path");
  await page.keyboard.press("k");
  await expect(selected).toContainText("Tidy up main");
  await page.keyboard.press("Shift+G");
  await expect(selected).toContainText("Initial commit");
  await page.keyboard.press("g");
  await expect(selected).toContainText("// WIP");

  // / opens the search; n and N go through the matches.
  await page.keyboard.press("/");
  await expect(page.getByPlaceholder("Search message, author or SHA")).toBeFocused();
  await page.keyboard.type("parser");
  // Back to the graph, the search still open.
  await page.locator(".graph-scroll").focus();
  await page.keyboard.press("n");
  await expect(selected).toContainText(/parser/i);
  const first = await selected.textContent();
  await page.keyboard.press("n");
  await expect(selected).not.toHaveText(first!);
  await page.keyboard.press("Shift+N");
  await expect(selected).toHaveText(first!);

  // Enter: the first changed file.
  await page.getByText("Tidy up main").click();
  await page.locator(".graph-scroll").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("diff")).toBeVisible();
  await page.keyboard.press("Escape");

  // b: a branch here.
  await page.locator(".graph-scroll").focus();
  await page.keyboard.press("b");
  await expect(page.getByRole("dialog", { name: /New branch at/ })).toBeVisible();
});
