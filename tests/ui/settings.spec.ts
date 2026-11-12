import { expect, test } from "@playwright/test";

import { invokedCmds, openSettings } from "./helpers";

test("settings tabs switch by click", async ({ page }) => {
  await openSettings(page);
  await expect(page.locator("#tab-visibility")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-visibility")).toBeVisible();
  await page.locator("#tab-shortcuts").click();
  await expect(page.locator("#tab-shortcuts")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-shortcuts")).toBeVisible();
  await expect(page.locator("#panel-visibility")).toBeHidden();
  await page.locator("#tab-sync").click();
  await expect(page.locator("#panel-sync")).toBeVisible();
});

test("settings tabs switch with arrow keys", async ({ page }) => {
  await openSettings(page);
  await page.locator("#tab-visibility").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tab-window")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-window")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#tab-visibility")).toHaveAttribute("aria-selected", "true");
});

test("default visibility save and window snap toggle", async ({ page }) => {
  await openSettings(page);
  const visibilityButtons = page.locator("#visibility-choices button");
  await expect(visibilityButtons.first()).toHaveText("Offline Private");
  await page.locator("#visibility-choices button", { hasText: "Offline Private" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Default memo visibility saved.");
  await expect.poll(async () => invokedCmds(page)).toContain("save_settings");
  await page.locator("#visibility-choices button", { hasText: "Public" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Default memo visibility saved.");
  await page.locator("#tab-window").click();
  await page.locator("#show-in-switcher").check();
  await expect(page.locator("#settings-status")).toHaveText("Alt+Tab enabled. Pinned mode stays on.");
  await expect.poll(async () => invokedCmds(page)).toContain("set_show_in_switcher");
  await page.locator("#pinned-always-on-top").uncheck();
  await expect(page.locator("#show-in-switcher")).toBeChecked();
  await expect(page.locator("#show-in-switcher")).toBeDisabled();
  await expect(page.locator("#settings-status")).toHaveText(
    "Pinned memos no longer stay on top. Alt+Tab is on so you can still find them.",
  );
  await expect.poll(async () => invokedCmds(page)).toContain("set_pinned_always_on_top");
  await page.locator("#pinned-always-on-top").check();
  await expect(page.locator("#show-in-switcher")).toBeEnabled();
  await page.locator("#snap-memos").check();
  await expect(page.locator("#settings-status")).toHaveText("Window snap enabled.");
  await expect.poll(async () => invokedCmds(page)).toContain("set_snap_memos");
  await page.locator("#tab-editor").click();
  await page.locator("#coder-editor").check();
  await expect(page.locator("#settings-status")).toHaveText("New memos use the coder editor.");
  await expect.poll(async () => invokedCmds(page)).toContain("set_coder_editor");
  await page.locator("#markdown-schemes button", { hasText: "Cool" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Cool syntax colors.");
  await expect.poll(async () => invokedCmds(page)).toContain("set_markdown_scheme");
  await page.locator("#markdown-highlight").uncheck();
  await expect(page.locator("#settings-status")).toHaveText("Markdown syntax colors disabled.");
  await expect.poll(async () => invokedCmds(page)).toContain("set_markdown_highlight");
});

test("pinned tab bar display and edge are saved", async ({ page }) => {
  await openSettings(page);
  await page.locator("#tab-window").click();
  await expect(page.locator("#pin-tab-bar-enabled")).toBeChecked();
  await expect(page.locator("#pin-tab-screen")).toHaveValue("cursor");
  await expect(page.locator("#pin-tab-edge")).toHaveValue("top");
  await expect(page.locator("#pin-tab-screen option[value='display:Main']")).toHaveCount(1);
  await page.locator("#pin-tab-screen").selectOption("display:Main");
  await expect(page.locator("#settings-status")).toHaveText("Pinned tab bar updated.");
  await page.locator("#pin-tab-edge").selectOption("left");
  await expect(page.locator("#pin-tab-edge")).toHaveValue("left");
  await expect.poll(async () => invokedCmds(page)).toContain("set_pin_tab_place");
  await page.locator("#pin-tab-bar-enabled").uncheck();
  await expect(page.locator("#pin-tab-screen")).toBeDisabled();
  await expect(page.locator("#pin-tab-edge")).toBeDisabled();
  await expect(page.locator("#settings-status")).toHaveText(
    "Pinned tab bar hidden. Tabs are available from the tray menu.",
  );
  await expect.poll(async () => invokedCmds(page)).toContain("set_pin_tab_bar_enabled");
});

test("launch at login toggle calls set_autostart", async ({ page }) => {
  await openSettings(page);
  await page.locator("#tab-window").click();
  await page.locator("#autostart").check();
  await expect(page.locator("#settings-status")).toHaveText("Launch at login enabled.");
  await expect.poll(async () => invokedCmds(page)).toContain("set_autostart");
});

test("shortcut recorder adds a chord", async ({ page }) => {
  await openSettings(page);
  await page.locator("#tab-shortcuts").click();
  const row = page.locator(".shortcut", { hasText: "New memo" });
  await row.locator("button.add").click();
  await expect(row.locator("button.add")).toHaveText("Press shortcut");
  await page.keyboard.press("Shift+Control+KeyM");
  await expect.poll(async () => invokedCmds(page)).toContain("save_shortcut");
  await expect(page.locator("#settings-status")).toHaveText("Shortcut saved.");
});

test("gesture modifier save", async ({ page }) => {
  await openSettings(page);
  await page.locator("#tab-shortcuts").click();
  await page.locator("#gesture button", { hasText: /Control|Ctrl/ }).click();
  await expect.poll(async () => invokedCmds(page)).toContain("save_shortcut");
  await expect(page.locator("#settings-status")).toHaveText("Modifier saved.");
});

test("sync save, test connection, and disconnect", async ({ page }) => {
  await openSettings(page, {
    settings: { baseUrl: "", hasToken: false },
  });
  await page.locator("#tab-sync").click();
  await page.locator("#base-url").fill("https://memos.example.com");
  await page.locator("#token").fill("test-token");
  await page.locator("#save-settings").click();
  await expect(page.locator("#settings-status")).toHaveText("Saved.");
  await page.locator("#test-connection").click();
  await expect(page.locator("#settings-status")).toHaveText("Connected (latest).");
  await page.locator("#clear-memos").click();
  await expect(page.locator("#settings-status")).toHaveText("Disconnected.");
  const cmds = await invokedCmds(page);
  expect(cmds).toContain("save_settings");
  expect(cmds).toContain("test_memos");
  expect(cmds).toContain("clear_memos");
});
