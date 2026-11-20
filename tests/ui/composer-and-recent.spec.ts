import { expect, test } from "@playwright/test";

import {
  composerTextarea,
  editorText,
  invokedCmds,
  openComposer,
  openMarkdownMenu,
  revealEditorButton,
} from "./helpers";
import { emitEvent, getInvocations, getNotes, sampleNotes } from "./tauri-harness";

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
  await expect
    .poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first()))
    .toMatch(/Opened memo/);
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
  await expect
    .poll(() =>
      area.evaluate((el) => {
        const node = el.ownerDocument.getSelection()?.anchorNode;
        return node?.parentElement?.classList.contains("md-syntax") === true;
      }),
    )
    .toBe(false);
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
  await expect(page.locator(".md-row.is-done").first().locator(".md-strike")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  await expect.poll(() => page.locator(".md-row.is-quote .md-syntax").evaluate((el) => el.textContent)).toBe("> ");
  await expect(page.locator(".md-row.is-hr")).toHaveText("---");
  const bare = page.locator(".md-row.is-done").nth(1);
  await expect(bare.locator(".md-check")).toBeChecked();
  await expect(bare.locator(".md-strike")).toHaveCount(0);
  await expect
    .poll(() => editorText(area))
    .toBe("# Title\nhello **bold**\n- [x] milk\n> note\n---\n- [x]\n**see #ship**");
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
    const value = await overlay.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), prop);
    await expect(area).toHaveCSS(prop, value);
  }
  await area.fill("\thello\nhello");
  await expect(page.locator(".md-line-text").first()).toHaveCSS("white-space", "pre");
  const tabExtra = await page
    .locator(".md-field[data-coder]")
    .first()
    .evaluate((field) => {
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
  const wrap = page.locator('#format-pop button[data-format="wrap"]');
  await expect(wrap.locator(".format-check")).toBeVisible();
  await wrap.click();
  await expect(page.locator("#card")).toHaveAttribute("data-wrap", "");
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".md-overflow-dot")).toHaveCount(0);
});

test("cmd/ctrl plus, minus and zero resize one memo and keep every layer aligned", async ({ page }) => {
  const notes = sampleNotes(1);
  const code = Array.from({ length: 90 }, (_, i) =>
    i % 10 === 0 ? `if (x${i}) {` : i % 10 === 9 ? "}" : `  call(${i});`,
  );
  notes[0] = { ...notes[0], content: code.join("\n"), coder: true };
  await openComposer(page, { notes });
  await page.locator("#recent .title", { hasText: "if (x0)" }).click();
  const area = page.locator("#blocks textarea").first();
  await area.click();
  const metrics = () =>
    page.evaluate(() => {
      const area = document.querySelector<HTMLTextAreaElement>("#blocks textarea")!;
      const field = area.closest(".md-field")!;
      const hl = field.querySelector<HTMLElement>(".md-hl")!;
      const top = area.getBoundingClientRect().top;
      const lineTop = (index: number) => {
        const text = hl.querySelectorAll(".md-line-text")[index]!;
        return text.getBoundingClientRect().top - top;
      };
      const gutterBody = field.querySelector(".md-gutter-body")!.firstChild!;
      const numberTop = (index: number) => {
        const offset = (gutterBody.textContent ?? "").split("\n").slice(0, index).join("\n").length + (index ? 1 : 0);
        const range = document.createRange();
        range.setStart(gutterBody, offset);
        range.setEnd(gutterBody, offset + 1);
        return range.getBoundingClientRect().top - top;
      };
      const fold = [...field.querySelectorAll<HTMLElement>(".md-fold")].find((button) => button.dataset.line === "80");
      return {
        font: getComputedStyle(area).fontSize,
        line: getComputedStyle(area).lineHeight,
        hlLine: getComputedStyle(hl).lineHeight,
        textDrift: lineTop(89) - lineTop(0) - 89 * Number.parseFloat(getComputedStyle(area).lineHeight),
        numberDrift: numberTop(89) - lineTop(89) - (numberTop(0) - lineTop(0)),
        foldDrift: fold ? fold.getBoundingClientRect().top - top - (lineTop(80) - lineTop(0)) - 6 : null,
      };
    });
  const base = await metrics();
  expect(base).toMatchObject({ font: "13px", line: "19px", hlLine: "19px" });
  await page.keyboard.press("ControlOrMeta+=");
  await page.keyboard.press("ControlOrMeta+=");
  await page.keyboard.press("ControlOrMeta+=");
  await expect.poll(async () => (await metrics()).font).toBe("16px");
  const zoomed = await metrics();
  expect(zoomed.line).toBe("23px");
  expect(zoomed.hlLine).toBe("23px");
  expect(Math.abs(zoomed.textDrift)).toBeLessThan(0.5);
  expect(Math.abs(zoomed.numberDrift)).toBeLessThan(0.5);
  expect(Math.abs(zoomed.foldDrift ?? 99)).toBeLessThan(0.5);
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "note-0000")?.fontStep).toBe(3);
  await page.keyboard.press("ControlOrMeta+-");
  await expect.poll(async () => (await metrics()).font).toBe("15px");
  await page.keyboard.press("ControlOrMeta+0");
  await expect.poll(async () => (await metrics()).font).toBe("13px");
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "note-0000")?.fontStep).toBe(0);
});

test("pressing past the smallest size never delays growing again", async ({ page }) => {
  const notes = sampleNotes(1);
  notes[0] = { ...notes[0], content: "const a = 1;", coder: true };
  await openComposer(page, { notes });
  await page.locator("#recent .title").first().click();
  const area = page.locator("#blocks textarea").first();
  await area.click();
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("ControlOrMeta+-");
  }
  await expect(area).toHaveCSS("font-size", "8px");
  await page.keyboard.press("ControlOrMeta+=");
  await expect(area).toHaveCSS("font-size", "9px");
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "note-0000")?.fontStep).toBe(-4);
});

test("cmd/ctrl minus shrinks the normal editor on whole-pixel lines", async ({ page }) => {
  const notes = sampleNotes(1);
  notes[0] = { ...notes[0], content: "Plain words\nand more" };
  await openComposer(page, { notes });
  await page.locator("#recent .title").first().click();
  const lines = page.locator("#blocks .md-lines").first();
  await expect(lines).toHaveCSS("font-size", "16px");
  await expect(lines).toHaveCSS("line-height", "22px");
  await lines.click();
  await page.keyboard.press("ControlOrMeta+-");
  await page.keyboard.press("ControlOrMeta+-");
  await expect(lines).toHaveCSS("font-size", "14px");
  await expect(lines).toHaveCSS("line-height", "20px");
  await expect(lines).toContainText("Plain words");
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "note-0000")?.fontStep).toBe(-2);
});

test("changing the default text sizes moves default and zoomed memos alike", async ({ page }) => {
  const notes = sampleNotes(1);
  notes[0] = { ...notes[0], content: "const a = 1;", coder: true, fontStep: 2 };
  await openComposer(page, { notes });
  await page.locator("#recent .title").first().click();
  const area = page.locator("#blocks textarea").first();
  await expect(area).toHaveCSS("font-size", "15px");
  await emitEvent(page, "editor-prefs-changed", {
    coderEditor: false,
    markdownHighlight: true,
    markdownScheme: "paper",
    indentWidth: 2,
    memoFontSize: 18,
    codeFontSize: 15,
  });
  await expect(area).toHaveCSS("font-size", "17px");
  await expect(area).toHaveCSS("line-height", "25px");
  await expect(page.locator("#blocks .md-gutter").first()).toHaveCSS("line-height", "25px");
});

test("long-line dots mark exactly the lines that overflow, also after a resize", async ({ page }) => {
  const notes = sampleNotes(1);
  notes[0] = {
    ...notes[0],
    content: Array.from({ length: 10 }, (_, i) => "x".repeat(30 + i * 8)).join("\n"),
    coder: true,
  };
  await openComposer(page, { notes });
  await page.locator("#recent .title").first().click();
  const lines = () =>
    page
      .locator(".md-field[data-coder] .md-hl")
      .first()
      .evaluate((hl) => {
        const style = getComputedStyle(hl);
        const inner = hl.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
        const texts = [...hl.querySelectorAll(".md-line-text")];
        return {
          overflowing: texts.flatMap((text, i) => (text.getBoundingClientRect().width > inner + 1 ? [i] : [])),
          marked: texts.flatMap((text, i) => (text.classList.contains("is-long") ? [i] : [])),
          dots: hl.parentElement?.querySelectorAll(".md-overflow-dot").length ?? 0,
        };
      });
  for (const width of [520, 380, 620]) {
    await page.setViewportSize({ width, height: 720 });
    await expect
      .poll(async () => {
        const seen = await lines();
        return (
          seen.overflowing.length > 0 &&
          seen.marked.join() === seen.overflowing.join() &&
          seen.dots === seen.marked.length
        );
      })
      .toBe(true);
  }
});

test("line wrap shows a long line and enter still adds one break", async ({ page }) => {
  await openComposer(page);
  const coder = page.locator("#coder-toggle");
  await revealEditorButton(page, coder);
  await coder.click();
  const format = page.locator("#format-toggle");
  await revealEditorButton(page, format);
  await format.click();
  await page.locator('#format-pop button[data-format="wrap"]').click();
  const area = await composerTextarea(page);
  await area.click();
  const long = "w".repeat(120);
  await area.pressSequentially(long, { delay: 1 });
  await expect.poll(() => area.evaluate((el) => (el as HTMLTextAreaElement).value)).toBe(long);
  await expect(page.locator(".md-gutter-n")).toHaveText(["1"]);
  await page.keyboard.press("Enter");
  await expect.poll(() => area.evaluate((el) => (el as HTMLTextAreaElement).value)).toBe(`${long}\n`);
  await expect(page.locator(".md-gutter-n")).toHaveText(["1", "2"]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>(".md-gutter-n")];
        return rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : 0;
      }),
    )
    .toBeGreaterThan(24);
  const first = page.locator(".md-gutter-n").first();
  const height = await first.evaluate((el) => el.getBoundingClientRect().height);
  await first.dblclick({ position: { x: 8, y: height - 4 } });
  await expect(page.locator(".md-line-ball")).toHaveCount(1);
  const ballTop = await page
    .locator(".md-line-ball")
    .evaluate((el) => Number.parseFloat((el as HTMLElement).style.top));
  expect(ballTop).toBeLessThan(height);
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

test("line wrap, a fold, and a line mark reopen with the memo", async ({ page }) => {
  const notes = sampleNotes(2);
  const body = 'keep\n{\n  "a": 1\n}';
  notes[0] = { ...notes[0], content: body, coder: true, lineWrap: true, folds: [[1]], marks: [[0]] };
  await openComposer(page, { notes });
  await page.locator("#recent .title", { hasText: "keep" }).click();
  await expect(page.locator("#card")).toHaveAttribute("data-coder", "");
  await expect(page.locator("#card")).toHaveAttribute("data-wrap", "");
  await expect(page.locator(".md-line-ball")).toHaveCount(1);
  await expect(page.locator(".md-fold-mark")).toBeVisible();
  const area = page.locator("#blocks textarea");
  await expect.poll(() => area.evaluate((el) => (el as HTMLTextAreaElement).value)).toContain('"a"');
  const format = page.locator("#format-toggle");
  await revealEditorButton(page, format);
  await format.click();
  await page.locator('#format-pop button[data-format="wrap"]').click();
  await expect(page.locator("#card")).not.toHaveAttribute("data-wrap", "");
  await expect
    .poll(async () => {
      const stored = await getNotes(page);
      return stored.find((note) => note.id === "note-0000");
    })
    .toMatchObject({ lineWrap: false, folds: [[1]], marks: [[0]] });
});

test("resizing refits wrapped coder text live and repaints overlays when it settles", async ({ page }) => {
  const notes = sampleNotes(2);
  const prose = Array.from(
    { length: 12 },
    (_, i) => `Line ${i} with enough words to wrap in a narrow memo window`,
  ).join("\n");
  const code = Array.from({ length: 8 }, (_, i) => `const value${i} = compute(${i}, "a fairly long argument");`).join(
    "\n",
  );
  notes[0] = { ...notes[0], content: prose, coder: true, lineWrap: true };
  notes[1] = { ...notes[1], content: code, coder: true };
  await openComposer(page, { notes });
  await page.locator("#recent .title", { hasText: "Line 0" }).click();
  const area = page.locator("#blocks textarea").first();
  const before = await area.evaluate((el) => el.getBoundingClientRect().height);
  await page.setViewportSize({ width: 300, height: 720 });
  // Wrapped prose grows on the next frame, without waiting for the resize to settle.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const during = await area.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    fits: el.scrollHeight <= el.clientHeight + 1,
  }));
  expect(during.height).toBeGreaterThan(before);
  expect(during.fits).toBe(true);
  await page.setViewportSize({ width: 520, height: 720 });
  await page.locator("#recent .title", { hasText: "const value0" }).click();
  await expect(page.locator("#blocks .md-overflow-dot")).toHaveCount(0);
  await page.setViewportSize({ width: 300, height: 720 });
  // Long-line markers are layout work that waits for the drag to end.
  await expect(page.locator("#blocks .md-overflow-dot")).toHaveCount(8);
  await expect(page.locator("#blocks .md-gutter-body").first()).toHaveText(/^1\n2\n3/);
});

test("the coder editor detects, picks, and stores the memo language", async ({ page }) => {
  const notes = sampleNotes(3);
  notes[0] = { ...notes[0], content: "def go(x):\n    return x + 1", coder: true };
  notes[1] = { ...notes[1], content: "# Plan\nNote: call Bob\n- item", coder: true, codeLang: null };
  notes[2] = { ...notes[2], content: "SELECT 1", coder: true, codeLang: "python" };
  await openComposer(page, { notes });
  await page.locator("#recent .title", { hasText: "def go" }).click();
  await expect(page.locator("#blocks .tok-kw", { hasText: "def" })).toBeVisible();
  await expect(page.locator("#card")).not.toHaveAttribute("data-code-lang");
  const format = page.locator("#format-toggle");
  await revealEditorButton(page, format);
  await format.click();
  const language = page.locator('#format-pop button[data-format="lang"]');
  await expect(language).toContainText("Auto · Python");
  await language.click();
  await expect(page.locator("#format-pop .format-langs")).toBeVisible();
  await page.locator("#format-pop [data-lang-choice='go']").click();
  await expect(page.locator("#format-pop")).toBeHidden();
  await expect(page.locator("#card")).toHaveAttribute("data-code-lang", "go");
  await expect(page.locator("#blocks .tok-kw", { hasText: "return" })).toBeVisible();
  await expect(page.locator("#blocks .tok-kw", { hasText: "def" })).toHaveCount(0);
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "note-0000")?.codeLang).toBe("go");
  await format.click();
  await language.click();
  await page.locator("#format-pop [data-lang-choice='']").click();
  await expect(page.locator("#card")).not.toHaveAttribute("data-code-lang");
  await expect.poll(async () => (await getNotes(page)).find((note) => note.id === "note-0000")?.codeLang).toBe(null);
  // Plain notes in a coder memo stay markdown under auto-detect.
  await page.locator("#recent .title", { hasText: "Plan" }).click();
  await expect(page.locator("#blocks .md-heading")).toBeVisible();
  await expect(page.locator("#blocks .tok-key")).toHaveCount(0);
  // A stored choice wins over detection.
  await page.locator("#recent .title", { hasText: "SELECT 1" }).click();
  await expect(page.locator("#card")).toHaveAttribute("data-code-lang", "python");
  await expect(page.locator("#blocks .tok-kw")).toHaveCount(0);
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
  await expect
    .poll(() => lines.evaluate((el) => (el as HTMLElement & { selectionStart?: number }).selectionStart ?? -1))
    .toBe("hello".length);
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
  const codeNumbers = () =>
    page.locator("#blocks .md-gutter-code").evaluateAll((els) => els.map((el) => el.textContent));
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
    const main = document
      .querySelector(".md-field:has(textarea[data-kind='code']) .md-gutter:not(.md-gutter-code)")!
      .getBoundingClientRect();
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
    const main = document
      .querySelector(".md-field:has(textarea[data-kind='code']) .md-gutter:not(.md-gutter-code)")!
      .getBoundingClientRect();
    return {
      barLeft: bar.left,
      localLeft: local.left,
      localRight: local.right,
      ballLeft: ball.left,
      mainLeft: main.left,
      mainRight: main.right,
    };
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
  await expect
    .poll(async () => {
      const calls = await getInvocations(page);
      return [...calls].reverse().find((item) => item.cmd === "apply_composer_size")?.args;
    })
    .toEqual({ width: 640, height: 800 });
  await expect
    .poll(async () => {
      const calls = await getInvocations(page);
      const applyAt = calls.reduce((index, item, at) => (item.cmd === "apply_composer_size" ? at : index), -1);
      return calls.slice(applyAt).some((item) => item.cmd === "slide_into_view");
    })
    .toBe(true);
  await area.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new Event("select"));
  });
  await emitEvent(page, "composer-cycle", 3);
  await expect.poll(() => editorText(page.locator("#blocks .md-lines, #blocks textarea").first())).toBe("");
  await expect
    .poll(async () => {
      const calls = await getInvocations(page);
      return [...calls].reverse().find((item) => item.cmd === "apply_composer_size")?.args;
    })
    .toEqual({ width: null, height: null });
  await emitEvent(page, "composer-cycle", 4);
  const again = await composerTextarea(page);
  await expect.poll(() => editorText(again)).toBe("abcdefghij");
  await expect.poll(async () => again.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(3);
});

test("tab indents a whitespace-only new memo instead of leaving the editor", async ({ page }) => {
  await openComposer(page, { notes: sampleNotes(5) });
  const area = await composerTextarea(page);
  await area.fill("  ");
  await area.press("Tab");
  await expect(area).toBeFocused();
  await expect.poll(async () => (await editorText(area)).length).toBeGreaterThan(2);
  await expect(page.locator("#recent-search")).toBeHidden();
});

test("tab in an empty new memo opens memo search", async ({ page }) => {
  await openComposer(page, { notes: sampleNotes(5) });
  const area = await composerTextarea(page);
  await area.press("Tab");
  await expect(page.locator("#recent-search")).toBeVisible();
});

for (const pinVia of ["header", "list"] as const) {
  test(`pinning a memo found by Tab search (${pinVia}) keeps it pinned and closes the search`, async ({ page }) => {
    await openComposer(page, { notes: sampleNotes(5) });
    const area = await composerTextarea(page);
    await area.click();
    await page.keyboard.press("Tab");
    await expect(page.locator("#recent-search")).toBeVisible();
    const row = page.locator("#recent li").nth(1);
    const id = await row.getAttribute("data-id");
    await row.locator(".label").click();
    if (pinVia === "header") {
      await page.locator("#pin-toggle").click();
    } else {
      await page.locator(`#recent li[data-id='${id}'] button.pin`).click();
    }
    await expect(page.locator("#recent-search")).toBeHidden();
    // The window closes after a pin, then the new-memo shortcut opens a fresh one.
    await emitEvent(page, "composer-flush", 2);
    await emitEvent(page, "composer-fresh", 3);
    await expect(page.locator("#recent-search")).toBeHidden();
    await expect.poll(async () => (await getNotes(page)).find((note) => note.id === id)?.pinned).toBe(true);
    const unpins = (await getInvocations(page)).filter(
      (call) => call.cmd === "set_pinned" && (call.args as { pinned?: boolean }).pinned === false,
    );
    expect(unpins).toEqual([]);
  });
}
