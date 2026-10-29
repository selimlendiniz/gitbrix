import { expect, test } from "@playwright/test";

test("info toasts disappear on their own", async ({ page }) => {
  await page.goto("/?open");
  await page.getByText("Wire parser into main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create branch here…" }).click();
  await page.getByRole("dialog").locator("input").first().fill("t/one");
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.locator(".toast")).toHaveCount(1);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6000 });
});
