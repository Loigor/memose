import type { Page } from "@playwright/test";

import {
  emitEvent,
  installHarness,
  waitForListener,
  type HarnessSeed,
} from "./tauri-harness";

export async function openComposer(page: Page, seed: HarnessSeed = {}): Promise<void> {
  await installHarness(page, { windowLabel: "main", ...seed });
  await page.goto("/");
  await waitForListener(page, "composer-focus");
  await emitEvent(page, "composer-focus", 1);
  await page.locator("#blocks textarea").first().waitFor();
}

export async function openPinned(page: Page, noteId: string, seed: HarnessSeed = {}): Promise<void> {
  await installHarness(page, { windowLabel: `pin-${noteId}`, ...seed });
  await page.goto(`/?pin=${encodeURIComponent(noteId)}`);
  await page.locator("#card").waitFor();
  await page.locator("html.pin-window").waitFor();
}

export async function openSettings(page: Page, seed: HarnessSeed = {}): Promise<void> {
  await installHarness(page, { windowLabel: "main", ...seed });
  await page.goto("/settings.html");
  await page.locator("#tab-visibility").waitFor();
}

export async function composerTextarea(page: Page) {
  return page.locator("#blocks textarea").first();
}

export async function openMarkdownMenu(page: Page): Promise<void> {
  const toggle = page.locator("#markdown-toggle");
  if (!(await toggle.isVisible())) {
    await page.locator("#editor-menu-toggle").click();
  }
  await toggle.click();
}

export async function invokedCmds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__memoseHarness?.getInvocations() ?? []).map((item) => item.cmd));
}
