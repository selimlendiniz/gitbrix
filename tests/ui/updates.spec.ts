// Updates: the release address in Settings, a check at start, installing
// from About.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

const ADDRESS = "https://example.com/gitbrix/latest.json";

test("updates: nothing is asked without an address", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  expect(await lastCall(page, "update_check")).toBeUndefined();
  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await page.getByRole("menuitem", { name: "About gitbrix" }).click();
  await page.getByRole("dialog", { name: "About gitbrix" }).getByRole("button", { name: /Set a release address/ }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByLabel("Release address").fill(ADDRESS);
  await settings.getByRole("button", { name: "Check now" }).click();
  await expect(settings).toContainText("Up to date (0.1.0)");
  expect(await lastCall(page, "update_check")).toEqual({ address: ADDRESS });
});

test("updates: a newer version found at start, installed from About", async ({ page }) => {
  await page.addInitScript((address) => {
    localStorage.setItem("gitbrix.settings", JSON.stringify({ updateUrl: address }));
    window.__gitbrixUpdate = { current: "0.1.0", version: "0.2.0", notes: "Issues, more windows", date: null, kind: "rpm", canInstall: true };
  }, ADDRESS);
  await page.goto("/?open");
  await expect(page.getByText("gitbrix 0.2.0 is available — see About gitbrix")).toBeVisible();
  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await page.getByRole("menuitem", { name: "About gitbrix" }).click();
  const about = page.getByRole("dialog", { name: "About gitbrix" });
  await expect(about).toContainText("0.2.0 is available (you have 0.1.0)");
  await expect(about.locator(".update-notes")).toHaveText("Issues, more windows");
  await page.screenshot({ path: "test-results/shots/update.png" });
  await about.getByRole("button", { name: "Install 0.2.0 and restart" }).click();
  expect(await lastCall(page, "update_install")).toEqual({ address: ADDRESS });
});

test("updates: a Flatpak copy is told to use flatpak update", async ({ page }) => {
  await page.addInitScript((address) => {
    localStorage.setItem("gitbrix.settings", JSON.stringify({ updateUrl: address, updateCheck: false }));
    window.__gitbrixUpdate = { current: "0.1.0", version: "0.2.0", notes: null, date: null, kind: "flatpak", canInstall: false };
  }, ADDRESS);
  await page.goto("/?open");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  // Not at start: turned off.
  expect(await lastCall(page, "update_check")).toBeUndefined();
  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await page.getByRole("menuitem", { name: "About gitbrix" }).click();
  const about = page.getByRole("dialog", { name: "About gitbrix" });
  await about.getByRole("button", { name: "Check for updates" }).click();
  await expect(about).toContainText("0.2.0 is available; update it with flatpak update");
  await expect(about.getByRole("button", { name: /Install/ })).toHaveCount(0);
});
