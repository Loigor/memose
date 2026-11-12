import { writeFileSync } from "node:fs";

import { test } from "@playwright/test";

import { openComposer, revealEditorButton } from "./helpers";

test("measure coder alignment", async ({ page, browserName }) => {
  await openComposer(page);
  const coder = page.locator("#coder-toggle");
  await revealEditorButton(page, coder);
  await coder.click();
  const area = page.locator("#blocks textarea");
  await area.fill("Hello there :D\n\nOkay, what the...\nEverything is more misaligned now?");
  await page.locator(".md-hl").first().waitFor();
  const report = await page.evaluate(() => {
    const caretAt = (x: number, y: number): number | null => {
      const doc = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offset: number; offsetNode: Node } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const pos = doc.caretPositionFromPoint?.(x, y);
      if (pos && pos.offsetNode instanceof HTMLTextAreaElement) {
        return pos.offset;
      }
      const range = doc.caretRangeFromPoint?.(x, y);
      if (range && range.startContainer instanceof HTMLTextAreaElement) {
        return range.startOffset;
      }
      return null;
    };
    const area = document.querySelector("#blocks textarea") as HTMLTextAreaElement;
    const hl = document.querySelector("#blocks .md-hl") as HTMLElement;
    const gutter = document.querySelector("#blocks .md-gutter") as HTMLElement;
    const body = gutter.querySelector(".md-gutter-body") as HTMLElement;
    const cs = (el: Element) => {
      const style = getComputedStyle(el);
      return {
        pad: style.padding,
        lh: style.lineHeight,
        font: style.font,
        kern: style.fontKerning,
        liga: style.fontVariantLigatures,
        numeric: style.fontVariantNumeric,
        ws: style.whiteSpace,
        overflowX: style.overflowX,
        box: style.boxSizing,
      };
    };
    const texts = [...hl.querySelectorAll<HTMLElement>(".md-line-text")].map((el) => {
      const rect = el.getBoundingClientRect();
      return { t: rect.top, h: rect.height, l: rect.left, w: rect.width, text: el.textContent };
    });
    const range = document.createRange();
    range.selectNodeContents(body);
    const gutterLines = [...range.getClientRects()].map((rect) => ({ t: rect.top, h: rect.height, l: rect.left, w: rect.width }));
    const aBox = area.getBoundingClientRect();
    const hBox = hl.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const sample = "Everything is more misaligned now?";
    let canvasWidth = 0;
    if (ctx) {
      ctx.font = getComputedStyle(area).font;
      canvasWidth = ctx.measureText(sample).width;
    }
    return {
      area: { top: aBox.top, left: aBox.left, ...cs(area) },
      hl: { top: hBox.top, left: hBox.left, ...cs(hl) },
      gutter: cs(gutter),
      body: cs(body),
      texts,
      gutterLines,
      canvasWidth,
      overlayLastWidth: texts[3]?.w ?? null,
      family: {
        area: getComputedStyle(area).fontFamily,
        hl: getComputedStyle(hl).fontFamily,
        span: getComputedStyle(hl.querySelector(".md-line-text")!).fontFamily,
        size: getComputedStyle(area).fontSize,
      },
      box: { h: area.clientHeight, scroll: area.scrollHeight, sh: area.scrollTop },
      scan: Array.from({ length: 28 }, (_, i) => {
        const y = 70 + i * 4;
        return { y, offset: caretAt(80, y) };
      }),
    };
  });
  const variants: Record<string, string> = {
    base: "",
    overflow: `#blocks .md-field[data-coder] .md-hl, #blocks .md-field[data-coder] textarea { overflow-x: auto !important; overflow-y: hidden !important; scrollbar-width: none !important; } #blocks .md-field[data-coder] textarea::-webkit-scrollbar { display: none !important; }`,
    lh: `.md-field[data-coder] { line-height: 19px !important; }`,
  };
  await page.addStyleTag({
    content: `#blocks textarea { caret-color: #4cf !important; }`,
  });
  const shots: string[] = [];
  for (const [name, css] of Object.entries(variants)) {
    await page.evaluate((rule) => {
      let el = document.getElementById("align-probe");
      if (!el) {
        el = document.createElement("style");
        el.id = "align-probe";
        document.head.append(el);
      }
      el.textContent = rule;
    }, css);
    await area.evaluate((el) => {
      const area = el as HTMLTextAreaElement;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
    const path = `/tmp/align-${browserName}-${name}.png`;
    for (let i = 0; i < 6; i += 1) {
      await page.locator("#blocks .md-field").screenshot({ path: path.replace(".png", `-${i}.png`) });
      await page.waitForTimeout(40);
    }
    shots.push(path);
  }
  writeFileSync(`/tmp/align-${browserName}.json`, JSON.stringify({ ...report, shots }, null, 2));
});
