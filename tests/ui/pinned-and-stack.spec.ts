import { expect, test } from "@playwright/test";

import { editorText, invokedCmds, openPinned } from "./helpers";
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
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toMatch(/Host memo/);
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
  await page.mouse.move(0, 0);
  await page.locator("#fold-toggle").hover();
  await page.locator("#fold-toggle").click();
  await expect(page.locator("#fold-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).not.toHaveClass(/collapsed/);
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
  await page.locator("#hue-add").click();
  await expect.poll(async () => invokedCmds(page)).toContain("save_hue_swatches");
  await expect(page.locator("#hue-slots .hue-slot").first()).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
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
