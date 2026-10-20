import type { Block } from "./markdown-edit";

export function handleBlockMediaDeletion(
  container: HTMLElement,
  area: HTMLTextAreaElement,
  event: KeyboardEvent,
  getBlocks: () => Block[],
  removeMediaByIndex: (mediaIndex: number, focusBlockIndex: number, caretOffset: number) => void,
): boolean {
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
    return false;
  }
  if (area.selectionStart !== area.selectionEnd) {
    return false;
  }
  const index = Number(area.dataset.index);
  const items = getBlocks();
  if (event.key === "Backspace" && area.selectionStart === 0) {
    const prevBlock = items[index - 1];
    if (prevBlock?.kind === "media") {
      event.preventDefault();
      const beforeMedia = items[index - 2];
      const beforeLen = beforeMedia?.kind === "text" ? beforeMedia.text.length : 0;
      const targetTextIndex = Math.max(0, index - 2);
      const caretOffset = beforeLen > 0 && area.value.length > 0 ? beforeLen + 1 : beforeLen;
      removeMediaByIndex(index - 1, targetTextIndex, caretOffset);
      return true;
    }
  }
  if (event.key === "Delete" && area.selectionEnd === area.value.length) {
    const nextBlock = items[index + 1];
    if (nextBlock?.kind === "media") {
      event.preventDefault();
      const caretOffset = area.value.length;
      removeMediaByIndex(index + 1, index, caretOffset);
      return true;
    }
  }
  if (event.key === "ArrowLeft" && area.selectionStart === 0) {
    const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
    const pos = areas.indexOf(area);
    if (pos > 0) {
      event.preventDefault();
      const prev = areas[pos - 1];
      prev.focus();
      prev.setSelectionRange(prev.value.length, prev.value.length);
      return true;
    }
  }
  if (event.key === "ArrowRight" && area.selectionEnd === area.value.length) {
    const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
    const pos = areas.indexOf(area);
    if (pos >= 0 && pos < areas.length - 1) {
      event.preventDefault();
      const next = areas[pos + 1];
      next.focus();
      next.setSelectionRange(0, 0);
      return true;
    }
  }
  return false;
}

export function handleBlockAreaNavigation(
  container: HTMLElement,
  area: HTMLTextAreaElement,
  event: KeyboardEvent,
): boolean {
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
    return false;
  }
  if (event.key === "ArrowUp" && area.selectionStart === area.selectionEnd) {
    const before = area.value.slice(0, area.selectionStart);
    if (!before.includes("\n")) {
      const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
      const pos = areas.indexOf(area);
      if (pos > 0) {
        event.preventDefault();
        const prev = areas[pos - 1];
        prev.focus();
        prev.setSelectionRange(prev.value.length, prev.value.length);
        return true;
      }
    }
  }
  if (event.key === "ArrowDown" && area.selectionStart === area.selectionEnd) {
    const after = area.value.slice(area.selectionEnd);
    if (!after.includes("\n")) {
      const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
      const pos = areas.indexOf(area);
      if (pos >= 0 && pos < areas.length - 1) {
        event.preventDefault();
        const next = areas[pos + 1];
        next.focus();
        next.setSelectionRange(0, 0);
        return true;
      }
    }
  }
  return false;
}

export function syncInlineLineSlot(
  area: HTMLTextAreaElement,
  prevBlock: Block | undefined,
  row: HTMLElement | null,
  container: HTMLElement,
  isLast: boolean,
) {
  if (prevBlock?.kind !== "media") {
    return;
  }
  const hasNewline = area.value.includes("\n");
  if (hasNewline) {
    prevBlock.inline = false;
    if (area.classList.contains("inline-line-slot")) {
      area.classList.remove("inline-line-slot");
      if (isLast) {
        area.classList.add("grow");
      }
      if (row && area.parentElement === row) {
        row.after(area);
      } else if (area.parentElement !== container) {
        container.append(area);
      }
    }
  } else {
    prevBlock.inline = area.value.length > 0;
    if (row && !area.classList.contains("inline-line-slot")) {
      area.classList.add("inline-line-slot");
      area.classList.remove("grow");
      row.append(area);
    }
  }
}
