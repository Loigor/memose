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
  const gutter = field.querySelector<HTMLElement>(".md-gutter");
  if (!highlight || !gutter) {
    return;
  }
  const coder = fieldUsesCoder(area);
  field.toggleAttribute("data-coder", coder);
  const wrap = Boolean(area.closest("#card, .stack-note")?.hasAttribute("data-wrap"));
  field.toggleAttribute("data-wrap", coder && wrap);
  if (prefs.markdownHighlight || coder) {
    highlight.innerHTML = highlightMarkdown(area.value);
  } else {
    highlight.replaceChildren();
  }
  if (coder) {
    paintGutter(gutter, area.value.split("\n").length);
  } else {
    gutter.textContent = "";
    gutter.style.removeProperty("--gutter-cols");
    delete gutter.dataset.lines;
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

function paintGutter(gutter: HTMLElement, count: number) {
  const digits = String(Math.max(1, count)).length;
  gutter.style.setProperty("--gutter-cols", String(Math.max(2, digits)));
  if (gutter.dataset.lines === String(count)) {
    return;
  }
  gutter.dataset.lines = String(count);
  gutter.textContent = Array.from({ length: count }, (_, index) => String(index + 1)).join("\n");
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
  const gutter = field.querySelector<HTMLElement>(".md-gutter");
  const shift = field.querySelector<HTMLElement>(".md-overflow-shift");
  if (highlight) {
    highlight.scrollTop = area.scrollTop;
    highlight.scrollLeft = area.scrollLeft;
  }
  if (shift) {
    shift.style.transform = `translateY(${-area.scrollTop}px)`;
  }
  if (gutter) {
    gutter.scrollTop = area.scrollTop;
  }
}
