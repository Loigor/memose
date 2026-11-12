import { expect, test } from "@playwright/test";

import {
  composerTextarea,
  editorText,
  invokedCmds,
  openComposer,
  openMarkdownMenu,
  revealEditorButton,
} from "./helpers";
import { emitEvent, getInvocations, sampleNotes } from "./tauri-harness";

test("empty composer shows the editor after composer-focus", async ({ page }) => {
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
  await expect.poll(() => editorText(area)).toBe("**hello**");
  await expect(page.locator(".md-row.is-live")).toHaveText("**hello**");
  await expect.poll(() => area.evaluate((el) => el.ownerDocument.getSelection()?.toString() ?? "")).toBe("hello");
  await area.blur();
  await expect(page.locator(".md-strong")).toHaveText("hello");
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
  await expect.poll(() => editorText(area)).toBe("- [x] buy milk");
});

test("undo restores the previous textarea snapshot", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await area.pressSequentially("alpha", { delay: 15 });
  await page.waitForTimeout(1100);
  await area.pressSequentially(" beta", { delay: 15 });
  await expect.poll(() => editorText(area)).toBe("alpha beta");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => editorText(area)).toBe("alpha");
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

test("markdown menu labels the block actions", async ({ page }) => {
  await openComposer(page);
  await openMarkdownMenu(page);
  await expect(page.locator("#md-toolbar button")).toHaveText([
    "Bold",
    "Italic",
    "Title",
    "List",
    "Numbered",
    "Task",
    "Quote",
    "Code block",
  ]);
  const area = await composerTextarea(page);
  await area.fill("hello");
  await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 5));
  await page.locator('#md-toolbar button[data-markdown="list"]').click();
  await expect.poll(() => editorText(area)).toBe("- hello");
});

test("clicking a memo tag opens search", async ({ page }) => {
  const notes = sampleNotes(3);
  notes[0] = { ...notes[0], content: "budget #finance ok" };
  await openComposer(page, { notes });
  const area = await composerTextarea(page);
  await area.fill("pay #finance now");
  await area.blur();
  await expect(page.locator(".md-row .md-tag")).toHaveText("#finance");
  await area.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    const at = el.value.indexOf("#finance") + 2;
    el.setSelectionRange(at, at);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.locator("#recent-search")).toBeVisible();
  await expect(page.locator("#recent-search")).toHaveValue("#finance");
  await expect(page.locator("#recent li")).toHaveCount(1);
});

test("clicking a rendered tag opens search", async ({ page }) => {
  const notes = sampleNotes(2);
  notes[0] = { ...notes[0], content: "budget #finance ok" };
  notes[1] = { ...notes[1], content: "rent #rent due" };
  await openComposer(page, { notes });
  const area = await composerTextarea(page);
  await area.fill("see **#finance** now\n- pay #rent");
  await area.blur();
  for (const name of ["#finance", "#rent"]) {
    const tag = page.locator(".md-row .md-tag", { hasText: name });
    const box = await tag.boundingBox();
    if (!box) {
      throw new Error(`missing ${name}`);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#recent-search")).toHaveValue(name);
  }
});

test("last-line tag click vs empty grow space", async ({ page }) => {
  const notes = sampleNotes(2);
  notes[0] = { ...notes[0], content: "budget #finance ok" };
  await openComposer(page, { notes });
  const area = await composerTextarea(page);
  await area.fill("#finance");
  await area.blur();
  const box = await area.boundingBox();
  if (!box) {
    throw new Error("textarea box");
  }
  await page.mouse.click(box.x + 16, box.y + box.height - 6);
  await expect(page.locator("#recent-search")).toBeHidden();
  await page.mouse.click(box.x + 28, box.y + 10);
  await expect(page.locator("#recent-search")).toBeVisible();
  await expect(page.locator("#recent-search")).toHaveValue("#finance");
  const after = await area.boundingBox();
  if (!after) {
    throw new Error("textarea box after search");
  }
  await page.mouse.move(after.x + 28, after.y + 10);
  await expect(area).toHaveCSS("cursor", "pointer");
});

test("preview tag links open search and headings stay plain", async ({ page }) => {
  const notes = sampleNotes(2);
  notes[0] = { ...notes[0], content: "budget #finance ok" };
  await openComposer(page, { notes });
  const area = await composerTextarea(page);
  await area.fill("# Title\nsee #finance and `#code`");
  const mode = page.locator("#mode-toggle");
  if (!(await mode.isVisible())) {
    await page.locator("#editor-menu-toggle").click();
  }
  await mode.click();
  await expect(page.locator("#preview")).toBeVisible();
  await expect(page.locator("#preview h1")).toContainText("Title");
  await expect(page.locator("#preview h1 .md-tag")).toHaveCount(0);
  await expect(page.locator("#preview code .md-tag")).toHaveCount(0);
  await page.locator("#preview .md-tag").click();
  await expect(page.locator("#recent-search")).toBeVisible();
  await expect(page.locator("#recent-search")).toHaveValue("#finance");
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
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toMatch(/Opened memo/);
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
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toBe("");
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
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toBe("local copy");
});

test("a new memo styles a heading while typing", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await page.keyboard.type("# Hi");
  await expect(page.locator(".md-row.is-h1.is-live")).toHaveText("# Hi");
  await expect(page.locator(".md-syntax")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(() => page.locator(".md-row.is-h1 .md-syntax").evaluate((el) => el.textContent)).toBe("# ");
});

test("a task line shows a checkbox after the caret leaves it", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await page.keyboard.type("- [ ] milk");
  await expect(page.locator(".md-check")).toHaveCount(0);
  await expect.poll(() =>
    area.evaluate((el) => {
      const node = el.ownerDocument.getSelection()?.anchorNode;
      return node?.parentElement?.classList.contains("md-syntax") === true;
    }),
  ).toBe(false);
  await page.keyboard.press("Enter");
  await expect(page.locator(".md-row").first().locator(".md-check")).toHaveCount(1);
  await expect(page.locator(".md-row.is-live")).toHaveText("- [ ]");
  await page.keyboard.type("bread");
  await page.keyboard.press("Enter");
  await expect(page.locator(".md-row").nth(0).locator(".md-check")).toHaveCount(1);
  await expect(page.locator(".md-row").nth(1).locator(".md-check")).toHaveCount(1);
  await expect(page.locator(".md-row.is-live")).toHaveText("- [ ]");
});

test("backspace at the start of a task joins it without breaking the list", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await area.fill("- [ ] milk\n- [ ] bread\n- [ ] eggs");
  const at = "- [ ] milk\n".length;
  await area.evaluate((el, pos: number) => {
    const field = el as HTMLElement & { setSelectionRange?: (start: number, end: number) => void };
    field.focus();
    field.setSelectionRange?.(pos, pos);
  }, at);
  await page.keyboard.press("Backspace");
  await expect.poll(() => editorText(area)).toBe("- [ ] milk- [ ] bread\n- [ ] eggs");
  await expect(page.locator(".md-row")).toHaveCount(2);
  await expect(page.locator(".md-row").first().locator(".md-check")).toHaveCount(0);
  await expect(page.locator(".md-row").nth(1).locator(".md-check")).toHaveCount(1);
  await expect(page.locator(".md-row span[style]")).toHaveCount(0);
});

test("deleting the first task item keeps the rest a checklist", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await area.fill("- [ ] milk\n- [ ] bread\n- [ ] eggs");
  const end = "- [ ] milk\n".length;
  await area.evaluate((el, pos: number) => {
    const field = el as HTMLElement & { setSelectionRange?: (start: number, end: number) => void };
    field.focus();
    field.setSelectionRange?.(0, pos);
  }, end);
  await page.keyboard.press("Backspace");
  await expect.poll(() => editorText(area)).toBe("- [ ] bread\n- [ ] eggs");
  await expect(page.locator(".md-row")).toHaveCount(2);
  await expect(page.locator(".md-row").nth(1).locator(".md-check")).toHaveCount(1);
  await expect(page.locator(".md-row.is-ul")).toHaveCount(0);
  await expect(page.locator(".md-row span[style]")).toHaveCount(0);
});

test("normal editor styles a heading line and keeps the markdown", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("# Title\nhello **bold**\n- [x] milk\n> note\n---\n- [x]\n**see #ship**");
  await area.blur();
  await expect(page.locator(".md-row.is-h1")).toHaveText("# Title");
  await expect(page.locator(".md-row").nth(1)).toHaveText("hello **bold**");
  await expect(page.locator(".md-row").nth(1).locator(".md-strong")).toHaveText("bold");
  await expect.poll(() => page.locator(".md-row.is-h1 .md-syntax").evaluate((el) => el.textContent)).toBe("# ");
  await expect(page.locator(".md-row.is-done").first().locator(".md-check")).toBeChecked();
  await expect(page.locator(".md-row.is-done").first().locator(".md-strike")).toHaveText("milk");
  await expect(page.locator(".md-row.is-done").first().locator(".md-strike")).toHaveCSS("text-decoration-line", "line-through");
  await expect.poll(() => page.locator(".md-row.is-quote .md-syntax").evaluate((el) => el.textContent)).toBe("> ");
  await expect(page.locator(".md-row.is-hr")).toHaveText("---");
  const bare = page.locator(".md-row.is-done").nth(1);
  await expect(bare.locator(".md-check")).toBeChecked();
  await expect(bare.locator(".md-strike")).toHaveCount(0);
  await expect.poll(() => editorText(area)).toBe("# Title\nhello **bold**\n- [x] milk\n> note\n---\n- [x]\n**see #ship**");
  await expect(page.locator(".md-strong .md-tag")).toHaveText("#ship");
  const row = page.locator(".md-row").nth(1);
  await row.evaluate((el) => {
    el.dataset.mark = "stay";
  });
  await row.click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(page.locator(".md-row[data-mark='stay']")).toHaveText("hello **bold**!");
});

test("enter splits a line and backspace at the next block leaves code", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await page.keyboard.type("there");
  await expect.poll(() => editorText(area)).toBe("hello\nthere");
  await expect(page.locator(".md-row")).toHaveCount(2);
  await area.fill("intro\n```\nconst x = 1\n```\n");
  const after = page.locator(".md-lines").last();
  await after.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".md-field[data-coder] textarea")).toHaveValue("const x = 1");
  await expect.poll(() => editorText(page.locator(".md-field[data-coder] textarea"))).toBe("const x = 1");
});

test("a long memo keeps the edited row", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  const lines = Array.from({ length: 1200 }, (_, i) => `line ${i}`);
  await area.fill(lines.join("\n"));
  await expect(page.locator(".md-row")).toHaveCount(1200);
  const row = page.locator(".md-row").nth(40);
  await row.evaluate((el) => {
    el.dataset.mark = "stay";
  });
  await row.click();
  await page.keyboard.type("Z");
  await expect(page.locator(".md-row[data-mark='stay']")).toContainText("Z");
  await expect(page.locator(".md-row")).toHaveCount(1200);
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
  const overlay = page.locator(".md-field[data-coder] .md-hl").first();
  const shared = ["padding-top", "padding-left", "line-height", "font-size", "white-space", "tab-size"] as const;
  for (const prop of shared) {
    const value = await overlay.evaluate(
      (el, name) => getComputedStyle(el).getPropertyValue(name),
      prop,
    );
    await expect(area).toHaveCSS(prop, value);
  }
  await area.fill("\thello\nhello");
  await expect(page.locator(".md-line-text").first()).toHaveCSS("white-space", "pre");
  const tabExtra = await page.locator(".md-field[data-coder]").first().evaluate((field) => {
    const lines = [...field.querySelectorAll(".md-line-text")];
    if (lines.length < 2) {
      return 0;
    }
    return lines[0].getBoundingClientRect().width - lines[1].getBoundingClientRect().width;
  });
  expect(tabExtra).toBeGreaterThan(8);
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
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toBe("");
});

test("new memo shortcut leaves the caret in the editor", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("temporary");
  await emitEvent(page, "composer-fresh", 4);
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toBe("");
  await page.keyboard.type("hi");
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toBe("hi");
});

test("a language fence becomes a highlighted code block after enter", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await page.keyboard.type("```json");
  await expect(page.locator("textarea[data-kind='code']")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".md-lang")).toHaveText("json");
  await expect(page.locator(".md-lang")).not.toHaveClass(/is-side/);
  const code = page.locator("textarea[data-kind='code']");
  await expect(code).toHaveValue("");
  await page.keyboard.type('{"a": 1}');
  await expect(page.locator(".md-hl .tok-key")).toHaveText('"a"');
  await expect(page.locator(".md-hl .tok-num")).toHaveText("1");
});

test("a brace block in a code field folds without dropping the text", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await page.keyboard.type("```json");
  await page.keyboard.press("Enter");
  const code = page.locator("textarea[data-kind='code']");
  await expect(code).toHaveValue("");
  await code.evaluate((el) => {
    el.focus();
    document.execCommand("insertText", false, '{\n  "a": 1\n}');
  });
  const fold = page.locator(".md-fold");
  await expect(fold).toHaveCount(1);
  await fold.click();
  await expect(page.locator(".md-fold-mark")).toBeVisible();
  await expect(page.locator(".md-hl")).not.toContainText('"a"');
  await expect.poll(() => code.evaluate((el) => (el as HTMLTextAreaElement).value)).toContain('"a"');
  await fold.click();
  await expect(page.locator(".md-fold-mark")).toHaveCount(0);
  await expect.poll(() => code.evaluate((el) => (el as HTMLTextAreaElement).value)).toContain('"a"');
});

test("a brace block in the coder editor folds without dropping the text", async ({ page }) => {
  await openComposer(page);
  const coder = page.locator("#coder-toggle");
  await revealEditorButton(page, coder);
  await coder.click();
  const area = await composerTextarea(page);
  await area.fill('{\n  "a": 1\n}');
  const fold = page.locator(".md-fold");
  await expect(fold).toHaveCount(1);
  await fold.click();
  await expect(page.locator(".md-fold-mark")).toBeVisible();
  await expect(page.locator(".md-hl")).not.toContainText('"a"');
  await expect.poll(() => area.evaluate((el) => (el as HTMLTextAreaElement).value)).toContain('"a"');
});

test("enter in a code block keeps the previous indent", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.click();
  await page.keyboard.type("```json");
  await page.keyboard.press("Enter");
  const code = page.locator("textarea[data-kind='code']");
  await expect(code).toHaveValue("");
  await page.keyboard.type("{");
  await page.keyboard.press("Enter");
  await expect.poll(() => code.evaluate((el) => (el as HTMLTextAreaElement).value)).toBe("{\n  ");
  await page.keyboard.type('"a": 1');
  await page.keyboard.press("Enter");
  await expect.poll(() => code.evaluate((el) => (el as HTMLTextAreaElement).value)).toBe('{\n  "a": 1\n  ');
});

test("double-clicking a coder line number marks and unmarks that line", async ({ page }) => {
  await openComposer(page);
  const coder = page.locator("#coder-toggle");
  await revealEditorButton(page, coder);
  await coder.click();
  const area = await composerTextarea(page);
  await area.fill("alpha\nbeta");
  const gutter = page.locator("#blocks .md-gutter");
  const before = await gutter.evaluate((el) => el.getBoundingClientRect().width);
  const textLeft = await area.evaluate((el) => el.getBoundingClientRect().left);
  await gutter.dblclick({ position: { x: 12, y: 10 } });
  await expect(page.locator(".md-line-ball")).toHaveCount(1);
  await expect(page.locator(".md-mark-bar")).toHaveCount(1);
  await expect.poll(() => area.evaluate((el) => (el as HTMLTextAreaElement).value)).toBe("alpha\nbeta");
  const after = await gutter.evaluate((el) => el.getBoundingClientRect().width);
  const textLeftAfter = await area.evaluate((el) => el.getBoundingClientRect().left);
  expect(after).toBe(before);
  expect(textLeftAfter).toBe(textLeft);
  await area.focus();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(page.locator(".md-line-ball")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(page.locator(".md-line-ball")).toHaveCount(1);
  await gutter.click({ position: { x: 12, y: 10 } });
  await expect(page.locator(".md-line-ball")).toHaveCount(0);
});

test("fenced code in the markdown editor uses a coder field", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("intro\n```\nconst x = 1\n```\n");
  await expect(page.locator(".md-field[data-coder] textarea")).toHaveValue("const x = 1");
  await expect(page.locator(".md-field[data-coder] .md-gutter")).toBeVisible();
  await expect(page.locator(".md-gutter-code")).toHaveCount(0);
});

test("backspace in an empty code block removes it", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("hello\n```\n\n```\nworld");
  const code = page.locator("textarea[data-kind='code']");
  await expect(code).toHaveValue("");
  await code.click();
  await page.keyboard.press("Backspace");
  await expect(page.locator("textarea[data-kind='code']")).toHaveCount(0);
  const lines = page.locator(".md-lines");
  await expect.poll(() => editorText(lines)).toBe("hello\nworld");
  await expect.poll(() => lines.evaluate((el) => (el as HTMLElement & { selectionStart?: number }).selectionStart ?? -1)).toBe("hello".length);
});

test("backspace at the start of a nonempty code block leaves it", async ({ page }) => {
  await openComposer(page);
  const area = await composerTextarea(page);
  await area.fill("hello\n```\nkeep\n```\n");
  const code = page.locator("textarea[data-kind='code']");
  await code.evaluate((el) => {
    el.focus();
    el.setSelectionRange(0, 0);
  });
  await page.keyboard.press("Backspace");
  await expect(code).toHaveValue("keep");
});

test("a code block in the coder editor keeps both line numbers", async ({ page }) => {
  await openComposer(page);
  const coder = page.locator("#coder-toggle");
  await revealEditorButton(page, coder);
  await coder.click();
  const area = await composerTextarea(page);
  await area.fill("intro\n```json\nconst x = 1\nline 2\n```\nbeta");
  const noteNumbers = () =>
    page.locator("#blocks .md-gutter:not(.md-gutter-code)").evaluateAll((els) => els.map((el) => el.textContent));
  const codeNumbers = () => page.locator("#blocks .md-gutter-code").evaluateAll((els) => els.map((el) => el.textContent));
  await expect.poll(noteNumbers).toEqual(["1", "2\n3", "4"]);
  await expect.poll(codeNumbers).toEqual(["1\n2"]);
  const primary = page.locator("#blocks .md-field:has(textarea[data-kind='code']) .md-gutter:not(.md-gutter-code)");
  const local = page.locator("#blocks .md-gutter-code");
  const primaryColor = await primary.evaluate((el) => getComputedStyle(el).color);
  const localColor = await local.evaluate((el) => getComputedStyle(el).color);
  expect(localColor).not.toBe(primaryColor);
  const badge = page.locator(".md-lang");
  await expect(badge).toHaveText("json");
  await expect(badge).toHaveClass(/is-side/);
  const places = await page.evaluate(() => {
    const label = document.querySelector(".md-lang")!.getBoundingClientRect();
    const field = document.querySelector(".md-field:has(textarea[data-kind='code'])")!.getBoundingClientRect();
    const main = document.querySelector(".md-field:has(textarea[data-kind='code']) .md-gutter:not(.md-gutter-code)")!.getBoundingClientRect();
    const local = document.querySelector(".md-gutter-code")!.getBoundingClientRect();
    const code = document.querySelector("textarea[data-kind='code']")!.getBoundingClientRect();
    return {
      labelTop: label.top,
      labelBottom: label.bottom,
      fieldTop: field.top,
      mainRight: main.right,
      localLeft: local.left,
      codeLeft: code.left,
      border: getComputedStyle(document.querySelector(".md-gutter-code")!).borderLeftWidth,
    };
  });
  expect(places.labelTop).toBeLessThan(places.fieldTop);
  expect(places.labelBottom).toBeGreaterThan(places.fieldTop);
  expect(places.localLeft - places.mainRight).toBeLessThan(8);
  expect(places.codeLeft).toBeGreaterThan(places.localLeft);
  expect(places.border).toBe("1px");
  await primary.dblclick({ position: { x: 12, y: 14 } });
  await expect(page.locator(".md-line-ball")).toHaveCount(1);
  const marked = await page.evaluate(() => {
    const bar = document.querySelector(".md-mark-bar")!.getBoundingClientRect();
    const local = document.querySelector(".md-gutter-code")!.getBoundingClientRect();
    const ball = document.querySelector(".md-line-ball")!.getBoundingClientRect();
    const main = document.querySelector(".md-field:has(textarea[data-kind='code']) .md-gutter:not(.md-gutter-code)")!.getBoundingClientRect();
    return { barLeft: bar.left, localLeft: local.left, localRight: local.right, ballLeft: ball.left, mainLeft: main.left, mainRight: main.right };
  });
  expect(marked.barLeft).toBeLessThanOrEqual(marked.localLeft + 1);
  expect(marked.ballLeft).toBeGreaterThanOrEqual(marked.mainLeft - 1);
  expect(marked.ballLeft).toBeLessThan(marked.mainRight);
  const lefts = await page.evaluate(() => {
    const text = document.querySelector("#blocks textarea:not([data-kind='code'])");
    const code = document.querySelector("textarea[data-kind='code']");
    return {
      text: text?.getBoundingClientRect().left ?? 0,
      code: code?.getBoundingClientRect().left ?? 0,
    };
  });
  expect(lefts.code).toBeGreaterThan(lefts.text);
  const first = page.locator("#blocks textarea").first();
  await first.evaluate((el) => {
    const field = el as HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("more");
  await expect.poll(noteNumbers).toEqual(["1\n2", "3\n4", "5"]);
  await expect.poll(codeNumbers).toEqual(["1\n2"]);
});

test("cycling to the last memo restores the caret", async ({ page }) => {
  const notes = sampleNotes(1);
  notes[0] = { ...notes[0], content: "abcdefghij", winW: 640, winH: 800 };
  await openComposer(page, { notes });
  await emitEvent(page, "composer-cycle", 2);
  const area = await composerTextarea(page);
  await expect.poll(() => editorText(area)).toBe("abcdefghij");
  await expect.poll(async () => {
    const calls = await getInvocations(page);
    return [...calls].reverse().find((item) => item.cmd === "apply_composer_size")?.args;
  }).toEqual({ width: 640, height: 800 });
  await expect.poll(async () => {
    const calls = await getInvocations(page);
    const applyAt = calls.reduce(
      (index, item, at) => (item.cmd === "apply_composer_size" ? at : index),
      -1,
    );
    return calls.slice(applyAt).some((item) => item.cmd === "slide_into_view");
  }).toBe(true);
  await area.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new Event("select"));
  });
  await emitEvent(page, "composer-cycle", 3);
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toBe("");
  await expect.poll(async () => {
    const calls = await getInvocations(page);
    return [...calls].reverse().find((item) => item.cmd === "apply_composer_size")?.args;
  }).toEqual({ width: null, height: null });
  await emitEvent(page, "composer-cycle", 4);
  const again = await composerTextarea(page);
  await expect.poll(() => editorText(again)).toBe("abcdefghij");
  await expect.poll(async () => again.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(3);
});
