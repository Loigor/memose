import { highlightCode } from "./code-highlight.ts";
import { highlightMarkdown } from "./md-highlight.ts";

export type HighlightScheme = "paper" | "cool" | "mono";

export type EditorPrefs = {
  coderEditor: boolean;
  markdownHighlight: boolean;
  markdownScheme: HighlightScheme;
};

let prefs: EditorPrefs = {
  coderEditor: false,
  markdownHighlight: true,
  markdownScheme: "paper",
};

export function editorPrefs(): EditorPrefs {
  return prefs;
}

export function namedScheme(value: string | null | undefined): HighlightScheme {
  if (value === "cool" || value === "mono") {
    return value;
  }
  return "paper";
}

export function memoUsesCoder(explicit: boolean | null | undefined): boolean {
  if (explicit === true || explicit === false) {
    return explicit;
  }
  return prefs.coderEditor;
}

export function wrapEditorField(area: HTMLTextAreaElement): HTMLElement {
  area.setAttribute("data-block-field", "");
  const existing = area.closest(".md-field");
  if (existing instanceof HTMLElement) {
    paintEditorField(area);
    return existing;
  }
  const field = document.createElement("div");
  field.className = "md-field";
  const gutter = document.createElement("div");
  gutter.className = "md-gutter";
  gutter.setAttribute("aria-hidden", "true");
  const surface = document.createElement("div");
  surface.className = "md-surface";
  const highlight = document.createElement("pre");
  highlight.className = "md-hl";
  highlight.setAttribute("aria-hidden", "true");
  surface.append(highlight, area, overflowLayer(surface));
  field.append(gutter, surface);
  area.addEventListener("scroll", () => syncEditorScroll(area));
  let resizeFrame = 0;
  new ResizeObserver(() => {
    if (resizeFrame) {
      return;
    }
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      markLongLines(highlight, fieldUsesCoder(area));
    });
  }).observe(surface);
  paintEditorField(area);
  return field;
}

export function paintEditorField(area: HTMLTextAreaElement) {
  const field = area.closest(".md-field");
  if (!(field instanceof HTMLElement)) {
    return;
  }
  const highlight = field.querySelector<HTMLElement>(".md-hl");
  const gutter = primaryGutter(field);
  if (!highlight || !gutter) {
    return;
  }
  const coder = fieldUsesCoder(area);
  field.toggleAttribute("data-coder", coder);
  const note = area.closest("#card, .stack-note");
  const wrap = Boolean(note?.hasAttribute("data-wrap"));
  field.toggleAttribute("data-wrap", coder && wrap);
  if (area.dataset.kind === "code") {
    highlight.innerHTML = highlightCode(area.value, area.dataset.lang ?? "");
  } else if (prefs.markdownHighlight || coder) {
    highlight.innerHTML = highlightMarkdown(area.value, { tags: !coder });
  } else {
    highlight.replaceChildren();
  }
  paintLang(field, area);
  const scope = area.closest("#blocks, .stack-blocks");
  if (scope) {
    renumberGutters(scope, Boolean(note?.hasAttribute("data-coder")));
  } else if (coder) {
    const count = lineCount(area.value);
    paintNumbers(gutter, 1, count, Math.max(2, String(count).length));
    codeGutter(field, false);
  } else {
    clearGutter(gutter);
    codeGutter(field, false);
  }
  syncEditorScroll(area);
  markLongLines(highlight, coder);
}

export function refreshEditorFields(root: ParentNode = document) {
  applyEditorDataset();
  for (const area of root.querySelectorAll<HTMLTextAreaElement>(
    "#blocks textarea, .stack-blocks textarea",
  )) {
    paintEditorField(area);
  }
}

export function setEditorPrefs(next: EditorPrefs) {
  prefs = {
    coderEditor: Boolean(next.coderEditor),
    markdownHighlight: next.markdownHighlight !== false,
    markdownScheme: namedScheme(next.markdownScheme),
  };
  refreshEditorFields();
}

function paintLang(field: HTMLElement, area: HTMLTextAreaElement) {
  const label = (area.dataset.lang ?? "").trim().split(/\s+/)[0] ?? "";
  if (label) {
    field.dataset.lang = label;
  } else {
    delete field.dataset.lang;
  }
  const surface = field.querySelector(":scope > .md-surface") ?? field;
  let badge = surface.querySelector(":scope > .md-lang");
  if (!label) {
    badge?.remove();
    area.removeAttribute("aria-label");
    return;
  }
  if (!(badge instanceof HTMLElement)) {
    badge = document.createElement("div");
    badge.className = "md-lang";
    badge.setAttribute("aria-hidden", "true");
    surface.append(badge);
  }
  if (badge.textContent !== label) {
    badge.textContent = label;
  }
  area.setAttribute("aria-label", `${label} code`);
}

function applyEditorDataset() {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.toggleAttribute("data-mdhl", prefs.markdownHighlight);
  document.documentElement.dataset.mdhlScheme = prefs.markdownScheme;
}

function fieldUsesCoder(area: HTMLTextAreaElement): boolean {
  if (area.dataset.kind === "code") {
    return true;
  }
  return Boolean(area.closest("#card, .stack-note")?.hasAttribute("data-coder"));
}

function lineCount(value: string): number {
  return Math.max(1, value.split("\n").length);
}

function primaryGutter(field: HTMLElement): HTMLElement | null {
  return field.querySelector<HTMLElement>(":scope > .md-gutter:not(.md-gutter-code)");
}

function clearGutter(gutter: HTMLElement) {
  gutter.textContent = "";
  gutter.style.removeProperty("--gutter-cols");
  delete gutter.dataset.lines;
}

function paintNumbers(gutter: HTMLElement, start: number, count: number, cols: number) {
  gutter.style.setProperty("--gutter-cols", String(cols));
  const key = `${start}:${count}`;
  if (gutter.dataset.lines === key) {
    return;
  }
  gutter.dataset.lines = key;
  gutter.textContent = Array.from({ length: count }, (_, index) => String(start + index)).join("\n");
}

function codeGutter(field: HTMLElement, on: boolean): HTMLElement | null {
  const existing = field.querySelector<HTMLElement>(":scope > .md-gutter.md-gutter-code");
  if (!on) {
    existing?.remove();
    return null;
  }
  if (existing) {
    return existing;
  }
  const gutter = document.createElement("div");
  gutter.className = "md-gutter md-gutter-code";
  gutter.setAttribute("aria-hidden", "true");
  const surface = field.querySelector(":scope > .md-surface");
  if (surface) {
    field.insertBefore(gutter, surface);
  } else {
    field.append(gutter);
  }
  return gutter;
}

function renumberGutters(scope: ParentNode, coderNote: boolean) {
  const areas = [...scope.querySelectorAll<HTMLTextAreaElement>("textarea")];
  if (!coderNote) {
    for (const area of areas) {
      const field = area.closest(".md-field");
      if (!(field instanceof HTMLElement)) {
        continue;
      }
      const gutter = primaryGutter(field);
      codeGutter(field, false);
      if (!gutter) {
        continue;
      }
      if (area.dataset.kind === "code") {
        const count = lineCount(area.value);
        paintNumbers(gutter, 1, count, Math.max(2, String(count).length));
      } else {
        clearGutter(gutter);
      }
    }
    return;
  }
  let nextLine = 1;
  const rows = areas.map((area) => {
    const count = lineCount(area.value);
    const start = nextLine;
    nextLine += count;
    return { area, start, count };
  });
  const cols = Math.max(2, String(Math.max(1, nextLine - 1)).length);
  for (const row of rows) {
    const field = row.area.closest(".md-field");
    if (!(field instanceof HTMLElement)) {
      continue;
    }
    const gutter = primaryGutter(field);
    if (!gutter || !field.hasAttribute("data-coder")) {
      if (gutter) {
        clearGutter(gutter);
      }
      codeGutter(field, false);
      continue;
    }
    paintNumbers(gutter, row.start, row.count, cols);
    if (row.area.dataset.kind === "code") {
      const local = codeGutter(field, true);
      if (local) {
        paintNumbers(local, 1, row.count, Math.max(2, String(row.count).length));
      }
    } else {
      codeGutter(field, false);
    }
  }
}

function overflowLayer(surface: HTMLElement): HTMLElement {
  const existing = surface.querySelector<HTMLElement>(".md-overflow");
  if (existing) {
    return existing;
  }
  const marks = document.createElement("div");
  marks.className = "md-overflow";
  marks.setAttribute("aria-hidden", "true");
  const shift = document.createElement("div");
  shift.className = "md-overflow-shift";
  marks.append(shift);
  surface.append(marks);
  return marks;
}

function overflowShift(surface: HTMLElement): HTMLElement {
  const marks = overflowLayer(surface);
  const existing = marks.querySelector<HTMLElement>(".md-overflow-shift");
  if (existing) {
    return existing;
  }
  const shift = document.createElement("div");
  shift.className = "md-overflow-shift";
  marks.append(shift);
  return shift;
}

let measureCtx: CanvasRenderingContext2D | null = null;

function lineMeasure(font: string): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") {
    return null;
  }
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  if (measureCtx) {
    measureCtx.font = font;
  }
  return measureCtx;
}

function expandTabs(line: string, tab = 4): string {
  let out = "";
  let col = 0;
  for (const char of line) {
    if (char === "\t") {
      const n = tab - (col % tab);
      out += " ".repeat(n);
      col += n;
    } else {
      out += char;
      col += 1;
    }
  }
  return out;
}

function markLongLines(highlight: HTMLElement, coder: boolean) {
  const surface = highlight.parentElement;
  if (!(surface instanceof HTMLElement)) {
    return;
  }
  const shift = overflowShift(surface);
  const wrap = Boolean(highlight.closest(".md-field")?.hasAttribute("data-wrap"));
  const area = surface.querySelector("textarea");
  if (!coder || wrap || !(area instanceof HTMLTextAreaElement)) {
    shift.replaceChildren();
    shift.style.transform = "";
    return;
  }
  const style = getComputedStyle(highlight);
  const padLeft = Number.parseFloat(style.paddingLeft) || 0;
  const padRight = Number.parseFloat(style.paddingRight) || 0;
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const fontSize = Number.parseFloat(style.fontSize) || 13;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.45;
  const inner = highlight.clientWidth - padLeft - padRight;
  const ctx = lineMeasure(style.font);
  const lines = area.value.split("\n");
  const texts = highlight.querySelectorAll<HTMLElement>(".md-line-text");
  shift.replaceChildren();
  for (let index = 0; index < lines.length; index += 1) {
    const wide = ctx ? ctx.measureText(expandTabs(lines[index] ?? "")).width : 0;
    const long = wide > inner + 1;
    texts[index]?.classList.toggle("is-long", long);
    if (!long) {
      continue;
    }
    const dot = document.createElement("span");
    dot.className = "md-overflow-dot";
    dot.style.top = `${padTop + (index + 0.5) * lineHeight}px`;
    shift.append(dot);
  }
  shift.style.transform = `translateY(${-highlight.scrollTop}px)`;
}

applyEditorDataset();

function syncEditorScroll(area: HTMLTextAreaElement) {
  const field = area.closest(".md-field");
  if (!(field instanceof HTMLElement)) {
    return;
  }
  const highlight = field.querySelector<HTMLElement>(".md-hl");
  const shift = field.querySelector<HTMLElement>(".md-overflow-shift");
  if (highlight) {
    highlight.scrollTop = area.scrollTop;
    highlight.scrollLeft = area.scrollLeft;
  }
  if (shift) {
    shift.style.transform = `translateY(${-area.scrollTop}px)`;
  }
  for (const gutter of field.querySelectorAll<HTMLElement>(":scope > .md-gutter")) {
    gutter.scrollTop = area.scrollTop;
  }
}
