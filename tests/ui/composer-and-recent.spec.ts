import { expect, test } from "@playwright/test";

import {
  composerTextarea,
  invokedCmds,
  openComposer,
  openMarkdownMenu,
  revealEditorButton,
} from "./helpers";
import { emitEvent, sampleNotes } from "./tauri-harness";

test("empty composer shows a textarea after composer-focus", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await expect(area).toBeVisible();
  await expect(area).toHaveAttribute("placeholder", "Write a note…");
});

test("typing a draft calls upsert_draft", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("hello draft");
  await expect.poll(async () => invokedCmds(page)).toContain("upsert_draft");
});

test("markdown toolbar wraps the current selection", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("hello");
  await area.press("ControlOrMeta+A");
  await openMarkdownMenu(page);
  await expect(page.locator("#md-toolbar")).toBeVisible();
  await page.locator('#md-toolbar button[data-markdown="bold"]').click();
  await expect(area).toHaveValue("**hello**");
  await expect(page.locator("#md-toolbar")).toBeVisible();
});

test("preview toggle renders tasks and clicking a checkbox updates markdown", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("- [ ] buy milk");
  const mode = page.locator("#mode-toggle");
  if (!(await mode.isVisible())) {
    await page.locator("#editor-menu-toggle").click();
  }
  await mode.click();
  await expect(page.locator("#preview")).toBeVisible();
  const box = page.locator("#preview input[type='checkbox']");
  await expect(box).toBeVisible();
  await box.click();
  await mode.click();
  await expect(area).toHaveValue("- [x] buy milk");
});

test("undo restores the previous textarea snapshot", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await area.pressSequentially("alpha", { delay: 15 });
  await page.waitForTimeout(1100);
  await area.pressSequentially(" beta", { delay: 15 });
  await expect(area).toHaveValue("alpha beta");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(area).toHaveValue("alpha");
});

test("recent list collapses to three rows and expands on More", async ({ page }) => {
  await openComposer(page, { notes: sampleNotes(5) });
  const rows = page.locator("#recent li");
  await expect(rows).toHaveCount(3);
  await expect(page.locator("#recent-more")).toHaveText("More");
  await page.locator("#recent-more").click();
  await expect(rows).toHaveCount(5);
  await expect(page.locator("#recent-search")).toBeVisible();
  await expect(page.locator("#recent-more")).toHaveText("Less");
});

test("recent search filters titles and shows an empty state", async ({ page }) => {
  await openComposer(page, { notes: sampleNotes(5, "Memo") });
  await page.locator("#recent-more").click();
  await page.locator("#recent-search").fill("unique-2");
  const rows = page.locator("#recent li");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator(".title")).toContainText("unique-2");
  await page.locator("#recent-search").fill("zzz-no-hit");
  await expect(page.locator("#recent li.empty")).toHaveText("No matches");
});

test("opening a recent memo loads it into the editor", async ({ page }) => {
  const notes = sampleNotes(4);
  notes[1] = { ...notes[1], content: "# Opened memo\nKeep this body" };
  await openComposer(page, { notes });
  await page.locator("#recent-more").click();
  await page.locator("#recent .title", { hasText: "Opened memo" }).click();
  await expect(page.locator("#blocks textarea").first()).toHaveValue(/Opened memo/);
  await expect(page.locator("#recent li.selected")).toHaveCount(1);
});

test("pinning from the recent list invokes set_pinned", async ({ page }) => {
  await openComposer(page, { notes: sampleNotes(4) });
  await page.locator("#recent li").first().locator("button.pin").click();
  await expect.poll(async () => invokedCmds(page)).toContain("set_pinned");
});

test("visibility picker offers Public and records the audience", async ({ page }) => {
  await openComposer(page, { notes: sampleNotes(1) });
  await page.locator("#recent .title").first().click();
  await page.locator("#visibility-label").click();
  await page.locator(".audience-choice", { hasText: "Public" }).click();
  await expect.poll(async () => invokedCmds(page)).toContain("set_note_audience");
  await expect(page.locator("#visibility-label")).toHaveText("Public");
});

test("delete confirmation removes the open memo", async ({ page }) => {
  const notes = sampleNotes(2);
  notes[0] = { ...notes[0], content: "Delete me please" };
  await openComposer(page, { notes });
  await page.locator("#recent .title", { hasText: "Delete me please" }).click();
  await page.locator("#visibility-label").click();
  await page.locator("#delete-note").click();
  await expect(page.locator("#delete-confirm")).toBeVisible();
  await page.locator("#delete-yes").click();
  await expect.poll(async () => invokedCmds(page)).toContain("delete_note");
  await expect(page.locator("#blocks textarea").first()).toHaveValue("");
});

test("conflict banner resolves Keep this", async ({ page }) => {
  await openComposer(page, {
    notes: [
      {
        id: "conflict-1",
        content: "local copy",
        syncState: "conflict",
        serverContent: "server copy",
        updatedAt: Date.now(),
      },
    ],
  });
  await page.locator("#recent .title").first().click();
  await expect(page.locator("#conflict")).toBeVisible();
  await page.locator("#conflict-local").click();
  await expect.poll(async () => invokedCmds(page)).toContain("resolve_conflict");
  await expect(page.locator("#conflict")).toBeHidden();
  await expect(page.locator("#blocks textarea").first()).toHaveValue("local copy");
});

test("markdown highlight paints headings and emphasis", async ({ page }) => {
  await openComposer(page);
  await expect(page.locator("html")).toHaveAttribute("data-mdhl", "");
  const area = await composerTextarea(page);
  await area.fill("# Title\nhello **bold**");
  await expect(page.locator(".md-heading")).toContainText("# Title");
  await expect(page.locator(".md-strong")).toContainText("**bold**");
  await area.press("ControlOrMeta+A");
  await expect(page.locator(".md-heading")).toContainText("# Title");
  await expect(page.locator(".md-hl").first()).toHaveCSS("visibility", "visible");
});

test("coder toggle shows a line gutter on that memo", async ({ page }) => {
  await openComposer(page);
  await expect(page.locator("#card")).not.toHaveAttribute("data-coder");
  const coder = page.locator("#coder-toggle");
  await revealEditorButton(page, coder);
  await expect(page.locator("#format-toggle")).toBeHidden();
  await coder.click();
  await expect(page.locator("#card")).toHaveAttribute("data-coder", "");
  const format = page.locator("#format-toggle");
  await revealEditorButton(page, format);
  await expect(format).toBeVisible();
  const area = await composerTextarea(page);
  await area.fill("alpha\nbeta");
  await expect(page.locator(".md-gutter")).toBeVisible();
  await expect(page.locator(".md-gutter")).toHaveText("1\n2");
  await area.press("ControlOrMeta+A");
  await expect(page.locator(".md-hl").first()).toHaveCSS("visibility", "visible");
  await expect(page.locator("#coder-toggle")).toHaveText("{ }");
  await area.fill(`${"w".repeat(240)}\nshort`);
  await expect(page.locator(".md-line-text.is-long")).toHaveCount(1);
  await expect(page.locator(".md-overflow-dot")).toHaveCount(1);
  await format.click();
  await page.locator('#format-pop button[data-format="wrap"]').click();
  await expect(page.locator("#card")).toHaveAttribute("data-wrap", "");
  await expect(page.locator(".md-overflow-dot")).toHaveCount(0);
});

test("format json pretty-prints the memo", async ({ page }) => {
  await openComposer(page);
  const coder = page.locator("#coder-toggle");
  await revealEditorButton(page, coder);
  await coder.click();
  const area = await composerTextarea(page);
  await area.fill('{"a":1}');
  const format = page.locator("#format-toggle");
  await revealEditorButton(page, format);
  await format.click();
  await page.locator('#format-pop button[data-format="document"]').click();
  await expect(area).toHaveValue('{\n  "a": 1\n}');
  await area.fill("if (x) {\ny=1\n}");
  await format.click();
  await page.locator('#format-pop button[data-format="document"]').click();
  await expect(area).toHaveValue("if (x) {\n  y=1\n}");
});

test("composer-fresh clears the editor", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("temporary");
  await emitEvent(page, "composer-fresh", 2);
  await expect(area).toHaveValue("");
});
