import { serializeBlocks, type Block } from "./markdown-edit.ts";

export type Caret = { index: number; start: number; end: number };

export function restoreCaret(container: ParentNode, next: Caret | null) {
  if (!next) {
    return;
  }
  const area = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${next.index}"]`);
  if (area) {
    area.focus();
    const s = Math.min(next.start, area.value.length);
    const e = Math.min(next.end, area.value.length);
    area.setSelectionRange(s, e);
  }
}

export type NoteHistoryEntry = {
  blocks: Block[];
  caret: Caret | null;
};

export function cloneBlocks(items: Block[]): Block[] {
  return items.map((b) =>
    b.kind === "text"
      ? { kind: "text", text: b.text }
      : {
          kind: "media",
          name: b.name,
          label: b.label,
          width: b.width,
          inline: b.inline,
        },
  );
}

export class BlockHistory {
  undoStack: NoteHistoryEntry[] = [];
  redoStack: NoteHistoryEntry[] = [];
  lastInputSnapAt = 0;

  push(blocks: Block[], caret: Caret | null, force = true) {
    const now = performance.now();
    if (!force && now - this.lastInputSnapAt < 900 && this.undoStack.length > 0) {
      return;
    }
    const serialized = serializeBlocks(blocks);
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && serializeBlocks(top.blocks) === serialized) {
      top.caret = caret ? { ...caret } : null;
      return;
    }
    this.undoStack.push({
      blocks: cloneBlocks(blocks),
      caret: caret ? { ...caret } : null,
    });
    if (this.undoStack.length > 60) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    if (!force) {
      this.lastInputSnapAt = now;
    }
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.lastInputSnapAt = 0;
  }

  takeUndo(currentBlocks: Block[], currentCaret: Caret | null): NoteHistoryEntry | null {
    if (this.undoStack.length === 0) {
      return null;
    }
    const currentSerialized = serializeBlocks(currentBlocks);
    let entry = this.undoStack.pop()!;
    while (this.undoStack.length > 0 && serializeBlocks(entry.blocks) === currentSerialized) {
      entry = this.undoStack.pop()!;
    }
    if (serializeBlocks(entry.blocks) === currentSerialized) {
      return null;
    }
    this.redoStack.push({
      blocks: cloneBlocks(currentBlocks),
      caret: currentCaret ? { ...currentCaret } : null,
    });
    this.lastInputSnapAt = 0;
    return entry;
  }

  takeRedo(currentBlocks: Block[], currentCaret: Caret | null): NoteHistoryEntry | null {
    if (this.redoStack.length === 0) {
      return null;
    }
    const entry = this.redoStack.pop()!;
    this.undoStack.push({
      blocks: cloneBlocks(currentBlocks),
      caret: currentCaret ? { ...currentCaret } : null,
    });
    this.lastInputSnapAt = 0;
    return entry;
  }
}
