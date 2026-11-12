import { activeField, fieldAt } from "./editable.ts";
import { serializeBlocks, type Block } from "./markdown-edit.ts";

export type Caret = { index: number; start: number; end: number };

export type EditorPlace = {
  caret: Caret;
  scrollTop: number;
  scrollLeft: number;
  paneScroll: number;
};

export function restoreCaret(container: ParentNode, next: Caret | null) {
  if (!next) {
    return;
  }
  const area = fieldAt(container, next.index);
  if (area) {
    area.focus();
    const s = Math.min(next.start, area.value.length);
    const e = Math.min(next.end, area.value.length);
    area.setSelectionRange(s, e);
  }
}

export function readPlace(container: ParentNode, caret: Caret | null): EditorPlace | null {
  const live = activeField(container) ?? (caret ? fieldAt(container, caret.index) : null);
  const paneScroll = "scrollTop" in container ? (container as HTMLElement).scrollTop : 0;
  if (!live) {
    return caret ? { caret: { ...caret }, scrollTop: 0, scrollLeft: 0, paneScroll } : null;
  }
  return {
    caret: {
      index: Number(live.dataset.index ?? caret?.index ?? 0),
      start: live.selectionStart ?? live.value.length,
      end: live.selectionEnd ?? live.value.length,
    },
    scrollTop: live.scrollTop,
    scrollLeft: live.scrollLeft,
    paneScroll,
  };
}

export function restorePlace(
  container: ParentNode,
  place: EditorPlace | null,
  focus = true,
): boolean {
  if (!place) {
    return false;
  }
  const area = fieldAt(container, place.caret.index);
  if (!area) {
    return false;
  }
  if (focus) {
    restoreCaret(container, place.caret);
  }
  area.scrollTop = place.scrollTop;
  area.scrollLeft = place.scrollLeft;
  if ("scrollTop" in container) {
    (container as HTMLElement).scrollTop = place.paneScroll;
  }
  return true;
}

export type LineMarks = number[][];

export type NoteHistoryEntry = {
  blocks: Block[];
  caret: Caret | null;
  marks: LineMarks;
  folds: LineMarks;
};

function cloneMarks(marks: LineMarks | undefined): LineMarks {
  return (marks ?? []).map((lines) => (lines ? [...lines] : []));
}

function marksKey(marks: LineMarks | undefined): string {
  const rows = marks ?? [];
  let out = "";
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0) {
      out += "|";
    }
    out += (rows[index] ?? []).join(".");
  }
  return out;
}

function sameSnapshot(
  blocks: Block[],
  marks: LineMarks | undefined,
  folds: LineMarks | undefined,
  entry: NoteHistoryEntry,
): boolean {
  return (
    serializeBlocks(entry.blocks) === serializeBlocks(blocks) &&
    marksKey(entry.marks) === marksKey(marks) &&
    marksKey(entry.folds) === marksKey(folds)
  );
}

export function cloneBlocks(items: Block[]): Block[] {
  return items.map((b) =>
    b.kind === "text"
      ? { kind: "text", text: b.text }
      : b.kind === "code"
        ? { kind: "code", lang: b.lang, text: b.text }
        : {
            kind: "media",
            name: b.name,
            label: b.label,
            width: b.width,
            inline: b.inline,
          },
  );
}

function blockKey(block: Block): string {
  if (block.kind === "text") {
    return `text:${block.text}`;
  }
  if (block.kind === "code") {
    return `code:${block.lang}\n${block.text}`;
  }
  return `media:${block.name}:${block.label}:${block.width ?? ""}:${block.inline ?? ""}`;
}

export function remapBlockLines(before: Block[], after: Block[], rows: LineMarks): LineMarks {
  const targets = new Map<string, number[]>();
  after.forEach((block, index) => {
    const key = blockKey(block);
    const indexes = targets.get(key) ?? [];
    indexes.push(index);
    targets.set(key, indexes);
  });
  const mapped = Array.from({ length: after.length }, () => [] as number[]);
  before.forEach((block, index) => {
    const target = targets.get(blockKey(block))?.shift();
    if (target !== undefined) {
      mapped[target] = [...(rows[index] ?? [])];
    }
  });
  return mapped;
}

export class BlockHistory {
  undoStack: NoteHistoryEntry[] = [];
  redoStack: NoteHistoryEntry[] = [];
  lastInputSnapAt = 0;

  shouldCapture(force = true): boolean {
    return force || this.undoStack.length === 0 || performance.now() - this.lastInputSnapAt >= 900;
  }

  push(blocks: Block[], caret: Caret | null, force = true, marks: LineMarks = [], folds: LineMarks = []) {
    if (!this.shouldCapture(force)) {
      return;
    }
    const now = performance.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && sameSnapshot(blocks, marks, folds, top)) {
      top.caret = caret ? { ...caret } : null;
      return;
    }
    this.undoStack.push({
      blocks: cloneBlocks(blocks),
      caret: caret ? { ...caret } : null,
      marks: cloneMarks(marks),
      folds: cloneMarks(folds),
    });
    if (this.undoStack.length > 60) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    // A discrete edit starts a new typing group, so the next keystroke is its own undo.
    this.lastInputSnapAt = force ? 0 : now;
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.lastInputSnapAt = 0;
  }

  takeUndo(
    currentBlocks: Block[],
    currentCaret: Caret | null,
    currentMarks: LineMarks = [],
    currentFolds: LineMarks = [],
  ): NoteHistoryEntry | null {
    if (this.undoStack.length === 0) {
      return null;
    }
    let entry = this.undoStack.pop()!;
    while (this.undoStack.length > 0 && sameSnapshot(currentBlocks, currentMarks, currentFolds, entry)) {
      entry = this.undoStack.pop()!;
    }
    if (sameSnapshot(currentBlocks, currentMarks, currentFolds, entry)) {
      return null;
    }
    this.redoStack.push({
      blocks: cloneBlocks(currentBlocks),
      caret: currentCaret ? { ...currentCaret } : null,
      marks: cloneMarks(currentMarks),
      folds: cloneMarks(currentFolds),
    });
    this.lastInputSnapAt = 0;
    return entry;
  }

  takeRedo(
    currentBlocks: Block[],
    currentCaret: Caret | null,
    currentMarks: LineMarks = [],
    currentFolds: LineMarks = [],
  ): NoteHistoryEntry | null {
    if (this.redoStack.length === 0) {
      return null;
    }
    const entry = this.redoStack.pop()!;
    this.undoStack.push({
      blocks: cloneBlocks(currentBlocks),
      caret: currentCaret ? { ...currentCaret } : null,
      marks: cloneMarks(currentMarks),
      folds: cloneMarks(currentFolds),
    });
    this.lastInputSnapAt = 0;
    return entry;
  }
}
