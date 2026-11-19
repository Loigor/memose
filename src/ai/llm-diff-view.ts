/** How a proposed edit reads in the AI chat: the line diff, the record of what was decided, the raw reply. */

import { el } from "../dom";
import { diffLines, hunksOf, locateBlock, splitLines, type DiffPart, type Hunk } from "../editor/line-diff";
import type { ChatEntry } from "./llm-settings";

/** A folded section in the chat. */
function fold(label: string, content: HTMLElement, open = false): HTMLElement {
  const details = el("details", "ai-fold");
  details.open = open;
  details.append(el("summary", "", label), content);
  return details;
}

/** The model's reply as it came, for an edit. */
export function modelOutput(entry: ChatEntry, open = false): HTMLElement {
  return fold("Model output", el("div", "ai-answer ai-raw", entry.text), open);
}

const line = (className: string, text: string) => el("div", className, text === "" ? " " : text);

/**
 * The diff of `parts`: long unchanged runs fold to their first and last line, and each change
 * shows its removed and added lines. `decorate` marks a change and adds its controls.
 */
export function diffList(parts: DiffPart[], decorate: (item: HTMLElement, hunk: Hunk) => void): HTMLElement {
  const list = el("div", "ai-diff");
  for (const part of parts) {
    if (part.kind === "same") {
      const lines = part.lines;
      const shown = lines.length > 4 ? [lines[0], null, lines[lines.length - 1]] : lines;
      for (const text of shown) {
        list.append(
          text === null ? el("div", "ai-line ai-gap", `${lines.length - 2} unchanged lines`) : line("ai-line", text),
        );
      }
      continue;
    }
    const { hunk } = part;
    const item = el("div", "ai-hunk");
    for (const text of hunk.removed) {
      item.append(line("ai-line ai-removed", text));
    }
    for (const text of hunk.added) {
      item.append(line("ai-line ai-added", text));
    }
    decorate(item, hunk);
    list.append(item);
  }
  return list;
}

/** A proposed edit after it was applied or dismissed: a line, then the changes folded. */
export function decidedBody(entry: ChatEntry): HTMLElement {
  const box = el("div", "ai-diff-box");
  const parts = diffLines(splitLines(entry.source), splitLines(entry.text));
  const all = hunksOf(parts);
  const taken = new Set(entry.status === "applied" ? (entry.accepted ?? all.map((hunk) => hunk.id)) : []);
  const count = all.filter((hunk) => taken.has(hunk.id)).length;
  const summary =
    entry.status === "applied"
      ? count === all.length
        ? `Applied ${count} ${count === 1 ? "change" : "changes"}.`
        : `Applied ${count} of ${all.length} changes.`
      : "Changes dismissed.";
  box.append(el("p", "ai-note", summary));
  if (all.length > 0) {
    // Accepted changes keep both sides visible, so the record shows what was replaced.
    const diff = diffList(parts, (item, hunk) => {
      item.dataset.decided = taken.has(hunk.id) ? "accepted" : "rejected";
      if (taken.has(hunk.id)) {
        item.dataset.shown = "both";
      }
    });
    box.append(fold(entry.status === "applied" ? "Show changes" : "Show proposed changes", diff));
  }
  box.append(modelOutput(entry));
  return box;
}

/**
 * Where the text a prompt was about sits in the memo now, or -1. New text written for an empty
 * memo goes after whatever the memo holds now.
 */
export function placeOf(lines: string[], before: string[], lineStart: number | null): number {
  if (before.length === 0) {
    return lineStart == null ? lines.length : -1;
  }
  return locateBlock(lines, before, lineStart ? lineStart - 1 : 0);
}
