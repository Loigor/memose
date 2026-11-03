import { expect, test } from "@playwright/test";

import { invokedCmds, openPinTabs } from "./helpers";
import { emitEvent, getInvocations, waitForListener } from "./tauri-harness";

const tabs = {
  version: 1,
  activeId: "tab-work",
  tabs: [
    { id: "tab-work", name: "Work", hue: 210, notes: [{ id: "note-1" }] },
    { id: "tab-home", name: "Home", hue: 40, notes: [] },
  ],
};

test("collapsed strip shows a hairline and tab glimpses", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await expect(page.locator("#hairline")).toBeVisible();
  await expect(page.locator("#tab-add")).toBeVisible();
  await expect(page.locator(".pin-tab")).toHaveCount(2);
  await expect(page.locator("#hairline")).toHaveCSS("height", "6px");
  await expect(page.locator("#row")).toHaveCSS("height", "12px");
  await expect(page.locator(".pin-tab").first()).toHaveCSS("max-width", "100px");
  await expect(page.locator(".pin-tab[aria-current='true']")).toHaveText("Work");
  await expect(page.locator("html")).not.toHaveClass(/is-open/);
});

test("window-cursor over the strip expands it", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await emitEvent(page, "window-cursor", [24, 6]);
  await expect(page.locator("html")).toHaveClass(/is-open/);
  await emitEvent(page, "window-cursor", null);
  await expect(page.locator("html")).not.toHaveClass(/is-hiding/);
  const left = Date.now();
  await expect(page.locator("html")).toHaveClass(/is-hiding/);
  expect(Date.now() - left).toBeGreaterThanOrEqual(900);
});

test("hover expands the strip and + adds a tab", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await page.locator("#strip").hover();
  await expect(page.locator("html")).toHaveClass(/is-open/);
  await page.locator("#tab-add").click();
  await expect.poll(async () => invokedCmds(page)).toContain("add_pin_tab");
  await expect(page.locator(".pin-tab")).toHaveCount(3);
  await expect(page.locator(".pin-tab").nth(2)).toHaveText("Tab #3");
});

test("clicking a tab selects it", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await page.locator(".pin-tab", { hasText: "Home" }).click();
  await expect.poll(async () => invokedCmds(page)).toContain("select_pin_tab");
  await expect(page.locator(".pin-tab[aria-current='true']")).toHaveText("Home");
});

test("double-click opens rename and hue picker", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await page.locator(".pin-tab", { hasText: "Work" }).dblclick();
  await expect(page.locator("#tab-menu")).toBeVisible();
  await page.locator("#tab-name").fill("Desk");
  await expect.poll(async () => invokedCmds(page)).toContain("update_pin_tab");
  await page.locator(".hue-slider").fill("12");
  await expect.poll(async () => invokedCmds(page)).toContain("update_pin_tab");
});

test("unnamed tabs show Tab #N", async ({ page }) => {
  await openPinTabs(page, {
    pinTabs: {
      version: 1,
      activeId: "tab-a",
      tabs: [
        { id: "tab-a", name: "", hue: 210, notes: [] },
        { id: "tab-b", name: "  ", hue: 40, notes: [] },
      ],
    },
  });
  await expect(page.locator(".pin-tab").nth(0)).toHaveText("Tab #1");
  await expect(page.locator(".pin-tab").nth(1)).toHaveText("Tab #2");
});

test("dark tabs use a bright fill and white text", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs, theme: "dark" });
  const tab = page.locator(".pin-tab").first();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(tab).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(tab).toHaveCSS("background-color", "rgb(21, 117, 213)");
});

test("hovered strip makes tab buttons opaque", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await expect(page.locator(".pin-tab").nth(1)).toHaveCSS("opacity", "0.72");
  await page.locator("#strip").hover();
  await expect(page.locator(".pin-tab").nth(0)).toHaveCSS("opacity", "1");
  await expect(page.locator(".pin-tab").nth(1)).toHaveCSS("opacity", "1");
});

test("strip reports tab hit rects", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await expect.poll(async () => {
    const last = (await getInvocations(page))
      .filter((item) => item.cmd === "set_pin_tab_hits")
      .at(-1);
    return (last?.args as { hits?: { id: string; w: number; h: number }[] } | undefined)?.hits;
  }).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "tab-work", w: expect.any(Number), h: expect.any(Number) }),
      expect.objectContaining({ id: "tab-home", w: expect.any(Number), h: expect.any(Number) }),
    ]),
  );
});

test("pin-tab-aim marks the target tab", async ({ page }) => {
  await openPinTabs(page, { pinTabs: tabs });
  await waitForListener(page, "pin-tab-aim");
  await emitEvent(page, "pin-tab-aim", ["tab-home", "hold"]);
  await expect(page.locator(".pin-tab", { hasText: "Home" })).toHaveClass(/pin-tab-aim/);
  await emitEvent(page, "pin-tab-aim", ["tab-home", "ready"]);
  await expect(page.locator(".pin-tab", { hasText: "Home" })).toHaveClass(/pin-tab-ready/);
  await emitEvent(page, "pin-tab-aim", ["tab-home", "off"]);
  await expect(page.locator(".pin-tab", { hasText: "Home" })).not.toHaveClass(/pin-tab-aim/);
});
