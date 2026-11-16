import { fieldRows, fieldSourceText, foldRanges, wrapEditorField, type FieldRow } from "./editor-field.ts";
import { sizeBlockTextarea } from "./textarea.ts";

const COPY_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>';

/** Source lines a hover covers, inclusive. */
type LineSpan = { start: number; end: number };

const BLOCK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.5H3.5v11H5M11 2.5h1.5v11H11"/><path d="M6.5 6h3M6.5 8h3M6.5 10h3"/></svg>';
/**
 * Replaces each `pre > code` in rendered markdown with a read-only coder editor field: line
 * numbers, highlighting and folding as in the editor, plus copy buttons. Call while `container`
 * is laid out, since the fields size themselves to their content.
 */
export function mountCodeViews(container: HTMLElement) {
  const areas: HTMLTextAreaElement[] = [];
  for (const code of container.querySelectorAll("pre > code")) {
    const pre = code.parentElement;
    if (!(pre instanceof HTMLElement)) {
      continue;
    }
    const lang = /language-([^\s]+)/.exec(code.className)?.[1] ?? "";
    const area = document.createElement("textarea");
    area.rows = 1;
    area.spellcheck = false;
    area.autocomplete = "off";
    area.setAttribute("autocorrect", "off");
    area.dataset.kind = "code";
    if (lang) {
      area.dataset.lang = lang;
    }
    area.value = (code.textContent ?? "").replace(/\n$/, "");
    const view = document.createElement("div");
    view.className = "md-code-view";
    const field = wrapEditorField(area, { editable: false });
    view.append(field);
    pre.replaceWith(view);
    field.append(copyButton("md-code-copy", "Copy code", () => fieldSourceText(area)));
    attachHover(field, area);
    areas.push(area);
  }
  for (const area of areas) {
    sizeBlockTextarea(area);
  }
}

function copyButton(className: string, label: string, text: () => string, icon = COPY_ICON): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `md-copy ${className}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = icon;
  let reset = 0;
  button.addEventListener("mousedown", (event) => {
    // Keeps focus and any selection where they are.
    event.preventDefault();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard.writeText(text()).then(
      () => {
        button.innerHTML = COPIED_ICON;
        button.classList.add("is-copied");
        window.clearTimeout(reset);
        reset = window.setTimeout(() => {
          button.innerHTML = icon;
          button.classList.remove("is-copied");
        }, 1200);
      },
      (error: unknown) => {
        console.error(error);
      },
    );
  });
  return button;
}

/**
 * Hovering a row, gutter included, tints it and the innermost foldable block around it, and puts
 * two buttons at the row's end: copy that block, and copy the line.
 */
function attachHover(field: HTMLElement, area: HTMLTextAreaElement) {
  const surface = field.querySelector<HTMLElement>(":scope > .md-surface");
  if (!surface) {
    return;
  }
  const layer = document.createElement("div");
  layer.className = "md-hover-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.hidden = true;
  const blockBar = document.createElement("div");
  blockBar.className = "md-hover-block";
  const lineBar = document.createElement("div");
  lineBar.className = "md-hover-line";
  layer.append(blockBar, lineBar);
  surface.prepend(layer);

  let line = -1;
  let block: LineSpan | null = null;
  const linesOf = (span: LineSpan) =>
    fieldSourceText(area)
      .split("\n")
      .slice(span.start, span.end + 1)
      .join("\n");
  const actions = document.createElement("div");
  actions.className = "md-hover-actions";
  actions.hidden = true;
  const copyBlock = copyButton("md-block-copy", "Copy block", () => (block ? linesOf(block) : ""), BLOCK_ICON);
  const copyLine = copyButton("md-line-copy", "Copy line", () =>
    line >= 0 ? linesOf({ start: line, end: line }) : "",
  );
  actions.append(copyBlock, copyLine);
  surface.append(actions);
  // Pointing at a button shows exactly what it copies.
  copyBlock.addEventListener("mouseenter", () => layer.classList.add("is-block-focus"));
  copyBlock.addEventListener("mouseleave", () => layer.classList.remove("is-block-focus"));
  copyLine.addEventListener("mouseenter", () => layer.classList.add("is-line-focus"));
  copyLine.addEventListener("mouseleave", () => layer.classList.remove("is-line-focus"));

  const clear = () => {
    line = -1;
    block = null;
    layer.hidden = true;
    actions.hidden = true;
  };

  const span = (rows: FieldRow[], range: LineSpan) => {
    const covered = rows.filter((row) => row.line >= range.start && row.line <= range.end);
    const first = covered[0];
    const last = covered[covered.length - 1];
    return first && last ? { top: first.top, height: last.top + last.height - first.top } : null;
  };

  const paint = () => {
    const rows = fieldRows(area);
    const row = rows.find((item) => item.line === line);
    if (!row) {
      clear();
      return;
    }
    const shift = -area.scrollTop;
    lineBar.style.top = `${row.top}px`;
    lineBar.style.height = `${row.height}px`;
    const box = block ? span(rows, block) : null;
    blockBar.hidden = !box;
    copyBlock.hidden = !box;
    if (box && block) {
      blockBar.style.top = `${box.top}px`;
      blockBar.style.height = `${box.height}px`;
      const label = `Copy block (lines ${block.start + 1}–${block.end + 1})`;
      copyBlock.title = label;
      copyBlock.setAttribute("aria-label", label);
    }
    layer.style.transform = `translateY(${shift}px)`;
    layer.hidden = false;
    actions.style.top = `${row.top + row.height / 2 + shift}px`;
    actions.hidden = false;
  };

  field.addEventListener("mousemove", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.buttons !== 0 || (target && actions.contains(target))) {
      return;
    }
    const y = event.clientY - area.getBoundingClientRect().top + area.scrollTop;
    const row = fieldRows(area).find((item) => y >= item.top && y < item.top + item.height);
    if (!row) {
      clear();
      return;
    }
    if (row.line === line && !layer.hidden) {
      return;
    }
    line = row.line;
    block = innermostFold(area, line);
    paint();
  });
  field.addEventListener("mouseleave", clear);
  // Folding moves rows; keep the tint on the same lines.
  field.addEventListener("memose-editor-view", () => {
    if (line >= 0) {
      paint();
    }
  });
}

/** The smallest foldable range holding `line`, its opener and closer lines included. */
function innermostFold(area: HTMLTextAreaElement, line: number): LineSpan | null {
  let best: LineSpan | null = null;
  for (const range of foldRanges(area)) {
    if (range.start <= line && line <= range.end && (!best || range.end - range.start < best.end - best.start)) {
      best = range;
    }
  }
  return best;
}
