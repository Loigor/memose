import { ensureTextSlots, type Block } from "./markdown-edit.ts";
import { editorShell, estimateCharOffsetInLine, measureTextareaLines } from "./textarea.ts";

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
      const shell = editorShell(area);
      if (row && shell.parentElement === row) {
        row.after(shell);
      } else if (shell.parentElement !== container) {
        container.append(shell);
      }
    }
  } else {
    prevBlock.inline = area.value.length > 0;
    if (row && !area.classList.contains("inline-line-slot")) {
      area.classList.add("inline-line-slot");
      area.classList.remove("grow");
      row.append(editorShell(area));
    }
  }
}

export type MediaDropTarget =
  | {
      mode: "line";
      blockIndex: number;
      lineIndex: number;
      y: number;
    }
  | {
      mode: "inline";
      blockIndex: number;
      charOffset: number;
      x: number;
      top: number;
      height: number;
    };

export function findMediaDropTarget(
  container: HTMLElement,
  figure: HTMLElement,
  fromIndex: number,
  clientX: number,
  clientY: number,
): MediaDropTarget | null {
  const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea[data-index]")];
  for (const area of areas) {
    const aRect = area.getBoundingClientRect();
    if (
      area.value.length > 0 &&
      clientY >= aRect.top + 2 &&
      clientY <= aRect.bottom - 2 &&
      clientX >= aRect.left &&
      clientX <= aRect.right
    ) {
      const blockIndex = Number(area.dataset.index);
      const lines = measureTextareaLines(area);
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
        const lm = lines[lineIdx];
        const lineHeight = Math.max(16, lm.bottom - lm.top);
        const distTop = clientY - lm.top;
        const distBottom = lm.bottom - clientY;
        const inMiddleBand = distTop >= 5 && distBottom >= 5;
        if (inMiddleBand && lm.text.length > 0) {
          const charOffset = estimateCharOffsetInLine(area, lm, clientX);
          let caretX = lm.left;
          if (charOffset > lm.startOffset) {
            const ratio = (charOffset - lm.startOffset) / Math.max(1, lm.text.length);
            caretX = Math.min(aRect.right - 4, lm.left + (lm.right - lm.left) * ratio);
          }
          return {
            mode: "inline",
            blockIndex,
            charOffset,
            x: Math.max(aRect.left + 2, Math.min(aRect.right - 2, clientX < lm.right + 16 ? clientX : caretX)),
            top: lm.top + 2,
            height: lineHeight - 4,
          };
        }
      }
    }
  }

  const candidates: Extract<MediaDropTarget, { mode: "line" }>[] = [];
  for (const area of areas) {
    const blockIndex = Number(area.dataset.index);
    const lines = measureTextareaLines(area);
    const boundaries =
      area.value.length === 0 ? [lines[0].top] : [lines[0].top, ...lines.map((l) => l.bottom)];
    const maxLineIndex = boundaries.length - 1;
    boundaries.forEach((y, lineIndex) => {
      if (blockIndex === fromIndex - 1 && lineIndex === maxLineIndex) {
        return;
      }
      if (blockIndex === fromIndex + 1 && lineIndex === 0) {
        return;
      }
      candidates.push({ mode: "line", blockIndex, lineIndex, y });
    });
  }
  if (candidates.length === 0) {
    return null;
  }
  let best = candidates[0];
  let bestDist = Math.abs(clientY - best.y);
  for (let i = 1; i < candidates.length; i += 1) {
    const d = Math.abs(clientY - candidates[i].y);
    if (d < bestDist) {
      best = candidates[i];
      bestDist = d;
    }
  }
  const figRect = figure.getBoundingClientRect();
  const figCenter = (figRect.top + figRect.bottom) / 2;
  if (clientY >= figRect.top + 6 && clientY <= figRect.bottom - 6 && Math.abs(clientY - figCenter) < bestDist) {
    return null;
  }
  return best;
}

export function moveBlockMedia(items: Block[], fromIndex: number, target: MediaDropTarget): Block[] {
  const moved = items[fromIndex];
  if (!moved || moved.kind !== "media") {
    return items;
  }
  const next: Block[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (i === fromIndex) {
      continue;
    }
    const block = items[i];
    if (i === target.blockIndex && block.kind === "text") {
      if (target.mode === "inline") {
        const offset = Math.max(0, Math.min(block.text.length, target.charOffset));
        const before = block.text.slice(0, offset);
        const after = block.text.slice(offset);
        if (before.length > 0) {
          next.push({ kind: "text", text: before });
        }
        next.push({
          kind: "media",
          name: moved.name,
          label: moved.label,
          width: moved.width,
          inline: true,
        });
        if (after.length > 0) {
          next.push({ kind: "text", text: after });
        }
      } else if (block.text.length === 0) {
        next.push({
          kind: "media",
          name: moved.name,
          label: moved.label,
          width: moved.width,
          inline: false,
        });
      } else {
        const lines = block.text.split("\n");
        const k = Math.max(0, Math.min(lines.length, target.lineIndex));
        const before = lines.slice(0, k).join("\n");
        const after = lines.slice(k).join("\n");
        if (k > 0) {
          next.push({ kind: "text", text: before });
        }
        next.push({
          kind: "media",
          name: moved.name,
          label: moved.label,
          width: moved.width,
          inline: false,
        });
        if (k < lines.length) {
          next.push({ kind: "text", text: after });
        }
      }
      continue;
    }
    if (block.kind === "text") {
      if (block.text.length > 0) {
        next.push({ kind: "text", text: block.text });
      }
    } else if (block.kind === "code") {
      next.push({ kind: "code", lang: block.lang, text: block.text });
    } else {
      next.push({
        kind: "media",
        name: block.name,
        label: block.label,
        width: block.width,
        inline: block.inline,
      });
    }
  }
  return ensureTextSlots(next);
}

export function applyMediaFigureSize(figure: HTMLElement, width?: number) {
  const target = figure.querySelector<HTMLElement>("img, .media-video-wrap");
  if (!target) {
    return;
  }
  if (width && width >= 40) {
    figure.dataset.width = String(Math.round(width));
    target.style.width = `${Math.round(width)}px`;
    if (target instanceof HTMLImageElement) {
      target.style.maxHeight = "none";
    }
    const video = target.querySelector<HTMLVideoElement>("video");
    if (video) {
      video.style.maxHeight = "none";
    }
  } else {
    delete figure.dataset.width;
    target.style.width = "";
    if (target instanceof HTMLImageElement) {
      target.style.maxHeight = "";
    }
    const video = target.querySelector<HTMLVideoElement>("video");
    if (video) {
      video.style.maxHeight = "";
    }
  }
}
