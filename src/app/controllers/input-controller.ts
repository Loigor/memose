import { editingHost, type Editable } from "../../editor/editable";
import { tagAtOffset } from "../../editor/md-tags";
import { filesFromTransfer, uniqueFiles } from "../../media/files";
import { isDraggingMedia } from "../../media/media-dnd";
import {
  closeMediaContextMenu,
  mediaContextMenuOpen,
} from "../../media/media-elements";
import { inTauri, isPreviewWindow } from "../../platform";
import {
  domMouseButton,
  formatBind,
  isModifierKey,
  matchBind,
  matchMouse,
  modifierDown,
  type ShortcutBinds,
} from "../../shortcuts";
import type { AppContext } from "../context";
import type { InputState } from "../state";
import type { AudienceController } from "./audience-controller";
import type { EditorController } from "./editor-controller";
import type { LookController } from "./look-controller";
import type { RecentController } from "./recent-controller";
import type { SessionController } from "./session-controller";

export type MouseChordPayload = {
  button: number;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
};

export interface StackInput {
  activeSection(): HTMLElement | null;
  insertPlainText(text: string, section: HTMLElement): void;
  undo(section: HTMLElement): boolean;
  redo(section: HTMLElement): boolean;
  dragBlocked(target: EventTarget | null): boolean;
  startWindowDrag(event: MouseEvent): void;
  syncCollapsedPeek(): void;
  refreshPreviewShortcut(shortcut: string): void;
}

export interface InputController {
  altHeld(): boolean;
  gestureActive(event: MouseEvent): boolean;
  previewShortcut(): string;
  applyShortcuts(binds: ShortcutBinds): void;
  handleMouseChord(payload: MouseChordPayload): void;
}

export function createInputController(
  context: AppContext,
  state: InputState,
  editor: EditorController,
  session: SessionController,
  recent: RecentController,
  audience: AudienceController,
  look: LookController,
  stack: StackInput,
): InputController {
  const {
    card,
    notePane,
    notesRoot,
    editorTools,
    formatPop,
    colorPop,
    visibilityLabel,
    audiencePop,
  } = context.dom;

  function altHeld() {
    return state.altHeld;
  }

  function gestureActive(event: MouseEvent) {
    return state.gestureHeld || modifierDown(state.binds.gesture, event);
  }

  function previewShortcut() {
    return formatBind(state.binds.preview);
  }

  function editorTagArea(target: EventTarget | null): Editable | null {
    const field = editingHost(target);
    if (!field || field.dataset.kind === "code") {
      return null;
    }
    return field;
  }

  function tagSpan(target: EventTarget | null): string | null {
    const el = target instanceof Element ? target : target instanceof Text ? target.parentElement : null;
    const tag = el?.closest(".md-tag");
    if (!(tag instanceof HTMLElement) || tag.closest("pre, code")) {
      return null;
    }
    const value = tag.dataset.tag || tag.textContent || "";
    return value.startsWith("#") ? value : null;
  }

  function tagFromEvent(event: MouseEvent): string | null {
    const area = editorTagArea(event.target);
    if (area) {
      if (area.selectionStart !== area.selectionEnd) {
        return null;
      }
      const atPoint = editor.offsetInField(area, event.clientX, event.clientY);
      if (atPoint != null) {
        return tagAtOffset(area.value, atPoint);
      }
      const rect = area.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        return null;
      }
      return tagAtOffset(area.value, area.selectionStart ?? area.value.length);
    }
    if (!(event.target instanceof Element) || event.target.closest(".md-field[data-coder], pre, code")) {
      return null;
    }
    const tag = event.target.closest(".md-tag");
    if (!(tag instanceof HTMLElement)) {
      return null;
    }
    const value = tag.dataset.tag || tag.textContent || "";
    return value.startsWith("#") ? value : null;
  }

  function paintTagCursor(area: Editable, x: number, y: number) {
    if (!editorTagArea(area)) {
      area.style.removeProperty("cursor");
      return;
    }
    const offset = editor.offsetInField(area, x, y);
    if (offset != null && tagAtOffset(area.value, offset)) {
      area.style.cursor = "pointer";
      return;
    }
    area.style.removeProperty("cursor");
  }

  function insertPlainText(text: string, targetSection?: HTMLElement | null) {
    if (targetSection) {
      stack.insertPlainText(text, targetSection);
      return;
    }
    editor.insertPlainText(text);
  }

  function hideMemos() {
    void context.backend.hideMemos().catch((error: unknown) => {
      console.error(error);
    });
  }

  function applyShortcuts(binds: ShortcutBinds) {
    state.binds = binds;
    const shortcut = previewShortcut();
    editor.refreshPreviewShortcut();
    stack.refreshPreviewShortcut(shortcut);
  }

  function handleMouseChord(payload: MouseChordPayload) {
    if (!document.hasFocus()) {
      return;
    }
    const chord = {
      button: payload.button - 1,
      altKey: payload.alt,
      ctrlKey: payload.ctrl,
      shiftKey: payload.shift,
      metaKey: payload.meta,
    };
    if (matchMouse(chord, state.binds.randomHue)) {
      look.randomHue();
      return;
    }
    if (matchMouse(chord, state.binds.preview)) {
      editor.togglePreview();
      return;
    }
    if (matchMouse(chord, state.binds.hide)) {
      hideMemos();
    }
  }

  notePane.addEventListener("mousedown", () => {
    recent.dismiss();
  });

  notesRoot.addEventListener("mousedown", (event) => {
    state.tagPress = null;
    if (event.button !== 0) {
      return;
    }
    const tag = tagSpan(event.target) ?? tagFromEvent(event);
    if (!tag) {
      return;
    }
    state.tagPress = { tag, x: event.clientX, y: event.clientY };
  });
  document.addEventListener("mouseup", (event) => {
    const pressed = state.tagPress;
    state.tagPress = null;
    if (!pressed || event.button !== 0 || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5) {
      return;
    }
    const area = editorTagArea(event.target);
    if (area && area.selectionStart !== area.selectionEnd) {
      return;
    }
    const keep =
      area ?? (event.target instanceof Element ? event.target.closest<HTMLElement>(".md-tag") : null);
    state.tagClickHandled = true;
    window.setTimeout(() => {
      state.tagClickHandled = false;
    });
    recent.openTagSearch(pressed.tag, keep);
  });
  notesRoot.addEventListener("click", (event) => {
    const tag = tagSpan(event.target) ?? tagFromEvent(event);
    if (!tag) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (state.tagClickHandled) {
      state.tagClickHandled = false;
      return;
    }
    const area = editorTagArea(event.target);
    const keep =
      area ?? (event.target instanceof Element ? event.target.closest<HTMLElement>(".md-tag") : null);
    recent.openTagSearch(tag, keep);
  });
  notesRoot.addEventListener("mousemove", (event) => {
    const area = editingHost(event.target);
    if (!area) {
      return;
    }
    const x = event.clientX;
    const y = event.clientY;
    if (state.tagCursorFrame) {
      cancelAnimationFrame(state.tagCursorFrame);
    }
    state.tagCursorFrame = requestAnimationFrame(() => {
      state.tagCursorFrame = 0;
      paintTagCursor(area, x, y);
    });
  });
  notesRoot.addEventListener("mouseout", (event) => {
    if (state.tagCursorFrame) {
      cancelAnimationFrame(state.tagCursorFrame);
      state.tagCursorFrame = 0;
    }
    const area = editingHost(event.target);
    if (area) {
      area.style.removeProperty("cursor");
    }
  });

  card.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("#card > header, .stack-note")) {
      return;
    }
    if (gestureActive(event)) {
      if (
        target instanceof Element &&
        target.closest(
          "#theme-toggle, #color-pop, #audience-pop, #visibility-label, #markdown-toggle, #md-toolbar, #coder-toggle, #format-toggle, #format-pop, #editor-menu-toggle, #editor-tools, .editor-menu-toggle, .editor-tools, #resize-grip, .resize-handle",
        )
      ) {
        return;
      }
      stack.startWindowDrag(event);
      return;
    }
    if (!(target instanceof Element)) {
      return;
    }
    if (stack.dragBlocked(target)) {
      return;
    }
    stack.startWindowDrag(event);
  });

  document.addEventListener("paste", (event) => {
    if (isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLInputElement) {
      return;
    }
    state.lastPasteHandledAt = performance.now();
    const targetSection =
      (target instanceof Element ? target.closest<HTMLElement>(".stack-note") : null) ??
      stack.activeSection() ??
      null;

    const files = filesFromTransfer(event.clipboardData);
    const items = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const allFiles = uniqueFiles([...files, ...items]);
    const plainText = event.clipboardData?.getData("text/plain") ?? "";

    if (!inTauri()) {
      return;
    }

    event.preventDefault();
    void (async () => {
      try {
        const nativeSnippets = await context.backend.pasteClipboardMedia();
        if (nativeSnippets.length > 0) {
          for (const md of nativeSnippets) {
            editor.insertSnippet(md, targetSection);
          }
          return;
        }
      } catch (error) {
        console.error(error);
      }
      if (allFiles.length > 0) {
        await editor.attachFiles(allFiles, targetSection);
        return;
      }
      if (plainText.length > 0) {
        insertPlainText(plainText, targetSection);
      }
    })();
  });

  card.addEventListener("dragover", (event) => {
    if (isDraggingMedia() || ![...(event.dataTransfer?.types ?? [])].includes("Files")) {
      return;
    }
    event.preventDefault();
    card.classList.add("dropping");
  });

  card.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) {
      return;
    }
    card.classList.remove("dropping");
  });

  card.addEventListener("drop", (event) => {
    if (isPreviewWindow() || isDraggingMedia()) {
      return;
    }
    const files = filesFromTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    card.classList.remove("dropping");
    const targetSection =
      (event.target instanceof Element ? event.target.closest<HTMLElement>(".stack-note") : null) ??
      stack.activeSection() ??
      null;
    void editor.attachFiles(files, targetSection);
  });

  document.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    for (const tools of document.querySelectorAll<HTMLElement>(".stack-note .editor-tools.open")) {
      const anchor = tools.parentElement;
      if (tools.contains(target) || anchor?.contains(target)) {
        continue;
      }
      tools.classList.remove("open");
      anchor?.querySelector<HTMLElement>(".editor-menu-toggle")?.setAttribute("aria-expanded", "false");
    }
    for (const pop of document.querySelectorAll<HTMLElement>(
      ".stack-note .color-pop, .stack-note .format-pop, .stack-note .audience-pop",
    )) {
      if (pop.hidden || pop.contains(target)) {
        continue;
      }
      const anchor = pop.parentElement;
      if (anchor?.contains(target)) {
        continue;
      }
      pop.hidden = true;
      const label = anchor?.querySelector<HTMLElement>(".visibility-label");
      label?.setAttribute("aria-expanded", "false");
      const delNote = pop.querySelector<HTMLElement>(".delete-note");
      const delConfirm = pop.querySelector<HTMLElement>(".delete-confirm");
      const delYes = pop.querySelector<HTMLElement>(".delete-yes");
      if (delNote) delNote.hidden = false;
      if (delConfirm) delConfirm.hidden = true;
      if (delYes) delYes.textContent = "Delete";
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (audiencePop.hidden) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (audiencePop.contains(target) || visibilityLabel.contains(target)) {
      return;
    }
    audience.closePopover();
  });

  document.addEventListener(
    "wheel",
    (event) => {
      if ((!state.gestureHeld && !modifierDown(state.binds.gesture, event)) || isPreviewWindow()) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("#card, .stack-note")) {
        return;
      }
      if (target.closest("#color-pop, #audience-pop, #format-pop, #md-toolbar, #editor-tools, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools")) {
        return;
      }
      event.preventDefault();
      const pixels =
        event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 120 : event.deltaY;
      if (pixels === 0) {
        return;
      }
      look.adjustOpacity(pixels, event.metaKey);
    },
    { passive: false, capture: true },
  );

  if (!isPreviewWindow()) {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Alt") {
          if (!event.repeat) {
            state.altHeld = true;
            look.paintThemeIcon();
          }
          event.preventDefault();
        }
        if (isModifierKey(state.binds.gesture, event.key)) {
          if (!event.repeat) {
            state.gestureHeld = true;
            stack.syncCollapsedPeek();
          }
          return;
        }
        if (event.key === "Alt") {
          return;
        }
        if (
          event.key === "Tab" &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing
        ) {
          const active = document.activeElement;
          const field = active instanceof HTMLTextAreaElement ? active : editingHost(active);
          const isEmptyNewMemo =
            session.isNewMemo() &&
            editor.isEmptyNewMemo() &&
            (field ? field.value.length === 0 : true);
          if (!field || isEmptyNewMemo) {
            event.preventDefault();
            event.stopPropagation();
            recent.toggleSearchByTab();
            return;
          }
        }
        const openStackPops = [
          ...document.querySelectorAll<HTMLElement>(
            ".stack-note .color-pop:not([hidden]), .stack-note .format-pop:not([hidden]), .stack-note .audience-pop:not([hidden])",
          ),
        ];
        const openSectionTools = [...document.querySelectorAll<HTMLElement>(".stack-note .editor-tools.open")];
        if (
          event.key === "Escape" &&
          (mediaContextMenuOpen() ||
            !colorPop.hidden ||
            !audiencePop.hidden ||
            !formatPop.hidden ||
            editorTools.classList.contains("open") ||
            openStackPops.length > 0 ||
            openSectionTools.length > 0)
        ) {
          closeMediaContextMenu();
          colorPop.hidden = true;
          audience.closePopover();
          editor.closeFormatMenu();
          editor.closeMenu();
          for (const pop of openStackPops) {
            pop.hidden = true;
          }
          for (const tools of openSectionTools) {
            tools.classList.remove("open");
            tools.parentElement
              ?.querySelector<HTMLElement>(".editor-menu-toggle")
              ?.setAttribute("aria-expanded", "false");
          }
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !(event.target instanceof HTMLInputElement)
        ) {
          const keyLower = event.key.toLowerCase();
          const isUndo = keyLower === "z" && !event.shiftKey;
          const isRedo = (keyLower === "z" && event.shiftKey) || (keyLower === "y" && !event.metaKey);
          if (isUndo || isRedo) {
            const target = event.target;
            const targetSection =
              (target instanceof Element ? target.closest<HTMLElement>(".stack-note") : null) ??
              stack.activeSection() ??
              null;
            if (targetSection) {
              if (isUndo ? stack.undo(targetSection) : stack.redo(targetSection)) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
            } else if (isUndo ? editor.undo() : editor.redo()) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
        }
        if (
          inTauri() &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "v" &&
          !(event.target instanceof HTMLInputElement)
        ) {
          const keydownAt = performance.now();
          const target = event.target;
          const targetSection =
            (target instanceof Element ? target.closest<HTMLElement>(".stack-note") : null) ??
            stack.activeSection() ??
            null;
          window.setTimeout(() => {
            if (state.lastPasteHandledAt >= keydownAt) {
              return;
            }
            state.lastPasteHandledAt = performance.now();
            void context.backend
              .pasteClipboardMedia()
              .then((snippets) => {
                for (const md of snippets) {
                  editor.insertSnippet(md, targetSection);
                }
              })
              .catch((error: unknown) => {
                console.error(error);
              });
          }, 35);
        }
        if (matchBind(event, state.binds.randomHue)) {
          event.preventDefault();
          look.randomHue();
          return;
        }
        if (matchBind(event, state.binds.preview)) {
          event.preventDefault();
          editor.togglePreview();
          return;
        }
        if (!inTauri() || !matchBind(event, state.binds.hide)) {
          return;
        }
        event.preventDefault();
        hideMemos();
      },
      true,
    );
    window.addEventListener("keyup", (event) => {
      if (event.key === "Alt") {
        state.altHeld = false;
        look.paintThemeIcon();
      }
      if (isModifierKey(state.binds.gesture, event.key)) {
        state.gestureHeld = false;
        stack.syncCollapsedPeek();
      }
    });
    window.addEventListener("blur", () => {
      state.gestureHeld = false;
      stack.syncCollapsedPeek();
      if (!state.altHeld) {
        return;
      }
      state.altHeld = false;
      look.paintThemeIcon();
    });
    if (inTauri()) {
      window.addEventListener(
        "pointerdown",
        (event) => {
          const button = domMouseButton(event.button);
          if (button === null) {
            return;
          }
          const chord = {
            button: button - 1,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          };
          const matched = [
            state.binds.newMemo,
            state.binds.togglePinned,
            state.binds.preview,
            state.binds.hide,
            state.binds.randomHue,
          ].some((binding) => matchMouse(chord, binding));
          if (!matched) {
            return;
          }
          event.preventDefault();
          void context.backend
            .mouseChord(button, event.altKey, event.ctrlKey, event.shiftKey, event.metaKey)
            .catch((error: unknown) => {
              console.error(error);
            });
        },
        true,
      );
    }
  }

  return {
    altHeld,
    gestureActive,
    previewShortcut,
    applyShortcuts,
    handleMouseChord,
  };
}
