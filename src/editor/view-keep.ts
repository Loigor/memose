/** Keeping a memo's scroll place across redraws, and marking text in it without changing it. */

/** The boxes that scroll the given fields: the fields themselves and their scrolling ancestors. */
export function scrollers(roots: HTMLElement[]): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const root of roots) {
    for (let node: HTMLElement | null = root; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`)) {
        found.add(node);
      }
    }
  }
  return [...found];
}

/**
 * Runs `redraw` and puts every scrolling box back where it was. A redraw empties the
 * box for a moment, which would otherwise snap it to the top.
 */
export function keepScroll<T>(roots: HTMLElement[], redraw: () => T): T {
  const saved = scrollers(roots).map((box) => [box, box.scrollTop] as const);
  const result = redraw();
  for (const [box, top] of saved) {
    if (box.isConnected) {
      box.scrollTop = top;
    }
  }
  return result;
}

/** Scrolls the smallest scrolling box that holds `rect` just enough to show it. */
export function revealRect(roots: HTMLElement[], rect: DOMRect | null, margin = 28) {
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
    return;
  }
  for (const box of scrollers(roots)) {
    if (box.scrollHeight <= box.clientHeight + 1) {
      continue;
    }
    const view = box.getBoundingClientRect();
    if (rect.bottom + margin > view.bottom) {
      box.scrollTop += rect.bottom + margin - view.bottom;
    } else if (rect.top - margin < view.top) {
      box.scrollTop -= view.top - (rect.top - margin);
    }
    return;
  }
}

type TextNodes = { nodes: Text[]; starts: number[]; text: string };

function textNodes(root: HTMLElement): TextNodes {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && !node.parentElement?.closest(".rec-tools, .rec-live, .media")) {
      nodes.push(node);
      starts.push(text.length);
      text += node.data;
    }
  }
  return { nodes, starts, text };
}

function pointAt(found: TextNodes, offset: number, end: boolean): { node: Text; at: number } | null {
  for (let i = found.nodes.length - 1; i >= 0; i -= 1) {
    const start = found.starts[i];
    const length = found.nodes[i].data.length;
    if (offset > start || (offset === start && !end) || (offset === start && length === 0)) {
      if (offset <= start + length) {
        return { node: found.nodes[i], at: offset - start };
      }
    }
  }
  return null;
}

/**
 * Ranges over `text` as it shows in the fields. Lines are drawn as separate rows, so line
 * breaks are left out of the search. With `before`, the last match before that node wins;
 * otherwise the last match.
 */
export function findTextRanges(roots: HTMLElement[], text: string, before?: Node | null): Range[] {
  const needle = text.replace(/\n+/g, "");
  if (needle.trim() === "") {
    return [];
  }
  let best: Range | null = null;
  for (const root of roots) {
    const found = textNodes(root);
    for (let at = found.text.indexOf(needle); at >= 0; at = found.text.indexOf(needle, at + 1)) {
      const start = pointAt(found, at, false);
      const end = pointAt(found, at + needle.length, true);
      if (!start || !end) {
        continue;
      }
      const range = document.createRange();
      range.setStart(start.node, start.at);
      range.setEnd(end.node, end.at);
      // Matches after `before` in the document are not the ones meant.
      if (before && before.compareDocumentPosition(range.endContainer) & Node.DOCUMENT_POSITION_FOLLOWING) {
        continue;
      }
      best = range;
    }
  }
  return best ? [best] : [];
}

type HighlightKind = "dictation" | "rewording";

/** Ranges per kind and per owner, so several memos in one window share one highlight. */
const marked = new Map<HighlightKind, Map<object, Range[]>>();

/**
 * Marks ranges with the `::highlight(kind)` style. Each owner replaces only its own ranges.
 * Without the CSS Highlight API, nothing is marked.
 */
export function setHighlight(kind: HighlightKind, owner: object, ranges: Range[]) {
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const HighlightType = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const owners = marked.get(kind) ?? new Map<object, Range[]>();
  marked.set(kind, owners);
  if (ranges.length > 0) {
    owners.set(owner, ranges);
  } else {
    owners.delete(owner);
  }
  if (!registry || !HighlightType) {
    return;
  }
  const all = [...owners.values()].flat();
  if (all.length === 0) {
    registry.delete(kind);
  } else {
    registry.set(kind, new HighlightType(...all));
  }
}

/** The ranges of one kind marked now, for tests. */
export function highlighted(kind: HighlightKind): string[] {
  return [...(marked.get(kind)?.values() ?? [])].flat().map((range) => range.toString());
}
