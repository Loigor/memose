/**
 * The small "AI" tab that appears beside selected memo text, or on a code block under the
 * pointer. Clicking it makes that text the source of the next prompt.
 */

import { locateBlock, resolveSelection, splitLines, type LineRange } from "../editor/line-diff";
import { button } from "../dom";
import { fieldSourceText } from "../editor/editor-field";

/** Memo text picked as the source of a prompt. */
export type Picked = {
  text: string;
  /** The source is one code block, picked with the tab on the block. */
  code?: boolean;
  /** Memo lines of the selection, or null when its place in the memo is not clear. */
  range: LineRange | null;
};

export type FloatOptions = {
  /** Positioned box the tab floats in, with the memo header as its first child. */
  host: HTMLElement;
  /** True while the AI button is hidden, so prompts are off. */
  disabled(): boolean;
  /** True while the bubble is open. The tab is not shown then. */
  bubbleOpen(): boolean;
  /** Editor and preview boxes whose selection counts. */
  selectionRoots(): HTMLElement[];
  text(): string;
  onPick(picked: Picked): void;
  /** Ends the document listeners. */
  signal: AbortSignal;
};

export type SelectionFloat = {
  hide(): void;
  contains(node: Node): boolean;
  remove(): void;
};

export function mountSelectionFloat(options: FloatOptions): SelectionFloat {
  const { host: hostEl } = options;
  /** The code block the pointer is over, when the tab stands for that block and not for a selection. */
  let hoverCode: HTMLTextAreaElement | null = null;
  let pointer = { x: 0, y: 0 };
  let floatTimer: number | undefined;

  const float = button("ai-float", "AI", () => {
    const found = selectedText();
    let picked: Picked;
    if (found) {
      picked = { text: found.text, range: resolveSelection(options.text(), found.text) };
    } else if (hoverCode) {
      const code = fieldSourceText(hoverCode);
      const at = locateBlock(splitLines(options.text()), splitLines(code));
      picked = {
        text: code,
        code: true,
        range: at < 0 ? null : { start: at, end: at + splitLines(code).length - 1 },
      };
    } else {
      hide();
      return;
    }
    hide();
    options.onPick(picked);
  });
  float.hidden = true;
  for (const type of ["mousedown", "pointerdown"] as const) {
    float.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  hostEl.append(float);

  function hide() {
    float.hidden = true;
    hoverCode = null;
  }

  const describe = (label: string) => {
    float.title = label;
    float.setAttribute("aria-label", label);
  };

  const headerTop = () => (hostEl.querySelector<HTMLElement>(":scope > header")?.offsetHeight ?? 36) + 2;

  /** Puts the tab in the top right corner of a code block while the pointer is over it. */
  function hoverFloat(event: MouseEvent) {
    if (options.disabled() || options.bubbleOpen() || selectedText()) {
      return;
    }
    const hit = event.target;
    if (!(hit instanceof Element) || float.contains(hit)) {
      return;
    }
    const field = hit.closest(".md-field");
    const area = field?.querySelector<HTMLTextAreaElement>('textarea[data-kind="code"]') ?? null;
    const inside = area !== null && options.selectionRoots().some((root) => root.contains(area));
    if (!field || !area || !inside || area.value.trim() === "") {
      if (hoverCode) {
        hide();
      }
      return;
    }
    if (hoverCode === area && !float.hidden) {
      return;
    }
    hoverCode = area;
    describe("Ask the model about this code block");
    const host = hostEl.getBoundingClientRect();
    const box = field.getBoundingClientRect();
    const top = headerTop();
    float.hidden = false;
    // Left of the corner, where the preview keeps its copy button.
    const x = box.right - host.left - float.offsetWidth - 34;
    const y = box.top - host.top + 3;
    float.style.left = `${Math.max(4, Math.min(x, host.width - float.offsetWidth - 6))}px`;
    float.style.top = `${Math.max(top, Math.min(y, host.height - float.offsetHeight - 6))}px`;
  }

  function selectedText(): { text: string; rect: DOMRect | null } | null {
    const roots = options.selectionRoots();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && roots.some((root) => root.contains(active))) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? 0;
      const text = active.value.slice(Math.min(start, end), Math.max(start, end));
      return text.trim().length > 1 ? { text, rect: null } : null;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const within = roots.some((root) => root.contains(range.commonAncestorContainer));
    const text = selection.toString();
    if (!within || text.trim().length <= 1) {
      return null;
    }
    const rects = range.getClientRects();
    return { text, rect: rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect() };
  }

  function placeFloat() {
    if (options.disabled() || options.bubbleOpen()) {
      hide();
      return;
    }
    const found = selectedText();
    if (!found) {
      if (!hoverCode) {
        hide();
      }
      return;
    }
    hoverCode = null;
    describe("Ask the model about the selection");
    const host = hostEl.getBoundingClientRect();
    const top = headerTop();
    const x = (found.rect ? found.rect.right : pointer.x) - host.left + 6;
    const y = (found.rect ? found.rect.top : pointer.y - 12) - host.top - 2;
    float.hidden = false;
    float.style.left = `${Math.max(4, Math.min(x, host.width - float.offsetWidth - 6))}px`;
    float.style.top = `${Math.max(top, Math.min(y, host.height - float.offsetHeight - 6))}px`;
  }

  function scheduleFloat() {
    window.clearTimeout(floatTimer);
    floatTimer = window.setTimeout(placeFloat, 140);
  }

  const until = { signal: options.signal };
  document.addEventListener("selectionchange", scheduleFloat, until);
  document.addEventListener(
    "mouseup",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      scheduleFloat();
    },
    until,
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.shiftKey || event.key.startsWith("Arrow")) {
        scheduleFloat();
      }
    },
    until,
  );
  document.addEventListener("mouseover", hoverFloat, until);

  return {
    hide,
    contains: (node) => float.contains(node),
    remove() {
      window.clearTimeout(floatTimer);
      float.remove();
    },
  };
}
