import { expect, test } from "@playwright/test";

import { openComposer } from "./helpers";

type Caret = { value: string; start: number; end: number };

async function caretOf(page: import("@playwright/test").Page): Promise<Caret> {
  return page
    .locator("#blocks .md-lines")
    .first()
    .evaluate((el) => {
      const field = el as HTMLElement & { value: string; selectionStart: number; selectionEnd: number };
      return { value: field.value, start: field.selectionStart, end: field.selectionEnd };
    });
}

test("typing keeps the caret after the character just typed", async ({ page }) => {
  await openComposer(page);
  const lines = page.locator("#blocks .md-lines").first();
  await lines.click();
  await page.keyboard.type("hello", { delay: 1 });
  await expect.poll(() => caretOf(page)).toEqual({ value: "hello", start: 5, end: 5 });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("XY", { delay: 1 });
  await expect.poll(() => caretOf(page)).toEqual({ value: "helXYlo", start: 5, end: 5 });
});

test("a trailing break in the row does not split the line or leave the caret behind", async ({ page }) => {
  await openComposer(page);
  const lines = page.locator("#blocks .md-lines").first();
  await lines.click();
  await page.keyboard.type("hello");
  await lines
    .locator(".md-row")
    .first()
    .evaluate((row) => {
      row.append(document.createElement("br"));
    });
  await page.keyboard.type("X");
  await expect.poll(() => caretOf(page)).toEqual({ value: "helloX", start: 6, end: 6 });
});
