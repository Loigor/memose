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
  new ResizeObserver(() => {
    const coder = Boolean(area.closest("#card, .stack-note")?.hasAttribute("data-coder"));
    markLongLines(highlight, coder);
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
  const coder = Boolean(area.closest("#card, .stack-note")?.hasAttribute("data-coder"));
  if (prefs.markdownHighlight || coder) {
    highlight.innerHTML = highlightMarkdown(area.value);
  } else {
    highlight.replaceChildren();
  }
  if (coder) {
    const count = area.value.split("\n").length;
    gutter.textContent = Array.from({ length: count }, (_, index) => String(index + 1)).join("\n");
  } else {
    gutter.textContent = "";
  }
  syncEditorScroll(area);
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

function overflowLayer(surface: HTMLElement): HTMLElement {
  const existing = surface.querySelector<HTMLElement>(".md-overflow");
  if (existing) {
    return existing;
  }
  const marks = document.createElement("div");
  marks.className = "md-overflow";
  marks.setAttribute("aria-hidden", "true");
  surface.append(marks);
  return marks;
}

function markLongLines(highlight: HTMLElement, coder: boolean) {
  const surface = highlight.parentElement;
  if (!(surface instanceof HTMLElement)) {
    return;
  }
  const marks = overflowLayer(surface);
  const surfaceRect = surface.getBoundingClientRect();
  marks.replaceChildren();
  const padLeft = Number.parseFloat(getComputedStyle(highlight).paddingLeft) || 0;
  const padRight = Number.parseFloat(getComputedStyle(highlight).paddingRight) || 0;
  const inner = highlight.clientWidth - padLeft - padRight;
  const wrap = Boolean(highlight.closest("#card, .stack-note")?.hasAttribute("data-wrap"));
  for (const text of highlight.querySelectorAll<HTMLElement>(".md-line-text")) {
    const wide = text.getBoundingClientRect().width;
    const long = coder && !wrap && wide > inner + 1;
    text.classList.toggle("is-long", long);
    if (!long) {
      continue;
    }
    const lineRect = text.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "md-overflow-dot";
    dot.style.top = `${lineRect.top - surfaceRect.top + lineRect.height / 2}px`;
    marks.append(dot);
  }
}

applyEditorDataset();

function syncEditorScroll(area: HTMLTextAreaElement) {
  const field = area.closest(".md-field");
  if (!(field instanceof HTMLElement)) {
    return;
  }
  const highlight = field.querySelector<HTMLElement>(".md-hl");
  const gutter = field.querySelector<HTMLElement>(".md-gutter");
  if (highlight) {
    highlight.scrollTop = area.scrollTop;
    highlight.scrollLeft = area.scrollLeft;
    const coder = Boolean(area.closest("#card, .stack-note")?.hasAttribute("data-coder"));
    markLongLines(highlight, coder);
  }
  if (gutter) {
    gutter.scrollTop = area.scrollTop;
  }
}
