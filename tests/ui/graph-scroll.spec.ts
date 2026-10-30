// The graph drawing moves with the rows as the page scrolls, before any
// script runs (WebKit scrolls on its own thread), and covers what's shown
// once the scroll is handled.

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 420 } });

const offsets = () => {
  const el = document.querySelector(".graph-scroll")!;
  const canvas = el.querySelector("canvas")!.getBoundingClientRect();
  const rows = el.querySelector(".graph-rows")!.getBoundingClientRect();
  const view = el.getBoundingClientRect();
  return { canvasInRows: canvas.top - rows.top, canvasTop: canvas.top, canvasBottom: canvas.bottom, viewTop: view.top, viewBottom: view.bottom };
};

test("graph: the drawing scrolls with the rows", async ({ page }) => {
  await page.goto("/?open");
  await expect(page.locator(".graph-row").first()).toBeVisible();
  const [before, after] = await page.evaluate((fn) => {
    const read = new Function(`return (${fn})()`) as () => ReturnType<typeof offsets>;
    const el = document.querySelector(".graph-scroll")!;
    const a = read();
    // Moved without the scroll event being handled yet.
    el.scrollTop = 120;
    return [a, read()];
  }, offsets.toString());
  expect(after.canvasInRows).toBe(before.canvasInRows);

  // Once handled, the drawing still covers the visible rows.
  await page.locator(".graph-scroll").evaluate((el) => el.dispatchEvent(new Event("scroll")));
  await expect
    .poll(() => page.evaluate((fn) => (new Function(`return (${fn})()`) as () => ReturnType<typeof offsets>)(), offsets.toString()))
    .toMatchObject({ canvasTop: expect.any(Number) });
  const o = await page.evaluate((fn) => (new Function(`return (${fn})()`) as () => ReturnType<typeof offsets>)(), offsets.toString());
  expect(o.canvasTop).toBeLessThanOrEqual(o.viewTop);
  expect(o.canvasBottom).toBeGreaterThanOrEqual(o.viewBottom);
});
