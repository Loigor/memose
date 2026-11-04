import {
  applyMediaFigureSize,
  findMediaDropTarget,
  moveBlockMedia,
  type MediaDropTarget,
} from "./editor-blocks";
import { displayFileName, isAudio, isImage, isVideo, type Block } from "./markdown-edit";
import {
  createAudioElement,
  createFileAttachmentChip,
  createVideoPreviewElement,
  mediaPointer,
  mediaSrc,
  showMediaContextMenu,
} from "./media-elements";
import { resizeAllBlockTextareas } from "./textarea";

export type MediaNoteMutator = {
  getBlocks: () => Block[];
  setBlocks: (blocks: Block[]) => void;
  pushUndo: (force?: boolean) => void;
  afterMove: () => void;
  afterWidth: () => void;
  removeMediaAt: (index: number, name: string) => void;
};

export type MediaEditorBindings = {
  hostContainer: HTMLElement;
  host: MediaNoteMutator;
  forSection: (section: HTMLElement) => MediaNoteMutator | null;
  openPreview: (name: string) => void;
};

type MediaDragSession = {
  figure: HTMLElement;
  container: HTMLElement;
  section: HTMLElement | null;
  name: string;
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  ghost: HTMLElement | null;
  indicator: HTMLElement | null;
  target: MediaDropTarget | null;
};

type MediaResizeSession = {
  figure: HTMLElement;
  targetEl: HTMLElement;
  section: HTMLElement | null;
  blockIndex: number;
  pointerId: number;
  startX: number;
  startWidth: number;
  maxWidth: number;
  currentWidth: number;
};

let bindings: MediaEditorBindings | null = null;
let activeMediaDrag: MediaDragSession | null = null;
let activeMediaResize: MediaResizeSession | null = null;

export function bindMediaEditor(next: MediaEditorBindings) {
  bindings = next;
}

export function isDraggingMedia(): boolean {
  return mediaPointer.draggingName !== null;
}

function mutatorFor(section: HTMLElement | null): MediaNoteMutator | null {
  if (!bindings) {
    return null;
  }
  if (section) {
    return bindings.forSection(section);
  }
  return bindings.host;
}

function finishMediaDrag(commit: boolean) {
  const drag = activeMediaDrag;
  if (!drag) {
    return;
  }
  activeMediaDrag = null;
  drag.ghost?.remove();
  drag.indicator?.remove();
  drag.figure.classList.remove("is-dragging");
  document.body.classList.remove("is-dragging-media");
  mediaPointer.draggingName = null;
  if (!drag.started) {
    return;
  }
  if (commit && drag.target) {
    const mut = mutatorFor(drag.section);
    if (mut) {
      mut.pushUndo(true);
      mut.setBlocks(moveBlockMedia(mut.getBlocks(), drag.fromIndex, drag.target));
      mut.afterMove();
    }
  }
  window.setTimeout(() => {
    mediaPointer.dragged = false;
  }, 0);
}

window.addEventListener("pointermove", (event) => {
  const drag = activeMediaDrag;
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.started) {
    if (Math.hypot(dx, dy) < 5) {
      return;
    }
    drag.started = true;
    mediaPointer.draggingName = drag.name;
    mediaPointer.dragged = true;
    drag.figure.classList.add("is-dragging");
    document.body.classList.add("is-dragging-media");

    const indicator = document.createElement("div");
    indicator.className = "media-drop-indicator";
    indicator.hidden = true;
    document.body.append(indicator);
    drag.indicator = indicator;

    const ghost = document.createElement("div");
    ghost.className = "media-drag-ghost";
    ghost.textContent = displayFileName(drag.name, drag.figure.dataset.label);
    document.body.append(ghost);
    drag.ghost = ghost;
  }

  if (drag.ghost) {
    drag.ghost.style.left = `${event.clientX + 12}px`;
    drag.ghost.style.top = `${event.clientY + 12}px`;
  }

  const cRect = drag.container.getBoundingClientRect();
  if (event.clientY < cRect.top + 28) {
    drag.container.scrollTop -= 8;
  } else if (event.clientY > cRect.bottom - 28) {
    drag.container.scrollTop += 8;
  }

  const target = findMediaDropTarget(
    drag.container,
    drag.figure,
    drag.fromIndex,
    event.clientX,
    event.clientY,
  );
  drag.target = target;
  if (drag.indicator) {
    if (target) {
      if (target.mode === "inline") {
        const clampedTop = Math.max(cRect.top + 2, Math.min(cRect.bottom - 16, target.top));
        drag.indicator.classList.add("is-caret");
        drag.indicator.style.left = `${target.x}px`;
        drag.indicator.style.top = `${clampedTop}px`;
        drag.indicator.style.width = "2px";
        drag.indicator.style.height = `${Math.max(14, target.height)}px`;
      } else {
        const clampedY = Math.max(cRect.top + 2, Math.min(cRect.bottom - 2, target.y));
        drag.indicator.classList.remove("is-caret");
        drag.indicator.style.left = `${cRect.left + 12}px`;
        drag.indicator.style.width = `${Math.max(40, cRect.width - 24)}px`;
        drag.indicator.style.height = "2px";
        drag.indicator.style.top = `${clampedY}px`;
      }
      drag.indicator.hidden = false;
    } else {
      drag.indicator.hidden = true;
    }
  }
});

window.addEventListener("pointerup", (event) => {
  if (activeMediaDrag && event.pointerId === activeMediaDrag.pointerId) {
    finishMediaDrag(true);
  }
});

window.addEventListener("pointercancel", (event) => {
  if (activeMediaDrag && event.pointerId === activeMediaDrag.pointerId) {
    finishMediaDrag(false);
  }
});

function commitMediaWidth(section: HTMLElement | null, blockIndex: number, width: number | undefined) {
  const mut = mutatorFor(section);
  if (!mut) {
    return;
  }
  const block = mut.getBlocks()[blockIndex];
  if (block?.kind === "media" && block.width !== width) {
    mut.pushUndo(true);
    block.width = width;
    mut.afterWidth();
  }
}

window.addEventListener("pointermove", (event) => {
  const rs = activeMediaResize;
  if (!rs || event.pointerId !== rs.pointerId) {
    return;
  }
  const dx = event.clientX - rs.startX;
  const nextW = Math.round(Math.max(48, Math.min(rs.maxWidth, rs.startWidth + dx)));
  rs.currentWidth = nextW;
  applyMediaFigureSize(rs.figure, nextW);
  resizeAllBlockTextareas(rs.section ?? bindings?.hostContainer ?? document);
});

function finishMediaResize(commit: boolean) {
  const rs = activeMediaResize;
  if (!rs) {
    return;
  }
  activeMediaResize = null;
  rs.figure.classList.remove("is-resizing");
  document.body.classList.remove("is-resizing-media");
  if (commit) {
    commitMediaWidth(rs.section, rs.blockIndex, rs.currentWidth);
  }
  window.setTimeout(() => {
    mediaPointer.dragged = false;
  }, 0);
}

window.addEventListener("pointerup", (event) => {
  if (activeMediaResize && event.pointerId === activeMediaResize.pointerId) {
    finishMediaResize(true);
  }
});

window.addEventListener("pointercancel", (event) => {
  if (activeMediaResize && event.pointerId === activeMediaResize.pointerId) {
    finishMediaResize(false);
  }
});

export function createMedia(name: string, label?: string, section?: HTMLElement | null, width?: number): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "media";
  figure.dataset.media = name;
  if (label) {
    figure.dataset.label = label;
  }
  figure.draggable = false;

  let resizableTarget: HTMLElement | null = null;
  if (isVideo(name)) {
    const videoWrap = createVideoPreviewElement(name, label);
    figure.append(videoWrap);
    resizableTarget = videoWrap;
  } else if (isAudio(name)) {
    const audioWrap = createAudioElement(name, label);
    figure.append(audioWrap);
  } else if (isImage(name)) {
    const img = document.createElement("img");
    img.alt = label ?? "";
    img.draggable = false;
    void mediaSrc(name).then((src) => {
      img.src = src;
    });
    img.addEventListener("click", () => {
      if (mediaPointer.dragged) {
        mediaPointer.dragged = false;
        return;
      }
      bindings?.openPreview(name);
    });
    figure.append(img);
    resizableTarget = img;
  } else {
    const chip = createFileAttachmentChip(name, label);
    figure.append(chip);
  }

  if (resizableTarget) {
    applyMediaFigureSize(figure, width);
    const grip = document.createElement("div");
    grip.className = "media-resize-grip";
    grip.title = "Drag to resize (double-click to reset)";
    grip.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const idx = Number(figure.dataset.index);
      applyMediaFigureSize(figure, undefined);
      commitMediaWidth(section ?? null, idx, undefined);
    });
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !resizableTarget) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      mediaPointer.dragged = true;
      const container = figure.closest<HTMLElement>("#blocks, .stack-blocks");
      const maxWidth = container ? Math.max(80, container.clientWidth - 8) : 600;
      const rect = resizableTarget.getBoundingClientRect();
      const startWidth = Math.max(48, Math.round(rect.width));
      const blockIndex = Number(figure.dataset.index);
      figure.classList.add("is-resizing");
      document.body.classList.add("is-resizing-media");
      activeMediaResize = {
        figure,
        targetEl: resizableTarget,
        section: section ?? null,
        blockIndex,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
        maxWidth,
        currentWidth: startWidth,
      };
    });
    figure.append(grip);
  }

  figure.addEventListener("contextmenu", (event) => {
    const idx = Number(figure.dataset.index);
    showMediaContextMenu(event, name, {
      onRemove: () => {
        const mut = mutatorFor(section ?? null);
        mut?.removeMediaAt(idx, name);
      },
      onPreview: (mediaName) => {
        bindings?.openPreview(mediaName);
      },
    });
  });

  figure.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("audio, .media-resize-grip")) {
        return;
      }
      if (target instanceof HTMLVideoElement) {
        const vRect = target.getBoundingClientRect();
        if (event.clientY > vRect.bottom - 38) {
          return;
        }
      }
    }
    const container = figure.closest<HTMLElement>("#blocks, .stack-blocks");
    if (!container) {
      return;
    }
    event.stopPropagation();
    const fromIndex = Number(figure.dataset.index);
    activeMediaDrag = {
      figure,
      container,
      section: section ?? null,
      name,
      fromIndex,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      ghost: null,
      indicator: null,
      target: null,
    };
  });

  return figure;
}
