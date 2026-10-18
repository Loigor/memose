import { expect, test } from "@playwright/test";

import { invokedCmds, openPinned } from "./helpers";
import { emitEvent, harnessSeedNotes, type NoteSeed } from "./tauri-harness";

function stackNotes(): { host: NoteSeed; guests: NoteSeed[] } {
  const host: NoteSeed = {
    id: "host-1",
    content: "# Host memo\nPinned body",
    pinned: true,
    updatedAt: Date.now(),
  };
  const guests: NoteSeed[] = [
    { id: "guest-1", content: "# Guest one", stackHost: "host-1", updatedAt: Date.now() - 10 },
    { id: "guest-2", content: "# Guest two", stackHost: "guest-1", updatedAt: Date.now() - 20 },
  ];
  return { host, guests };
}

test("pinned window loads host content from the pin query", async ({ page }) => {
  const { host, guests } = stackNotes();
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  await expect(page.locator("#blocks textarea").first()).toHaveValue(/Host memo/);
  await expect(page.locator("#note-title")).toContainText("Host memo");
});

test("stacked guests render under the host", async ({ page }) => {
  const { host, guests } = stackNotes();
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  await expect(page.locator(".stack-note")).toHaveCount(2);
  await expect(page.locator(".stack-note[data-id='guest-1']")).toContainText("Guest one");
  await expect(page.locator(".stack-note[data-id='guest-2']")).toContainText("Guest two");
});

test("fold toggle collapses the host memo", async ({ page }) => {
  const { host, guests } = stackNotes();
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  await page.locator("#fold-toggle").click();
  await expect.poll(async () => invokedCmds(page)).toContain("set_collapsed");
  await expect(page.locator("#fold-toggle")).toHaveAttribute("aria-pressed", "true");
});

test("joining a third guest auto-folds the stack", async ({ page }) => {
  const { host, guests } = stackNotes();
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  await expect(page.locator(".stack-note")).toHaveCount(2);
  await harnessSeedNotes(page, [
    host,
    ...guests,
    { id: "guest-3", content: "# Guest three", stackHost: "guest-2", updatedAt: Date.now() - 30 },
  ]);
  await emitEvent(page, "stack-changed");
  await expect(page.locator(".stack-note")).toHaveCount(3);
  await expect(page.locator("html")).toHaveClass(/collapsed/);
});

test("theme and hue controls persist look on a pinned stack", async ({ page }) => {
  const { host, guests } = stackNotes();
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  await page.locator("#theme-toggle").click();
  await expect(page.locator("#color-pop")).toBeVisible();
  await page.locator("#hue-slider").fill("200");
  await expect.poll(async () => invokedCmds(page)).toContain("save_look");
});

test("deleting a stacked guest removes it from the chain", async ({ page }) => {
  const { host, guests } = stackNotes();
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  const guest = page.locator(".stack-note[data-id='guest-2']");
  await guest.locator(".visibility-label").click();
  await guest.locator(".delete-note").click();
  await guest.locator(".delete-yes").click();
  await expect.poll(async () => invokedCmds(page)).toContain("delete_note");
  await expect(page.locator(".stack-note[data-id='guest-2']")).toHaveCount(0);
});
