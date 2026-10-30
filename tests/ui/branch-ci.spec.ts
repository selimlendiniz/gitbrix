// The checked-out branch's CI in the title bar, and a notification when
// a run ends.

import { expect, test } from "@playwright/test";

test("branch CI: shown in the title bar, told when it ends", async ({ page }) => {
  await page.clock.install();
  await page.goto("/?open");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  const head = await page.evaluate(() => window.__gitbrixStore.getState().repo?.headOid);
  await page.evaluate((h) => {
    window.__gitbrixCi = { [h!]: { state: "running", url: "https://git.test/p/9" } };
  }, head);
  await page.getByTitle("Refresh (F5)").click();
  // Picked up with the graph's next CI look.
  await page.evaluate(() => window.__gitbrixStore.setState((s) => ({ graph: s.graph && { ...s.graph, refs: [...s.graph.refs] } })));
  await page.clock.runFor(1000);
  const button = page.getByRole("button", { name: "CI of the checked-out branch" });
  await expect(button).toContainText("main running");

  await page.evaluate((h) => {
    window.__gitbrixCi = { [h!]: { state: "failed", url: "https://git.test/p/9" } };
  }, head);
  // While it runs, it's looked at again every 30 seconds.
  await page.clock.runFor(31_000);
  await expect(button).toContainText("main failed");
  await page.screenshot({ path: "test-results/shots/branch-ci.png", clip: { x: 700, y: 0, width: 700, height: 40 } });
  await expect
    .poll(() => page.evaluate(() => window.__gitbrixCalls.filter((c) => c.cmd === "plugin:notification|notify").map((c) => (c.args.options as { title: string }).title)))
    .toEqual(["CI failed on main · demo-app"]);
  await button.click();
  await expect(page.getByRole("dialog", { name: "CI" })).toBeVisible();
});
