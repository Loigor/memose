import { expect, test } from "@playwright/test";

import { editorText, invokedCmds, openPinned } from "./helpers";
import { emitEvent, getNotes, harnessSeedNotes, type NoteSeed } from "./tauri-harness";

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

test("a stacked coder memo keeps its own language", async ({ page }) => {
  const { host, guests } = stackNotes();
  guests[0] = { ...guests[0], content: "fn main() {\n    let x = 1;\n}", coder: true, codeLang: "rust" };
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  const section = page.locator(".stack-note[data-id='guest-1']");
  await expect(section).toHaveAttribute("data-code-lang", "rust");
  await expect(section.locator(".tok-kw", { hasText: "let" })).toBeVisible();
  const format = section.locator(".format-toggle");
  if (!(await format.isVisible())) {
    await section.locator(".editor-menu-toggle").click();
  }
  await format.click();
  await expect(section.locator('.format-pop button[data-format="lang"]')).toContainText("Rust");
  await section.locator('.format-pop button[data-format="lang"]').click();
  await section.locator(".format-pop [data-lang-choice='python']").click();
  await expect(section).toHaveAttribute("data-code-lang", "python");
  await expect(section.locator(".tok-kw", { hasText: "let" })).toHaveCount(0);
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "guest-1")?.codeLang).toBe("python");
  await expect(page.locator("#card")).not.toHaveAttribute("data-code-lang");
});

test("cmd/ctrl plus resizes only the stacked memo being edited", async ({ page }) => {
  const { host, guests } = stackNotes();
  await openPinned(page, "host-1", { notes: [host, ...guests] });
  const guest = page.locator(".stack-note[data-id='guest-1']");
  await guest.locator(".md-lines").first().click();
  await page.keyboard.press("ControlOrMeta+=");
  await page.keyboard.press("ControlOrMeta+=");
  await expect(guest.locator(".md-lines").first()).toHaveCSS("font-size", "18px");
  await expect(page.locator("#blocks .md-lines").first()).toHaveCSS("font-size", "16px");
  await expect(page.locator(".stack-note[data-id='guest-2'] .md-lines").first()).toHaveCSS("font-size", "16px");
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "guest-1")?.fontStep).toBe(2);
});

function pinnedMemo(): NoteSeed {
  return { id: "solo-1", content: "# Solo memo\nSome body text here", pinned: true, updatedAt: Date.now() };
}

async function invocationsOf(page: import("@playwright/test").Page, cmd: string) {
  return page.evaluate(
    (name) => (window.__memoseHarness?.getInvocations() ?? []).filter((item) => item.cmd === name).map((i) => i.args),
    cmd,
  );
}

/** The window is not the active one, as for a pinned memo the user has not picked yet. */
async function unselect(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
  });
}

test("dragging a top-bar button moves the memo and does not click it", async ({ page }) => {
  await openPinned(page, "solo-1", { notes: [pinnedMemo()] });
  const fold = page.locator("#fold-toggle");
  await expect(fold).toHaveAttribute("aria-pressed", "false");
  const box = (await fold.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 6, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => invokedCmds(page)).toContain("begin_memo_drag");
  expect(await invokedCmds(page)).not.toContain("set_collapsed");
  await expect(fold).toHaveAttribute("aria-pressed", "false");
});

test("a top-bar button pressed in place still clicks", async ({ page }) => {
  await openPinned(page, "solo-1", { notes: [pinnedMemo()] });
  await page.locator("#fold-toggle").click();
  await expect.poll(async () => invokedCmds(page)).toContain("set_collapsed");
  expect(await invokedCmds(page)).not.toContain("begin_memo_drag");
});

test("an unselected pinned memo moves when dragged by its text", async ({ page }) => {
  await openPinned(page, "solo-1", { notes: [pinnedMemo()] });
  const text = page.locator("#blocks .md-lines").first();
  await expect.poll(() => editorText(text)).toMatch(/Some body text/);
  await unselect(page);
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + box.height / 2 + 4, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => invokedCmds(page)).toContain("begin_memo_drag");
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("a click on an unselected pinned memo puts the caret in its text", async ({ page }) => {
  await openPinned(page, "solo-1", { notes: [pinnedMemo()] });
  const text = page.locator("#blocks .md-lines").first();
  await expect.poll(() => editorText(text)).toMatch(/Some body text/);
  await unselect(page);
  const box = (await text.boundingBox())!;
  await page.mouse.click(box.x + 40, box.y + box.height - 6);
  expect(await invokedCmds(page)).not.toContain("begin_memo_drag");
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("md-lines"))).toBe(true);
});

test("a pinned memo that is not being edited is 30 points more transparent", async ({ page }) => {
  await openPinned(page, "solo-1", { notes: [{ ...pinnedMemo(), opacity: 90 }] });
  const alpha = () =>
    page.locator("#card").evaluate((card) => {
      const probe = document.createElement("div");
      probe.style.color = getComputedStyle(card).backgroundColor;
      document.body.append(probe);
      const canvas = document.createElement("canvas").getContext("2d")!;
      canvas.fillStyle = getComputedStyle(probe).color;
      canvas.fillRect(0, 0, 1, 1);
      probe.remove();
      return Math.round((canvas.getImageData(0, 0, 1, 1).data[3] / 255) * 100);
    });
  await page.locator("#blocks .md-lines").first().click();
  await expect(page.locator("#card")).toHaveClass(/is-editing/);
  await expect.poll(alpha).toBe(90);
  await unselect(page);
  await expect(page.locator("#card")).not.toHaveClass(/is-editing/);
  await expect.poll(alpha).toBe(60);
});

test("resize bands hug the card edge and leave the outer gutter alone", async ({ page }) => {
  await openPinned(page, "solo-1", { notes: [pinnedMemo()] });
  const width = page.viewportSize()!.width;
  // Outer gutter, well above the card: no resize.
  await page.mouse.click(width / 2, 4);
  expect(await invocationsOf(page, "begin_corner_resize")).toEqual([]);
  // Just above the card's top edge: resize from the top.
  await page.mouse.move(width / 2, 20);
  await page.mouse.down();
  await page.mouse.up();
  await expect
    .poll(() => invocationsOf(page, "begin_corner_resize"))
    .toContainEqual(expect.objectContaining({ edge: "n" }));
  // The header just inside the card drags instead.
  await page.mouse.move(width / 2, 34);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => invokedCmds(page)).toContain("begin_memo_drag");
});

test("a save in another memo does not reload this pinned window", async ({ page }) => {
  await openPinned(page, "solo-1", {
    notes: [pinnedMemo(), { id: "other-1", content: "# Other", pinned: true, updatedAt: Date.now() }],
  });
  await expect.poll(() => editorText(page.locator("#blocks .md-lines").first())).toMatch(/Some body text/);
  const before = (await invocationsOf(page, "get_note")).length;
  await emitEvent(page, "notes-changed", "other-1");
  await page.waitForTimeout(150);
  expect((await invocationsOf(page, "get_note")).length).toBe(before);
  await emitEvent(page, "notes-changed", "solo-1");
  await expect.poll(async () => (await invocationsOf(page, "get_note")).length).toBeGreaterThan(before);
});

test("a pinned window in a dark app never paints a light frame", async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as { __memoseAppTheme?: string; __themesSeen?: string[] }).__memoseAppTheme = "dark";
    (globalThis as { __themesSeen?: string[] }).__themesSeen = seen;
    new MutationObserver(() => {
      const theme = document.documentElement.dataset.theme;
      if (theme && seen.at(-1) !== theme) {
        seen.push(theme);
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
  });
  await openPinned(page, "solo-1", { notes: [pinnedMemo()], theme: "dark" });
  await expect(page.locator("html")).not.toHaveClass(/memo-loading/);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => (globalThis as { __themesSeen?: string[] }).__themesSeen)).toEqual(["dark"]);
});
