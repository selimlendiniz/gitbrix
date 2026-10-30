// More windows: a tab moved to a window of its own, a window opened for a
// repository, the app menu's window items.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

const REPO = "/home/demo/codes/demo-app";

test("windows: a tab moves to a new window", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "gitbrix.tabs",
      JSON.stringify({ tabs: [{ path: "/home/demo/codes/demo-app", name: "demo-app" }, { path: "/home/me/code/api", name: "api" }], active: null }),
    );
  });
  await page.goto("/?open");
  await expect(page.locator(".tab.active .tab-name")).toHaveText("demo-app");
  await page.locator(".tab", { hasText: "demo-app" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to new window" }).click();
  const created = (await lastCall(page, "plugin:webview|create_webview_window")) as { options: { label: string; url: string; decorations: boolean } };
  expect(created.options.decorations).toBe(false);
  const url = new URL(created.options.url, "http://x");
  expect(url.searchParams.get("repo")).toBe(REPO);
  expect(url.searchParams.get("window")).toBe(created.options.label);
  // Gone from this window.
  await expect(page.locator(".tab .tab-name")).toHaveText(["Workspaces", "api"]);
});

test("windows: a window opened for a repository shows it and doesn't touch the saved tabs", async ({ page }) => {
  const saved = JSON.stringify({ tabs: [{ path: "/home/me/code/api", name: "api" }], active: "/home/me/code/api" });
  await page.addInitScript((s) => localStorage.setItem("gitbrix.tabs", s), saved);
  await page.goto(`/?window=w1&repo=${encodeURIComponent(REPO)}`);
  await expect(page.locator(".tab.active .tab-name")).toHaveText("demo-app");
  // Only its own tab.
  await expect(page.locator(".tab .tab-name")).toHaveText(["Workspaces", "demo-app"]);
  await expect(page.locator(".graph-row").first()).toBeVisible();
  expect(await lastCall(page, "plugin:window|set_title")).toMatchObject({ value: "demo-app — gitbrix" });
  expect(await page.evaluate(() => localStorage.getItem("gitbrix.tabs"))).toBe(saved);
});

test("windows: the app menu opens a window; Ctrl+Shift+N too", async ({ page }) => {
  await page.goto("/?open");
  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Close window" })).toBeVisible();
  await page.getByRole("menuitem", { name: "New window" }).click();
  const first = (await lastCall(page, "plugin:webview|create_webview_window")) as { options: { url: string } };
  expect(new URL(first.options.url, "http://x").searchParams.get("repo")).toBeNull();
  await page.keyboard.press("Control+Shift+N");
  await expect
    .poll(() => page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "plugin:webview|create_webview_window").length))
    .toBe(2);
});
