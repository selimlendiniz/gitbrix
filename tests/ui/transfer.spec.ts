// Settings carried in a file: exported without tokens, imported part by
// part, accounts waiting for their token.

import { expect, Page, test } from "@playwright/test";

async function lastCall(page: Page, cmd: string) {
  return page.evaluate((c) => window.__gitbrixCalls.filter((x) => x.cmd === c).pop()?.args, cmd);
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "gitbrix menu" }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

const FILE = {
  gitbrix: 1,
  exported: "2026-10-30T09:00:00Z",
  settings: { theme: "light", prPoll: 10 },
  workspaces: [{ id: "w-home", name: "Home", repos: ["/home/me/code/api", "/home/me/code/web"] }],
  profiles: [{ id: "p-work", name: "Work", userName: "Selim", userEmail: "selim@work.example", folders: ["/home/me/work"], accounts: [] }],
  accounts: [{ provider: "gitlab", url: "https://git.corp", username: "s.cevik" }],
};

test("settings file: export holds no tokens", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gitbrix.workspaces", JSON.stringify({ list: [{ id: "w1", name: "Work", repos: ["/home/me/code/api"] }], active: "w1" }));
  });
  await page.goto("/?open");
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Export…" }).click();
  await expect.poll(() => lastCall(page, "save_text_file")).toBeTruthy();
  const saved = (await lastCall(page, "save_text_file")) as { text: string };
  const data = JSON.parse(saved.text);
  expect(data.gitbrix).toBe(1);
  expect(data.settings.theme).toBe("dark");
  expect(data.workspaces).toEqual([{ id: "w1", name: "Work", repos: ["/home/me/code/api"] }]);
  expect(saved.text).not.toMatch(/token/i);
  await expect(page.getByText(/no tokens in it/)).toBeVisible();
});

test("settings file: import chosen parts, accounts wait for a token", async ({ page }) => {
  await page.addInitScript((file) => {
    window.__gitbrixFile = JSON.stringify(file);
  }, FILE);
  await page.goto("/?open");
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Import…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import settings" });
  await expect(dialog).toContainText("1 workspace");
  await expect(dialog).toContainText("Home (2)");
  await expect(dialog).toContainText("Work <selim@work.example>");
  await expect(dialog).toContainText("s.cevik on git.corp");
  await page.screenshot({ path: "test-results/shots/import-settings.png" });
  // Keep this machine's preferences.
  await dialog.getByLabel(/Preferences/).uncheck();
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Imported. Add tokens for 1 account in Settings → Accounts")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await lastCall(page, "save_profiles")).toMatchObject({ profiles: { list: [{ id: "p-work", userEmail: "selim@work.example" }] } });
  const ws = await page.evaluate(() => JSON.parse(localStorage.getItem("gitbrix.workspaces") ?? "null"));
  expect(ws.list.map((w: { name: string }) => w.name)).toContain("Home");

  // The account waits in Settings, and leaves the list once added.
  const accounts = settings.getByTestId("accounts");
  const row = accounts.locator(".account-row.pending");
  await expect(row).toContainText("s.cevik");
  await row.getByRole("button", { name: "Add token…" }).click();
  await expect(accounts.locator("input").first()).toHaveValue("https://git.corp");
  await accounts.locator("input[type=password]").fill("glpat-secret");
  await accounts.getByRole("button", { name: "Add account" }).click();
  await expect(accounts.locator(".account-row.pending")).toHaveCount(0);
  expect(await lastCall(page, "add_account")).toMatchObject({ provider: "gitlab", url: "https://git.corp" });
});

test("settings file: not a settings file", async ({ page }) => {
  await page.addInitScript(() => {
    window.__gitbrixFile = '{"hello": 1}';
  });
  await page.goto("/?open");
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Import…" }).click();
  await expect(page.getByText("This isn't a gitbrix settings file")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Import settings" })).toHaveCount(0);
});
