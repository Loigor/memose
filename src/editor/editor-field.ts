import { highlightCode } from "./code-highlight.ts";
import {
  displayToSource,
  expandFolds,
  FOLD_SENTINEL,
  foldsAfterEdit,
  foldView,
  sentinelCount,
  showFoldMarks,
  sourceToDisplay,
  type FoldView,
} from "./code-fold.ts";
import { copyIndentAfterBreak, indentWidthCols, remapLineMarks, setIndentWidth } from "./markdown-edit.ts";
import { highlightMarkdown } from "./md-highlight.ts";

export type HighlightScheme = "paper" | "cool" | "mono";

export type EditorPrefs = {
  coderEditor: boolean;
  markdownHighlight: boolean;
  markdownScheme: HighlightScheme;
  indentWidth?: number;
};

let prefs: EditorPrefs = {
  coderEditor: false,
  markdownHighlight: true,
  markdownScheme: "paper",
  indentWidth: 2,
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

export function codeSurface(area: HTMLTextAreaElement): boolean {
  return fieldUsesCoder(area);
}

export function memoUsesCoder(explicit: boolean | null | undefined): boolean {
  if (explicit === true || explicit === false) {
    return explicit;
  }
  return prefs.coderEditor;
}

export function wrapEditorField(area: HTMLTextAreaElement): HTMLElement {
  area.setAttribute("data-block-field", "");
  attachFolding(area);
  const existing = area.closest(".md-field");
  if (existing instanceof HTMLElement) {
    attachLineMarks(existing, area);
    paintEditorField(area);
    return existing;
  }
  const field = document.createElement("div");
  field.className = "md-field";
  const folds = document.createElement("div");
  folds.className = "md-folds";
  folds.hidden = true;
  const gutter = document.createElement("div");
  gutter.className = "md-gutter";
  gutter.setAttribute("aria-hidden", "true");
  const surface = document.createElement("div");
  surface.className = "md-surface";
  const highlight = document.createElement("pre");
  highlight.className = "md-hl";
  highlight.setAttribute("aria-hidden", "true");
  surface.append(highlight, area, overflowLayer(surface));
  field.append(folds, gutter, surface);
  attachLineMarks(field, area);
  folds.addEventListener("mousedown", (event) => toggleFold(area, event));
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
  const shown = readNative(area);
  if (area.dataset.kind === "code") {
    highlight.innerHTML = showFoldMarks(highlightCode(shown, area.dataset.lang ?? ""));
  } else if (prefs.markdownHighlight || coder) {
    highlight.innerHTML = showFoldMarks(highlightMarkdown(shown, { tags: !coder }));
  } else {
    highlight.replaceChildren();
  }
  paintLang(field, area);
  paintFoldMarks(area, field);
  paintMarkBars(area, field);
  const scope = area.closest("#blocks, .stack-blocks");
  if (scope) {
    renumberGutters(scope, Boolean(note?.hasAttribute("data-coder")));
  } else if (coder) {
    const numbers = gutterNumbers(area, 1);
    paintNumbers(gutter, area, numbers, Math.max(2, String(sourceLineCount(area)).length), 1);
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
  const width = Math.round(Number(next.indentWidth));
  prefs = {
    coderEditor: Boolean(next.coderEditor),
    markdownHighlight: next.markdownHighlight !== false,
    markdownScheme: namedScheme(next.markdownScheme),
    indentWidth: width >= 1 && width <= 8 ? width : 2,
  };
  setIndentWidth(prefs.indentWidth ?? 2);
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--indent-ch", String(prefs.indentWidth ?? 2));
  }
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

function protoDesc(name: "value" | "selectionStart" | "selectionEnd"): PropertyDescriptor | undefined {
  if (typeof HTMLTextAreaElement === "undefined") {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, name);
}

function readNative(area: HTMLTextAreaElement): string {
  return protoDesc("value")?.get?.call(area) ?? "";
}

function writeNative(area: HTMLTextAreaElement, text: string) {
  protoDesc("value")?.set?.call(area, text);
}

type FoldState = {
  source: string;
  folds: Set<number>;
  holes: string[];
  view: FoldView;
};

const foldState = new WeakMap<HTMLTextAreaElement, FoldState>();
let foldWrite = false;

type LineMarks = { text: string; lines: Set<number> };

const markState = new WeakMap<HTMLTextAreaElement, LineMarks>();

function sourceLineCount(area: HTMLTextAreaElement): number {
  const state = foldState.get(area);
  const text = state && state.folds.size > 0 ? state.source : readNative(area);
  return lineCount(text);
}

function gutterNumbers(area: HTMLTextAreaElement, start: number): number[] {
  const state = foldState.get(area);
  if (!state || state.folds.size === 0) {
    return contiguous(start, lineCount(readNative(area)));
  }
  return state.view.numbers.map((number) => start + number - 1);
}

function contiguous(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}

function nativeStart(area: HTMLTextAreaElement): number {
  return protoDesc("selectionStart")?.get?.call(area) ?? 0;
}

function nativeEnd(area: HTMLTextAreaElement): number {
  return protoDesc("selectionEnd")?.get?.call(area) ?? nativeStart(area);
}

function setNativeRange(area: HTMLTextAreaElement, start: number, end: number) {
  HTMLTextAreaElement.prototype.setSelectionRange.call(area, start, end);
}

function toSource(area: HTMLTextAreaElement, offset: number): number {
  const state = foldState.get(area);
  if (!state || state.folds.size === 0) {
    return offset;
  }
  return displayToSource(readNative(area), state.holes, offset);
}

function toDisplay(area: HTMLTextAreaElement, offset: number): number {
  const state = foldState.get(area);
  if (!state || state.folds.size === 0) {
    return offset;
  }
  return sourceToDisplay(readNative(area), state.holes, offset);
}

function defineCaret(
  area: HTMLTextAreaElement,
  name: "selectionStart" | "selectionEnd",
  desc: PropertyDescriptor | undefined,
) {
  if (!desc?.get || !desc.set || Object.prototype.hasOwnProperty.call(area, name)) {
    return;
  }
  const read = desc.get;
  const write = desc.set;
  Object.defineProperty(area, name, {
    configurable: true,
    get() {
      return toSource(area, read.call(area));
    },
    set(next: number) {
      write.call(area, toDisplay(area, Number(next)));
    },
  });
}

function installValue(area: HTMLTextAreaElement) {
  if (Object.prototype.hasOwnProperty.call(area, "value")) {
    return;
  }
  Object.defineProperty(area, "value", {
    configurable: true,
    get() {
      const state = foldState.get(area);
      if (!state || state.folds.size === 0) {
        return readNative(area);
      }
      return state.source;
    },
    set(next: string) {
      const state = foldState.get(area);
      writeNative(area, String(next));
      if (state) {
        state.source = String(next);
        state.folds.clear();
        state.holes = [];
        state.view = foldView(state.source, state.folds);
      }
    },
  });
  defineCaret(area, "selectionStart", protoDesc("selectionStart"));
  defineCaret(area, "selectionEnd", protoDesc("selectionEnd"));
  area.setSelectionRange = (start: number, end: number, direction?: "forward" | "backward" | "none") => {
    HTMLTextAreaElement.prototype.setSelectionRange.call(area, toDisplay(area, start), toDisplay(area, end), direction);
  };
}

function rememberView(state: FoldState) {
  state.view = foldView(state.source, state.folds);
  state.folds = new Set(state.view.foldedLines);
  state.holes = state.view.holes;
}

function showFolded(area: HTMLTextAreaElement, caret: number) {
  const state = foldState.get(area);
  if (!state) {
    return;
  }
  rememberView(state);
  const at = sourceToDisplay(state.view.display, state.view.holes, caret);
  foldWrite = true;
  writeNative(area, state.view.display);
  setNativeRange(area, at, at);
  foldWrite = false;
  fitFoldHeight(area);
  paintEditorField(area);
}

function fitFoldHeight(area: HTMLTextAreaElement) {
  const blocks = area.closest<HTMLElement>("#blocks, .stack-blocks");
  const top = blocks?.scrollTop ?? 0;
  area.style.height = "0px";
  const minH = area.classList.contains("grow") ? 64 : 22;
  area.style.height = `${Math.max(minH, area.scrollHeight)}px`;
  if (blocks) {
    blocks.scrollTop = top;
  }
}

function attachFolding(area: HTMLTextAreaElement) {
  if (area.dataset.folding === "1") {
    return;
  }
  area.dataset.folding = "1";
  area.addEventListener("keydown", (event) => {
    const state = foldState.get(area);
    if (!state || state.folds.size === 0 || foldWrite) {
      return;
    }
    const native = readNative(area);
    const at = nativeStart(area);
    const end = nativeEnd(area);
    if (at !== end) {
      return;
    }
    const hit = event.key === "Backspace" ? native[at - 1] : event.key === "Delete" ? native[at] : "";
    if (hit !== FOLD_SENTINEL) {
      return;
    }
    event.preventDefault();
    const which = sentinelCount(native.slice(0, event.key === "Backspace" ? at - 1 : at));
    const line = state.view.foldedLines[which];
    if (line === undefined) {
      return;
    }
    const sourceAt = displayToSource(native, state.holes, at);
    state.folds.delete(line);
    showFolded(area, sourceAt);
  });
  area.addEventListener(
    "beforeinput",
    (event) => {
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        area.dataset.indentBreak = "1";
      }
    },
    true,
  );
  area.addEventListener(
    "input",
    () => {
      const breaking = area.dataset.indentBreak === "1";
      delete area.dataset.indentBreak;
      if (foldWrite) {
        return;
      }
      if (breaking && codeSurface(area)) {
        applyBreakIndent(area);
      }
      const state = foldState.get(area);
      if (state && state.folds.size > 0) {
        const display = readNative(area);
        const sourceAt = displayToSource(display, state.holes, nativeStart(area));
        if (sentinelCount(display) !== state.holes.length) {
          state.folds.clear();
          state.holes = [];
          showFolded(area, sourceAt);
        } else {
          state.source = expandFolds(display, state.holes);
          state.folds = foldsAfterEdit(state.source, state.holes);
          const next = foldView(state.source, state.folds);
          if (next.display !== display) {
            showFolded(area, sourceAt);
          } else {
            state.view = next;
            state.folds = new Set(next.foldedLines);
            state.holes = next.holes;
          }
        }
      }
      syncMarks(area);
    },
    true,
  );
}

function applyBreakIndent(area: HTMLTextAreaElement) {
  const edit = copyIndentAfterBreak(readNative(area), nativeStart(area));
  if (!edit) {
    return;
  }
  foldWrite = true;
  writeNative(area, edit.value);
  setNativeRange(area, edit.start, edit.end);
  foldWrite = false;
}

function toggleFold(area: HTMLTextAreaElement, event: MouseEvent) {
  const button = event.target instanceof Element ? event.target.closest(".md-fold") : null;
  if (!(button instanceof HTMLElement)) {
    return;
  }
  event.preventDefault();
  const line = Number(button.dataset.line);
  if (!Number.isInteger(line)) {
    return;
  }
  let state = foldState.get(area);
  if (!state) {
    state = { source: readNative(area), folds: new Set(), holes: [], view: foldView(readNative(area), new Set()) };
    foldState.set(area, state);
    installValue(area);
  }
  if (state.folds.has(line)) {
    state.folds.delete(line);
  } else {
    state.folds.add(line);
  }
  showFolded(area, area.selectionStart ?? 0);
}

function sourceText(area: HTMLTextAreaElement): string {
  const folded = foldState.get(area);
  if (folded && folded.folds.size > 0) {
    return folded.source;
  }
  return readNative(area);
}

function syncMarks(area: HTMLTextAreaElement) {
  const state = markState.get(area);
  if (!state || state.lines.size === 0) {
    return;
  }
  const text = sourceText(area);
  if (text === state.text) {
    return;
  }
  const lines = remapLineMarks(state.text, text, state.lines);
  state.text = text;
  state.lines = lines;
  if (lines.size === 0) {
    markState.delete(area);
  }
}

export function readLineMarks(root: ParentNode): number[][] {
  const marks: number[][] = [];
  for (const area of root.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    const index = Number(area.dataset.index);
    if (!Number.isInteger(index) || index < 0) {
      continue;
    }
    const lines = markState.get(area)?.lines;
    marks[index] = lines && lines.size > 0 ? [...lines].sort((a, b) => a - b) : [];
  }
  return marks;
}

export function writeLineMarks(root: ParentNode, marks: number[][] | undefined) {
  const saved = marks ?? [];
  for (const area of root.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    const index = Number(area.dataset.index);
    const lines = Number.isInteger(index) ? (saved[index] ?? []) : [];
    if (lines.length === 0) {
      continue;
    }
    markState.set(area, { text: sourceText(area), lines: new Set(lines) });
    paintEditorField(area);
  }
}

function rememberLineMarks(area: HTMLTextAreaElement) {
  area.dispatchEvent(new CustomEvent("memose-undo", { bubbles: true }));
}

function gutterHit(area: HTMLTextAreaElement, event: MouseEvent): number | null {
  const note = area.closest("#card, .stack-note");
  if (!note?.hasAttribute("data-coder")) {
    return null;
  }
  const node = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
  const gutter = node?.closest(".md-gutter");
  if (!(gutter instanceof HTMLElement) || !area.closest(".md-field")?.contains(gutter)) {
    return null;
  }
  const sources = (gutter.dataset.sources ?? "").split(",").filter((part) => part !== "").map(Number);
  const pad = Number.parseFloat(getComputedStyle(gutter).paddingTop) || 0;
  const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 18;
  const index = Math.floor((event.clientY - gutter.getBoundingClientRect().top + gutter.scrollTop - pad) / lineHeight);
  const line = sources[index];
  return Number.isInteger(line) ? line : null;
}

function attachLineMarks(field: HTMLElement, area: HTMLTextAreaElement) {
  if (field.dataset.lineMarks === "1") {
    return;
  }
  field.dataset.lineMarks = "1";
  let pending = 0;
  field.addEventListener("click", (event) => {
    const line = gutterHit(area, event);
    const state = line == null ? undefined : markState.get(area);
    if (line == null || !state?.lines.has(line)) {
      return;
    }
    window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = 0;
      rememberLineMarks(area);
      state.lines.delete(line);
      if (state.lines.size === 0) {
        markState.delete(area);
      }
      paintEditorField(area);
    }, 220);
  });
  field.addEventListener("dblclick", (event) => {
    const line = gutterHit(area, event);
    if (line == null) {
      return;
    }
    window.clearTimeout(pending);
    pending = 0;
    event.preventDefault();
    rememberLineMarks(area);
    let state = markState.get(area);
    if (!state) {
      state = { text: sourceText(area), lines: new Set() };
      markState.set(area, state);
    }
    if (state.lines.has(line)) {
      state.lines.delete(line);
    } else {
      state.lines.add(line);
    }
    state.text = sourceText(area);
    if (state.lines.size === 0) {
      markState.delete(area);
    }
    paintEditorField(area);
  });
}

function paintMarkBars(area: HTMLTextAreaElement, field: HTMLElement) {
  const surface = field.querySelector(":scope > .md-surface");
  const existing = surface?.querySelector<HTMLElement>(":scope > .md-mark-bars");
  const marks = markState.get(area);
  const note = area.closest("#card, .stack-note");
  if (!surface || !marks || marks.lines.size === 0 || !note?.hasAttribute("data-coder")) {
    existing?.remove();
    return;
  }
  const layer = existing ?? document.createElement("div");
  layer.className = "md-mark-bars";
  if (!existing) {
    surface.prepend(layer);
  }
  const folded = foldState.get(area);
  const sources = folded && folded.folds.size > 0
    ? folded.view.numbers.map((number) => number - 1)
    : Array.from({ length: sourceText(area).split("\n").length }, (_, index) => index);
  if (!sources.some((line) => marks.lines.has(line))) {
    existing?.remove();
    return;
  }
  const style = getComputedStyle(area);
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  const key = sources.map((line) => (marks.lines.has(line) ? "1" : "0")).join("");
  if (layer.dataset.key === key && layer.childElementCount > 0) {
    return;
  }
  layer.dataset.key = key;
  layer.replaceChildren();
  sources.forEach((line, index) => {
    if (!marks.lines.has(line)) {
      return;
    }
    const bar = document.createElement("div");
    bar.className = "md-mark-bar";
    bar.style.top = `${padTop + index * lineHeight}px`;
    bar.style.height = `${lineHeight}px`;
    layer.append(bar);
  });
  layer.style.transform = `translateY(${-area.scrollTop}px)`;
}

function paintFoldMarks(area: HTMLTextAreaElement, field: HTMLElement) {
  const host = field.querySelector<HTMLElement>(":scope > .md-folds");
  if (!host) {
    return;
  }
  const state = foldState.get(area);
  const shown = state && state.folds.size > 0 ? state.view : foldView(readNative(area), new Set());
  const markers = shown.markers;
  const numbers = shown.numbers;
  const any = markers.some((mark) => mark != null);
  host.hidden = !any;
  if (!any) {
    host.replaceChildren();
    delete host.dataset.key;
    return;
  }
  const style = getComputedStyle(area);
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  const key = `${padTop}:${lineHeight}:${markers.join(",")}`;
  if (host.dataset.key === key) {
    return;
  }
  host.dataset.key = key;
  const spacer = document.createElement("div");
  spacer.className = "md-fold-spacer";
  spacer.style.height = `${padTop + markers.length * lineHeight}px`;
  markers.forEach((mark, index) => {
    if (!mark) {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "md-fold";
    button.dataset.line = String((numbers[index] ?? 1) - 1);
    button.textContent = mark === "shut" ? "▸" : "▾";
    button.setAttribute("aria-expanded", mark === "open" ? "true" : "false");
    button.setAttribute("aria-label", mark === "shut" ? "Unfold" : "Fold");
    button.style.top = `${padTop + index * lineHeight}px`;
    button.style.height = `${lineHeight}px`;
    spacer.append(button);
  });
  host.replaceChildren(spacer);
}

function primaryGutter(field: HTMLElement): HTMLElement | null {
  return field.querySelector<HTMLElement>(":scope > .md-gutter:not(.md-gutter-code)");
}

function clearGutter(gutter: HTMLElement) {
  gutter.textContent = "";
  gutter.classList.remove("has-mark");
  gutter.style.removeProperty("--gutter-cols");
  delete gutter.dataset.lines;
  delete gutter.dataset.sources;
}

function gutterBody(gutter: HTMLElement): HTMLElement {
  const existing = gutter.querySelector<HTMLElement>(":scope > .md-gutter-body");
  if (existing) {
    return existing;
  }
  const body = document.createElement("div");
  body.className = "md-gutter-body";
  gutter.replaceChildren(body);
  return body;
}

function paintNumbers(
  gutter: HTMLElement,
  area: HTMLTextAreaElement,
  numbers: number[],
  cols: number,
  origin: number,
) {
  gutter.style.setProperty("--gutter-cols", String(cols));
  gutter.classList.remove("has-mark");
  const sources = numbers.map((number) => number - origin);
  gutter.dataset.sources = sources.join(",");
  const marked = area.closest("#card, .stack-note")?.hasAttribute("data-coder")
    ? markState.get(area)?.lines
    : undefined;
  const markKey = marked && marked.size > 0 ? [...marked].sort((a, b) => a - b).join(",") : "";
  const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 18;
  const key = `${numbers.join("\n")}|${origin}|${markKey}|${lineHeight}`;
  if (gutter.dataset.lines === key) {
    return;
  }
  gutter.dataset.lines = key;
  const body = gutterBody(gutter);
  body.textContent = numbers.join("\n");
  if (!marked) {
    return;
  }
  sources.forEach((line, index) => {
    if (!marked.has(line)) {
      return;
    }
    const ball = document.createElement("span");
    ball.className = "md-line-ball";
    ball.style.top = `${index * lineHeight + (lineHeight - 4) / 2}px`;
    body.append(ball);
  });
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
        const numbers = gutterNumbers(area, 1);
        paintNumbers(gutter, area, numbers, Math.max(2, String(sourceLineCount(area)).length), 1);
      } else {
        clearGutter(gutter);
      }
    }
    return;
  }
  let nextLine = 1;
  const rows = areas.map((area) => {
    const count = sourceLineCount(area);
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
    paintNumbers(gutter, row.area, gutterNumbers(row.area, row.start), cols, row.start);
    if (row.area.dataset.kind === "code") {
      const local = codeGutter(field, true);
      if (local) {
        paintNumbers(local, row.area, gutterNumbers(row.area, 1), Math.max(2, String(row.count).length), 1);
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
  const lines = readNative(area).split("\n");
  const texts = highlight.querySelectorAll<HTMLElement>(".md-line-text");
  shift.replaceChildren();
  for (let index = 0; index < lines.length; index += 1) {
    const wide = ctx ? ctx.measureText(expandTabs(lines[index] ?? "", indentWidthCols())).width : 0;
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
  const bars = field.querySelector<HTMLElement>(":scope > .md-surface > .md-mark-bars");
  if (bars) {
    bars.style.transform = `translateY(${-area.scrollTop}px)`;
  }
  for (const gutter of field.querySelectorAll<HTMLElement>(":scope > .md-gutter, :scope > .md-folds")) {
    gutter.scrollTop = area.scrollTop;
  }
}
