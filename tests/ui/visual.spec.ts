import { test } from "@playwright/test";

// Not assertions: screenshots for eyeballing layout at the edges.
test("welcome screen", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: "test-results/shots/welcome.png" });
});

test("minimum window size", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 560 });
  await page.goto("/?open");
  await page.locator(".graph-row").first().waitFor();
  await page.screenshot({ path: "test-results/shots/narrow.png" });
});

test("light theme diff", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gitbrix.settings", JSON.stringify({ theme: "light" })));
  await page.goto("/?open");
  await page.getByText("Wire parser into main").click();
  await page.locator(".commit-panel .file-row", { hasText: "main.rs" }).click();
  await page.locator(".diff-table [class*=hl-]").first().waitFor();
  await page.screenshot({ path: "test-results/shots/light-diff.png" });
});
