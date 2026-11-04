import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { audienceChoice, revealPressedChoice } from "./audience-ui";
import { applyMediaFigureSize, handleBlockAreaNavigation, handleBlockMediaDeletion, syncInlineLineSlot } from "./editor-blocks";
import { memoUsesCoder, refreshEditorFields, wrapEditorField } from "./editor-field";
import { filesFromTransfer } from "./files";
import { BlockHistory, cloneBlocks, restoreCaret, type Caret } from "./history";
import { namedTheme, type Look } from "./look";
import {
  applyCode,
  applyJsonFormat,
  applyTask,
  applyTitle,
  ensureTextSlots,
  noteTitle,
  mediaTokenRegex,
  parseBlocks,
  serializeBlocks,
  tabOnMarkdown,
  taskListOnEnter,
  toggleTask,
  wrapText,
  type Block,
  type Edit,
} from "./markdown-edit";
import { hydratePreviewContent, mediaPointer } from "./media-elements";
import { createMedia, type MediaNoteMutator } from "./media-dnd";
import { markdownToolbarHtml, paintSurface, paintThemeButton, paperAt, stackHeaderHtml, type ThemeName } from "./memo-chrome";
import { inTauri, isPreviewWindow } from "./platform";
import { editorShell, resizeAllBlockTextareas, sizeBlockTextarea } from "./textarea";
import { exactStamp, relativeTime } from "./time";
import type { MemoSpace, Note } from "./types";
import { syncIcon } from "./sync-status";
import { isOfflinePrivate, visibilityOptions, visibilityShort } from "./visibility";

export type StackHost = {
  cardEl: HTMLElement;
  pinnedNoteId: string;
  getLook: () => Look;
  getAltHeld: () => boolean;
  getKnownSpaces: () => MemoSpace[];
  getDefaultVisibility: () => string;
  getEditingId: () => string | null;
  currentTheme: () => ThemeName;
  previewShortcut: () => string;
  openPreview: (name: string) => void;
  insertSnippet: (snippet: string, targetSection?: HTMLElement | null) => void;
  attachFiles: (files: File[], targetSection?: HTMLElement | null) => Promise<void>;
  syncNoteTitle: () => void;
  paintThemeIcon: () => void;
};

let cardEl!: HTMLElement;
let pinnedNoteId = "";
let getLook!: () => Look;
let getAltHeld!: () => boolean;
let getKnownSpaces!: () => MemoSpace[];
let getDefaultVisibility!: () => string;
let getEditingId!: () => string | null;
let currentTheme!: () => ThemeName;
let previewShortcut!: () => string;
let openPreview!: (name: string) => void;
let insertSnippet!: (snippet: string, targetSection?: HTMLElement | null) => void;
let attachFiles!: (files: File[], targetSection?: HTMLElement | null) => Promise<void>;
let syncNoteTitle!: () => void;
let paintThemeIcon!: () => void;

export function bindStack(host: StackHost) {
  cardEl = host.cardEl;
  pinnedNoteId = host.pinnedNoteId;
  getLook = host.getLook;
  getAltHeld = host.getAltHeld;
  getKnownSpaces = host.getKnownSpaces;
  getDefaultVisibility = host.getDefaultVisibility;
  getEditingId = host.getEditingId;
  currentTheme = host.currentTheme;
  previewShortcut = host.previewShortcut;
  openPreview = host.openPreview;
  insertSnippet = host.insertSnippet;
  attachFiles = host.attachFiles;
  syncNoteTitle = host.syncNoteTitle;
  paintThemeIcon = host.paintThemeIcon;
}

export function setHostCollapsedFlag(collapsed: boolean) {
  hostCollapsed = collapsed;
}

export function mediaMutatorForSection(section: HTMLElement): MediaNoteMutator | null {
  const id = section.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  if (!id || !state) {
    return null;
  }
  return {
    getBlocks: () => state.blocks,
    setBlocks: (blocks: Block[]) => {
      state.blocks = blocks;
      state.content = serializeBlocks(blocks);
    },
    pushUndo: (force?: boolean) => pushSectionUndo(state, force ?? true),
    afterMove: () => {
      renderSectionBlocks(section, state);
      scheduleSectionSave(section, state);
    },
    afterWidth: () => {
      scheduleSectionSave(section, state);
      resizeAllBlockTextareas(section);
    },
    removeMediaAt: (index: number, name: string) => removeSectionMediaAt(section, index, name),
  };
}

const NOTE_BAR = 52;
const WINDOW_BAR = 108;
const SECTION_OPEN = 420;
const frameEl = document.querySelector<HTMLElement>("#frame");
export const stackEl = document.querySelector<HTMLElement>("#stack");

export type StackState = {
  collapsed: boolean;
  hover: boolean;
  suppressHover: boolean;
  loaded: string;
  content: string;
  blocks: Block[];
  caret: Caret | null;
  history: BlockHistory;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  opacity: number;
  theme: ThemeName | null;
  coder: boolean | null;
  wrap: boolean;
  mdBar: boolean;
  visibility: string;
  space: string;
  syncState: string;
  lastError: string | null;
};

function pushSectionUndo(state: StackState, force = true) {
  state.history.push(state.blocks, state.caret, force);
}

export function undoSection(section: HTMLElement, state: StackState): boolean {
  const entry = state.history.takeUndo(state.blocks, state.caret);
  if (!entry) {
    return false;
  }
  state.blocks = cloneBlocks(entry.blocks);
  state.caret = entry.caret ? { ...entry.caret } : null;
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state);
  scheduleSectionSave(section, state);
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (container) {
    restoreCaret(container, state.caret);
  }
  return true;
}

export function redoSection(section: HTMLElement, state: StackState): boolean {
  const entry = state.history.takeRedo(state.blocks, state.caret);
  if (!entry) {
    return false;
  }
  state.blocks = cloneBlocks(entry.blocks);
  state.caret = entry.caret ? { ...entry.caret } : null;
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state);
  scheduleSectionSave(section, state);
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (container) {
    restoreCaret(container, state.caret);
  }
  return true;
}

export const stackState = new Map<string, StackState>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

let hostCollapsed = false;
let hostHover = false;
let suppressHostHover = false;
let editingHoldSection: string | null = null;
let autoOpenNewSection: string | null = null;
let cursorPoint: { x: number; y: number } | null = null;
let cursorKnown = false;

function isElementHovered(el: HTMLElement | null | undefined): boolean {
  if (!el) {
    return false;
  }
  if (cursorPoint) {
    const rect = el.getBoundingClientRect();
    const bottom = Math.max(rect.bottom, rect.top + NOTE_BAR);
    return (
      cursorPoint.x >= rect.left &&
      cursorPoint.x <= rect.right &&
      cursorPoint.y >= rect.top &&
      cursorPoint.y <= bottom
    );
  }
  if (cursorKnown) {
    return false;
  }
  return el.matches(":hover");
}

function dismissAutoOpenNewSection() {
  if (autoOpenNewSection === null) {
    return;
  }
  const id = autoOpenNewSection;
  autoOpenNewSection = null;
  if (editingHoldSection === id) {
    editingHoldSection = null;
  }
  const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
  if (document.activeElement instanceof HTMLElement && section?.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}
let lastActiveSection: string = "host";

function syncActiveNoteHeader() {
  const winFocused = document.hasFocus();
  const activeEl = document.activeElement;
  let activeKey: string | null = null;
  if (winFocused) {
    if (activeEl instanceof Element) {
      const section = activeEl.closest<HTMLElement>(".stack-note");
      if (section?.dataset.id) {
        activeKey = section.dataset.id;
      } else if (cardEl.contains(activeEl)) {
        activeKey = "host";
      }
    }
    if (!activeKey) {
      activeKey = lastActiveSection;
    }
  }
  cardEl.classList.toggle("is-editing", activeKey === "host");
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    section.classList.toggle("is-editing", Boolean(activeKey && section.dataset.id === activeKey));
  });
}
let pressTravel = 0;
let pressAt: { x: number; y: number } | null = null;
let openNoteHeight = SECTION_OPEN;
let savedHostHeight = 476;
let heightTween = 0;
let tweenTicket = 0;
let sizingWindow = false;
let sizingTimer: ReturnType<typeof setTimeout> | undefined;
let initialSizeSynced = false;
let chromeSignature: string | null = null;

function hostBarOnly(): boolean {
  return hostCollapsed && !hostHover && editingHoldSection !== "host";
}

function sectionBarOnly(id: string | undefined, state: StackState): boolean {
  return state.collapsed && !state.hover && editingHoldSection !== id;
}

export function hasStack(): boolean {
  return stackEl != null && stackEl.childElementCount > 0;
}

function stackCounts(): { opens: number; bars: number } {
  let opens = hostBarOnly() ? 0 : 1;
  let bars = hostBarOnly() ? 1 : 0;
  if (hasStack()) {
    for (const [id, state] of stackState.entries()) {
      if (sectionBarOnly(id, state)) {
        bars += 1;
      } else {
        opens += 1;
      }
    }
  }
  return { opens, bars };
}

function targetWindowHeight(): number {
  const chrome = 56;
  if (!hasStack()) {
    return hostBarOnly() ? WINDOW_BAR : Math.max(196, Math.round(chrome + openNoteHeight));
  }
  const { opens, bars } = stackCounts();
  return Math.round(chrome + opens * openNoteHeight + bars * NOTE_BAR);
}

function applyOpenHeight() {
  document.documentElement.style.setProperty("--open-h", `${Math.round(openNoteHeight)}px`);
  document.documentElement.style.setProperty("--bar-h", `${NOTE_BAR}px`);
}

function rememberOpenSlice() {
  const box = frameEl?.clientHeight ?? 0;
  if (box < NOTE_BAR || sizingWindow) {
    return;
  }
  const { opens, bars } = stackCounts();
  if (opens <= 0) {
    return;
  }
  const available = Math.max(140 * opens, box - bars * NOTE_BAR);
  const slice = Math.max(140, Math.round(available / opens));
  openNoteHeight = slice;
  savedHostHeight = 56 + slice;
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    section.style.height = "";
  });
  document.documentElement.classList.add("fitting");
  applyOpenHeight();
  requestAnimationFrame(() => {
    document.documentElement.classList.remove("fitting");
  });
}

async function logicalHeight(): Promise<number> {
  if (!inTauri()) {
    return window.innerHeight;
  }
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const size = await win.innerSize();
    return Math.round(size.height / factor);
  } catch {
    return window.innerHeight;
  }
}

async function setLogicalHeight(height: number) {
  if (!inTauri()) {
    return;
  }
  sizingWindow = true;
  clearTimeout(sizingTimer);
  try {
    await invoke("set_window_height", {
      label: getCurrentWindow().label,
      height: Math.max(96, Math.round(height)),
    });
  } finally {
    sizingTimer = window.setTimeout(() => {
      sizingWindow = false;
    }, 220);
  }
}

function cancelHeightTween() {
  tweenTicket += 1;
  clearTimeout(heightTween);
}

function tweenWindowHeight(target: number) {
  cancelHeightTween();
  const ticket = tweenTicket;
  void logicalHeight().then((from) => {
    if (ticket !== tweenTicket) {
      return;
    }
    if (Math.abs(target - from) <= 2) {
      void setLogicalHeight(target);
      return;
    }
    const began = performance.now();
    const step = () => {
      if (ticket !== tweenTicket) {
        return;
      }
      const t = Math.min(1, (performance.now() - began) / 160);
      const eased = 1 - (1 - t) ** 3;
      void setLogicalHeight(Math.round(from + (target - from) * eased));
      if (t < 1) {
        heightTween = window.setTimeout(step, 16);
      }
    };
    heightTween = window.setTimeout(step, 16);
  });
}

export function sectionTheme(state: StackState): ThemeName {
  return state.theme ?? currentTheme();
}

export function sectionHue(state: StackState): number | null {
  const theme = sectionTheme(state);
  return theme === "dark" ? state.hueDark : state.hueLight;
}

function paintSectionColor(section: HTMLElement, state: StackState) {
  const theme = sectionTheme(state);
  paintSurface(section, theme, sectionHue(state), getLook().opacity);
  const button = section.querySelector<HTMLElement>(".theme-toggle");
  const icon = section.querySelector(".theme-icon");
  if (button && icon) {
    paintThemeButton(button, icon, theme, !getAltHeld());
  }
  paintSectionCoder(section, state);
}

function paintSectionCoder(section: HTMLElement, state: StackState) {
  const on = memoUsesCoder(state.coder);
  section.toggleAttribute("data-coder", on);
  section.toggleAttribute("data-wrap", on && state.wrap);
  section.querySelector(".coder-toggle")?.setAttribute("aria-pressed", String(on));
  section.querySelector("[data-format='wrap']")?.setAttribute("aria-pressed", String(state.wrap));
  const formatPop = section.querySelector<HTMLElement>(".format-pop");
  const formatToggle = section.querySelector<HTMLButtonElement>(".format-toggle");
  if (!on && formatPop) {
    formatPop.hidden = true;
    formatToggle?.setAttribute("aria-expanded", "false");
  }
}

export function applyStackEditorChrome() {
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (state) {
      paintSectionCoder(section, state);
    }
  });
}

export function repaintStackColors() {
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (state) {
      paintSectionColor(section, state);
    }
  });
}

export function paintSectionAudience(section: HTMLElement, state: StackState) {
  const id = section.dataset.id;
  if (!id) {
    return;
  }
  let visibility = state.visibility || getDefaultVisibility() || "PRIVATE";
  if (!visibilityOptions.some((option) => option.value === visibility)) {
    visibility = "PRIVATE";
  }
  const space = isOfflinePrivate(visibility) ? "" : state.space || "";
  state.visibility = visibility;
  state.space = space;
  const label = section.querySelector<HTMLButtonElement>(".visibility-label");
  if (label) {
    label.hidden = false;
    label.textContent = visibilityShort(visibility, space, getKnownSpaces());
  }
  const sync = section.querySelector<HTMLElement>(".note-sync");
  if (sync) {
    const icon = syncIcon(state.syncState, visibility);
    sync.hidden = false;
    sync.innerHTML = icon.svg;
    sync.title = state.lastError ?? icon.label;
  }
  const edited = section.querySelector<HTMLElement>(".edited-at");
  const sep = section.querySelector<HTMLElement>(".edited-sep");
  if (sep && label && edited) {
    sep.hidden = label.hidden || edited.hidden;
  }
  const visChoices = section.querySelector<HTMLElement>(".visibility-choices");
  const spaceBlock = section.querySelector<HTMLElement>(".space-block");
  const spaceChoices = section.querySelector<HTMLElement>(".space-choices");
  const pop = section.querySelector<HTMLElement>(".audience-pop");
  if (!visChoices || !spaceBlock || !spaceChoices) {
    return;
  }
  visChoices.replaceChildren();
  for (const option of visibilityOptions) {
    if (option.value === "SPACE" && getKnownSpaces().length === 0) {
      continue;
    }
    visChoices.append(
      audienceChoice(option.label, option.hint, state.visibility === option.value, () => {
        state.visibility = option.value;
        if (isOfflinePrivate(option.value)) {
          state.space = "";
          state.syncState = "local";
          state.lastError = null;
        } else if (option.value === "SPACE" && state.space === "" && getKnownSpaces()[0]) {
          state.space = getKnownSpaces()[0].name;
        }
        paintSectionAudience(section, state);
        void invoke("set_note_audience", {
          id,
          visibility: state.visibility,
          space: state.space,
        }).catch((error: unknown) => {
          console.error(error);
        });
      }),
    );
  }
  spaceChoices.replaceChildren();
  spaceBlock.hidden = getKnownSpaces().length === 0 || isOfflinePrivate(state.visibility);
  if (spaceBlock.hidden) {
    return;
  }
  spaceChoices.append(
    audienceChoice("Unassigned", "", state.space === "", () => {
      state.space = "";
      if (state.visibility === "SPACE" || isOfflinePrivate(state.visibility)) {
        state.visibility = "PRIVATE";
      }
      paintSectionAudience(section, state);
      void invoke("set_note_audience", {
        id,
        visibility: state.visibility,
        space: state.space,
      }).catch((error: unknown) => {
        console.error(error);
      });
    }),
  );
  for (const item of getKnownSpaces()) {
    spaceChoices.append(
      audienceChoice(item.title, item.synced === false ? "Not on server" : "", state.space === item.name, () => {
        state.space = item.name;
        if (isOfflinePrivate(state.visibility)) {
          state.visibility = "PRIVATE";
        }
        paintSectionAudience(section, state);
        void invoke("set_note_audience", {
          id,
          visibility: state.visibility,
          space: state.space,
        }).catch((error: unknown) => {
          console.error(error);
        });
      }),
    );
  }
  if (pop && !pop.hidden) {
    revealPressedChoice(spaceChoices);
  }
  syncHeaderCompact();
}

export function sectionAreaSelection(area: HTMLTextAreaElement, state: StackState): { start: number; end: number } {
  const index = Number(area.dataset.index ?? 0);
  if (document.activeElement === area) {
    return {
      start: area.selectionStart ?? area.value.length,
      end: area.selectionEnd ?? area.value.length,
    };
  }
  if (state.caret?.index === index) {
    const start = Math.min(state.caret.start, area.value.length);
    const end = Math.min(state.caret.end, area.value.length);
    return { start, end };
  }
  return { start: area.value.length, end: area.value.length };
}

export function sectionTargetArea(section: HTMLElement, state: StackState): HTMLTextAreaElement | null {
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (!container) {
    return null;
  }
  if (document.activeElement instanceof HTMLTextAreaElement && container.contains(document.activeElement)) {
    return document.activeElement;
  }
  if (state.caret) {
    const remembered = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${state.caret.index}"]`);
    if (remembered) {
      return remembered;
    }
  }
  return container.querySelector<HTMLTextAreaElement>("textarea:last-of-type");
}

function scheduleSectionSave(section: HTMLElement, state: StackState) {
  const id = section.dataset.id;
  if (!id) {
    return;
  }
  if (autoOpenNewSection === id) {
    autoOpenNewSection = null;
    editingHoldSection = id;
  }
  const titleEl = section.querySelector(".note-title");
  if (titleEl) {
    titleEl.textContent = noteTitle(state.content) || "Note";
  }
  const now = Date.now();
  const edited = section.querySelector<HTMLElement>(".edited-at");
  const sep = section.querySelector<HTMLElement>(".edited-sep");
  if (edited && sep) {
    edited.hidden = false;
    sep.hidden = false;
    edited.textContent = relativeTime(now);
    edited.title = exactStamp(now);
    syncHeaderCompact();
  }
  const content = state.content;
  const pending = saveTimers.get(id);
  if (pending) {
    clearTimeout(pending);
  }
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      state.loaded = content;
      void invoke("save_edit", { id, content }).catch((error: unknown) => {
        console.error(error);
      });
    }, 300),
  );
}

export function applySectionEdit(section: HTMLElement, state: StackState, area: HTMLTextAreaElement, edit: Edit) {
  const index = Number(area.dataset.index ?? 0);
  const block = state.blocks[index];
  if (block?.kind !== "text") {
    return;
  }
  pushSectionUndo(state, true);
  area.value = edit.value;
  block.text = edit.value;
  area.classList.toggle("empty-slot", edit.value.length === 0 && state.blocks.length > 1);
  sizeBlockTextarea(area);
  state.content = serializeBlocks(state.blocks);
  area.focus();
  const start = Math.min(edit.start, area.value.length);
  const end = Math.min(edit.end, area.value.length);
  area.setSelectionRange(start, end);
  state.caret = { index, start, end };
  scheduleSectionSave(section, state);
}

function removeSectionMediaAt(section: HTMLElement, blockIndex: number, name: string) {
  const id = section.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  if (!state) {
    return;
  }
  let targetIndex = blockIndex;
  const current = state.blocks[targetIndex];
  if (!current || current.kind !== "media" || current.name !== name) {
    targetIndex = state.blocks.findIndex((b) => b.kind === "media" && b.name === name);
  }
  if (targetIndex < 0) {
    return;
  }
  pushSectionUndo(state, true);
  state.blocks = ensureTextSlots(state.blocks.filter((_, idx) => idx !== targetIndex));
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state);
  scheduleSectionSave(section, state);
}

function renderSectionBlocks(section: HTMLElement, state: StackState, focusName?: string) {
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (!container) {
    return;
  }
  state.blocks = ensureTextSlots(state.blocks);
  state.content = serializeBlocks(state.blocks);
  const reuse = new Map<string, HTMLElement[]>();
  for (const node of container.querySelectorAll<HTMLElement>("[data-media]")) {
    const mediaName = node.dataset.media;
    if (mediaName) {
      const list = reuse.get(mediaName) ?? [];
      list.push(node);
      reuse.set(mediaName, list);
    }
  }
  container.replaceChildren();
  const lastIndex = state.blocks.length - 1;
  let currentRow: HTMLElement | null = null;
  let currentRowSideArea: HTMLTextAreaElement | null = null;

  state.blocks.forEach((block, index) => {
    if (block.kind === "text") {
      const prevBlock = state.blocks[index - 1];
      const isAfterMedia = prevBlock?.kind === "media";
      const area = document.createElement("textarea");
      area.dataset.index = String(index);
      area.value = block.text;
      area.rows = 1;
      area.spellcheck = false;
      area.setAttribute("writingsuggestions", "false");
      area.autocomplete = "off";
      area.setAttribute("autocorrect", "off");
      area.setAttribute("autocapitalize", "off");
      const canSitOnMediaLine =
        isAfterMedia &&
        currentRow !== null &&
        currentRowSideArea === null &&
        !block.text.includes("\n");
      if (index === 0 && state.blocks.length === 1) {
        area.placeholder = "Write a memo...";
      } else if (canSitOnMediaLine) {
        area.classList.add("inline-line-slot");
      } else if (block.text.length === 0 && state.blocks.length > 1) {
        area.classList.add("empty-slot");
      }
      if (index === lastIndex && !area.classList.contains("inline-line-slot")) {
        area.classList.add("grow");
      }
      const assignedRow = canSitOnMediaLine ? currentRow : null;
      const rememberCaret = () => {
        state.caret = {
          index,
          start: area.selectionStart ?? area.value.length,
          end: area.selectionEnd ?? area.value.length,
        };
      };
      area.addEventListener("select", rememberCaret);
      area.addEventListener("keyup", rememberCaret);
      area.addEventListener("mouseup", rememberCaret);
      area.addEventListener("focus", rememberCaret);
      area.addEventListener("keydown", (event) => {
        if (
          handleBlockMediaDeletion(
            container,
            area,
            event,
            () => state.blocks,
            (mediaIndex, focusIdx, caretPos) => {
              pushSectionUndo(state, true);
              state.blocks = ensureTextSlots(state.blocks.filter((_, idx) => idx !== mediaIndex));
              state.content = serializeBlocks(state.blocks);
              renderSectionBlocks(section, state);
              scheduleSectionSave(section, state);
              const target = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${focusIdx}"]`);
              if (target) {
                target.focus();
                const clamped = Math.min(caretPos, target.value.length);
                target.setSelectionRange(clamped, clamped);
              }
            },
          )
        ) {
          return;
        }
        if (handleBlockAreaNavigation(container, area, event)) {
          return;
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing &&
          area.classList.contains("inline-line-slot")
        ) {
          if (area.value.length === 0) {
            event.preventDefault();
            if (prevBlock?.kind === "media") {
              prevBlock.inline = false;
            }
            area.classList.remove("inline-line-slot");
            if (index === lastIndex) {
              area.classList.add("grow");
            }
            if (assignedRow && editorShell(area).parentElement === assignedRow) {
              assignedRow.after(editorShell(area));
            } else {
              container.append(editorShell(area));
            }
            sizeBlockTextarea(area);
            area.focus();
            return;
          }
          event.preventDefault();
          pushSectionUndo(state, true);
          const { start, end } = sectionAreaSelection(area, state);
          const beforeLine = area.value.slice(0, start);
          const afterLine = area.value.slice(end);
          if (prevBlock?.kind === "media") {
            prevBlock.inline = beforeLine.length > 0;
          }
          state.blocks.splice(
            index,
            1,
            { kind: "text", text: beforeLine },
            { kind: "text", text: `\n${afterLine}` },
          );
          state.blocks = ensureTextSlots(state.blocks);
          state.content = serializeBlocks(state.blocks);
          renderSectionBlocks(section, state);
          scheduleSectionSave(section, state);
          const target = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${index}"]`);
          if (target) {
            target.focus();
            const pos = Math.min(beforeLine.length + 1, target.value.length);
            target.setSelectionRange(pos, pos);
          }
          return;
        }
        if (
          event.key === "Tab" &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing
        ) {
          event.preventDefault();
          const edit = tabOnMarkdown(area.value, area.selectionStart, area.selectionEnd, event.shiftKey);
          applySectionEdit(section, state, area, edit);
          return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
          return;
        }
        const edit = taskListOnEnter(area.value, area.selectionStart, area.selectionEnd);
        if (!edit) {
          return;
        }
        event.preventDefault();
        applySectionEdit(section, state, area, edit);
      });
      area.addEventListener("beforeinput", () => {
        pushSectionUndo(state, false);
      });
      area.addEventListener("input", () => {
        block.text = area.value;
        syncInlineLineSlot(area, prevBlock, assignedRow, container, index === lastIndex);
        if (mediaTokenRegex.test(area.value)) {
          state.content = serializeBlocks(state.blocks);
          state.blocks = parseBlocks(state.content);
          renderSectionBlocks(section, state);
          scheduleSectionSave(section, state);
          return;
        }
        sizeBlockTextarea(area);
        rememberCaret();
        state.content = serializeBlocks(state.blocks);
        scheduleSectionSave(section, state);
      });
      if (canSitOnMediaLine && currentRow) {
        currentRow.append(wrapEditorField(area));
        currentRowSideArea = area;
      } else {
        currentRow = null;
        currentRowSideArea = null;
        container.append(wrapEditorField(area));
      }
      return;
    }
    const existingList = reuse.get(block.name);
    const figure = existingList?.shift() ?? createMedia(block.name, block.label, section, block.width);
    applyMediaFigureSize(figure, block.width);
    figure.dataset.index = String(index);
    const row = document.createElement("div");
    row.className = "media-row";
    row.append(figure);
    container.append(row);
    currentRow = row;
    currentRowSideArea = null;
  });
  resizeAllBlockTextareas(container);
  if (focusName) {
    const mediaIndex = state.blocks.findIndex((item) => item.kind === "media" && item.name === focusName);
    const target = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${mediaIndex + 1}"]`);
    target?.focus();
  }
}

function syncSection(section: HTMLElement, note: Note) {
  const state = stackState.get(note.id);
  if (!state) {
    return;
  }
  const isBar = sectionBarOnly(note.id, state);
  section.classList.toggle("is-bar", isBar);
  section.classList.toggle("hover-open", state.collapsed && !isBar);
  const title = section.querySelector(".note-title");
  if (title) {
    title.textContent = noteTitle(state.content) || "Note";
  }
  const edited = section.querySelector<HTMLElement>(".edited-at");
  const sep = section.querySelector<HTMLElement>(".edited-sep");
  if (edited && sep) {
    if (note.updatedAt > 0) {
      edited.hidden = false;
      edited.textContent = relativeTime(note.updatedAt);
      edited.title = exactStamp(note.updatedAt);
    } else {
      edited.hidden = true;
    }
  }
  paintSectionAudience(section, state);
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  const activeInside = Boolean(container && document.activeElement && container.contains(document.activeElement));
  if (!activeInside && (state.content === state.loaded || state.content === note.content)) {
    const changed = state.content !== note.content || (container?.childElementCount ?? 0) === 0;
    state.content = note.content;
    state.loaded = note.content;
    if (changed) {
      state.blocks = parseBlocks(note.content);
      renderSectionBlocks(section, state);
    } else if (container) {
      resizeAllBlockTextareas(container);
    }
  }
  const hue = section.querySelector<HTMLInputElement>(".hue-slider");
  if (hue && document.activeElement !== hue) {
    hue.value = String(sectionHue(state) ?? 48);
  }
  paintSectionSlots(section, state);
  paintSectionColor(section, state);
}

type SectionLift = {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  started: boolean;
};

let sectionLift: SectionLift | null = null;

function beginSectionLift(section: HTMLElement, title: HTMLElement, event: PointerEvent) {
  const id = section.dataset.id;
  if (!id) {
    return;
  }
  sectionLift = {
    id,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    started: false,
  };
  title.setPointerCapture(event.pointerId);
}

function moveSectionLift(section: HTMLElement, title: HTMLElement, event: PointerEvent) {
  const lift = sectionLift;
  if (!lift || lift.started || event.pointerId !== lift.pointerId) {
    return;
  }
  const dx = event.clientX - lift.x;
  const dy = event.clientY - lift.y;
  if (dx * dx + dy * dy < 36) {
    return;
  }
  lift.started = true;
  title.dataset.moved = "1";
  const sources: HTMLElement[] = [section];
  let next = section.nextElementSibling;
  while (next instanceof HTMLElement && next.classList.contains("stack-note")) {
    sources.push(next);
    next = next.nextElementSibling;
  }
  for (const source of sources) {
    source.classList.add("lifting");
  }
  const first = section.getBoundingClientRect();
  const factor = window.devicePixelRatio || 1;
  const x = Math.round((event.screenX - (event.clientX - first.left) - 24) * factor);
  const y = Math.round((event.screenY - (event.clientY - first.top) - 24) * factor);
  const w = Math.round((first.width + 48) * factor);
  // The detached root always opens at default/expanded note height; any tail
  // memos attached beneath it keep their current open/collapsed state.
  let detachedCardsHeight = openNoteHeight;
  for (let i = 1; i < sources.length; i += 1) {
    const tailId = sources[i].dataset.id;
    const tailState = tailId ? stackState.get(tailId) : undefined;
    detachedCardsHeight += tailState?.collapsed ? NOTE_BAR : openNoteHeight;
  }
  const h = Math.round((detachedCardsHeight + 56) * factor);
  const grabX = Math.round(event.screenX * factor) - x;
  const grabY = Math.round(event.screenY * factor) - y;
  const state = stackState.get(lift.id);
  void invoke("detach_stack", {
    guestId: lift.id,
    x,
    y,
    w,
    h,
    theme: state ? sectionTheme(state) : currentTheme(),
    grabX,
    grabY,
    pull: Math.round(64 * factor),
  }).catch((error: unknown) => {
    console.error(error);
    for (const source of sources) {
      source.classList.remove("lifting");
    }
  });
}

function endSectionLift(title: HTMLElement, event: PointerEvent, _commit: boolean) {
  const lift = sectionLift;
  if (!lift || event.pointerId !== lift.pointerId) {
    return;
  }
  sectionLift = null;
  if (title.hasPointerCapture(event.pointerId)) {
    title.releasePointerCapture(event.pointerId);
  }
}

function saveSectionLook(id: string, state: StackState) {
  void invoke("save_look", {
    id,
    opacity: getLook().opacity,
    hueLight: state.hueLight,
    hueDark: state.hueDark,
    swatches: state.swatches,
    theme: state.theme,
    coder: state.coder,
  }).catch((error: unknown) => {
    console.error(error);
  });
}

export function setSectionHue(section: HTMLElement, state: StackState, hue: number) {
  if (sectionTheme(state) === "dark") {
    state.hueDark = hue;
  } else {
    state.hueLight = hue;
  }
  paintSectionColor(section, state);
  paintSectionSlots(section, state);
  const id = section.dataset.id;
  if (id) {
    saveSectionLook(id, state);
  }
}

function paintSectionSlots(section: HTMLElement, state: StackState) {
  const theme = sectionTheme(state);
  const current = sectionHue(state);
  const slots = [...section.querySelectorAll<HTMLButtonElement>(".hue-slot")];
  slots.forEach((slot, index) => {
    const hue = state.swatches[index];
    if (hue == null) {
      slot.style.background = "";
      delete slot.dataset.hue;
      slot.setAttribute("aria-pressed", "false");
      return;
    }
    slot.dataset.hue = String(hue);
    slot.style.background = paperAt(theme, hue);
    slot.setAttribute("aria-pressed", String(hue === current));
  });
  const add = section.querySelector<HTMLButtonElement>(".hue-add");
  const slider = section.querySelector<HTMLInputElement>(".hue-slider");
  if (add && slider) {
    const hue = Number(slider.value);
    add.disabled = state.swatches.length >= 6 || state.swatches.includes(hue);
    slider.style.setProperty("--thumb", paperAt(theme, current ?? hue));
  }
}

async function flushSectionSaves(ids?: Iterable<string>) {
  const targets = ids ? [...ids] : [...saveTimers.keys()];
  await Promise.all(
    targets.map(async (id) => {
      const timer = saveTimers.get(id);
      if (!timer) {
        return;
      }
      clearTimeout(timer);
      saveTimers.delete(id);
      const state = stackState.get(id);
      if (!state) {
        return;
      }
      state.loaded = state.content;
      await invoke("save_edit", { id, content: state.content });
    }),
  );
}

function buildSection(note: Note): HTMLElement {
  const section = document.createElement("section");
  section.className = "stack-note";
  section.dataset.id = note.id;
  section.innerHTML = `${stackHeaderHtml()}
    ${markdownToolbarHtml()}
    <div class="stack-blocks"></div>
    <div class="stack-preview" hidden></div>
  `;
  const state = stackState.get(note.id);
  if (state) {
    renderSectionBlocks(section, state);
  }
  section.addEventListener("dragover", (event) => {
    if (mediaPointer.draggingName || ![...(event.dataTransfer?.types ?? [])].includes("Files")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    section.classList.add("dropping");
  });
  section.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && section.contains(event.relatedTarget)) {
      return;
    }
    section.classList.remove("dropping");
  });
  section.addEventListener("drop", (event) => {
    if (isPreviewWindow() || mediaPointer.draggingName) {
      return;
    }
    const files = filesFromTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    section.classList.remove("dropping");
    void attachFiles(files, section);
  });
  const header = section.querySelector<HTMLElement>("header");
  if (!header) {
    return section;
  }
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (dragBlocked(target)) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    header.dataset.moved = "0";
    void flushSectionSaves().catch((error: unknown) => {
      console.error(error);
    });
    beginSectionLift(section, header, event);
  });
  header.addEventListener("pointermove", (event) => {
    moveSectionLift(section, header, event);
  });
  header.addEventListener("pointerup", (event) => {
    endSectionLift(header, event, true);
  });
  header.addEventListener("pointercancel", (event) => {
    endSectionLift(header, event, false);
  });
  section.addEventListener("click", (event) => {
    const state = stackState.get(note.id);
    if (!state || !sectionBarOnly(note.id, state) || pressTravel > 8 || header.dataset.moved === "1") {
      return;
    }
    if (event.target instanceof Element && event.target.closest("textarea, button, input, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools")) {
      return;
    }
    state.collapsed = false;
    state.hover = false;
    state.suppressHover = false;
    if (editingHoldSection === note.id) {
      editingHoldSection = null;
    }
    section.classList.remove("is-bar", "hover-open");
    paintSectionColor(section, state);
    paintChrome();
    resizeAllBlockTextareas(section);
    void invoke("set_collapsed", { id: note.id, collapsed: false }).catch((error: unknown) => {
      console.error(error);
    });
  });
  section.addEventListener("pointerdown", (event) => {
    if (autoOpenNewSection === note.id) {
      autoOpenNewSection = null;
      editingHoldSection = note.id;
    }
    if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest("header, button, input, textarea, .media, .media-audio, .file-attachment, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools, #resize-grip, .resize-handle")) {
      return;
    }
    startWindowDrag(event);
  });
  section.addEventListener("mouseenter", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    syncCollapsedPeek();
  });
  section.addEventListener("mouseleave", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    if (autoOpenNewSection === note.id) {
      dismissAutoOpenNewSection();
    }
    syncCollapsedPeek();
    paintChrome();
  });
  const themeButton = section.querySelector<HTMLButtonElement>(".theme-toggle");
  const pop = section.querySelector<HTMLElement>(".color-pop");
  const hue = section.querySelector<HTMLInputElement>(".hue-slider");
  themeButton?.addEventListener("click", (event) => {
    const state = stackState.get(note.id);
    if (!state || !pop) {
      return;
    }
    const alt = event.altKey || getAltHeld();
    if (!alt) {
      pop.hidden = !pop.hidden;
      return;
    }
    pop.hidden = true;
    state.theme = sectionTheme(state) === "dark" ? "light" : "dark";
    paintSectionColor(section, state);
    paintSectionSlots(section, state);
    saveSectionLook(note.id, state);
  });
  hue?.addEventListener("input", () => {
    const state = stackState.get(note.id);
    if (!state || !hue) {
      return;
    }
    setSectionHue(section, state, Number(hue.value));
  });
  section.querySelectorAll<HTMLButtonElement>(".hue-slot").forEach((slot) => {
    slot.addEventListener("click", () => {
      const state = stackState.get(note.id);
      const raw = slot.dataset.hue;
      if (!state || raw == null || raw === "") {
        return;
      }
      setSectionHue(section, state, Number(raw));
    });
  });
  section.querySelector<HTMLButtonElement>(".hue-add")?.addEventListener("click", () => {
    const state = stackState.get(note.id);
    if (!state || !hue || state.swatches.length >= 6) {
      return;
    }
    const value = Number(hue.value);
    if (state.swatches.includes(value)) {
      return;
    }
    state.swatches.push(value);
    setSectionHue(section, state, value);
  });
  const editorMenuToggle = section.querySelector<HTMLButtonElement>(".editor-menu-toggle");
  const editorTools = section.querySelector<HTMLElement>(".editor-tools");
  const markdownToggle = section.querySelector<HTMLButtonElement>(".markdown-toggle");
  const markdownToolbar = section.querySelector<HTMLElement>(".md-toolbar");
  const formatToggle = section.querySelector<HTMLButtonElement>(".format-toggle");
  const formatPop = section.querySelector<HTMLElement>(".format-pop");
  const closeSectionFormatPop = () => {
    if (formatPop) {
      formatPop.hidden = true;
      formatToggle?.setAttribute("aria-expanded", "false");
    }
  };
  const closeSectionEditorMenu = () => {
    editorTools?.classList.remove("open");
    editorMenuToggle?.setAttribute("aria-expanded", "false");
    closeSectionFormatPop();
  };
  const applySectionMarkdown = (kind: string) => {
    const state = stackState.get(note.id);
    if (!state) {
      return;
    }
    const field = sectionTargetArea(section, state);
    if (!field) {
      return;
    }
    const { start, end } = sectionAreaSelection(field, state);
    const value = field.value;
    const edit =
      kind === "bold"
        ? wrapText(value, start, end, "**", "**")
        : kind === "italic"
          ? wrapText(value, start, end, "*", "*")
          : kind === "title"
            ? applyTitle(value, start, end)
            : kind === "task"
              ? applyTask(value, start, end)
              : kind === "code"
                ? applyCode(value, start, end)
                : kind === "json"
                  ? applyJsonFormat(value)
                  : null;
    if (!edit) {
      return;
    }
    applySectionEdit(section, state, field, edit);
  };
  if (state?.mdBar && markdownToggle && markdownToolbar) {
    markdownToggle.setAttribute("aria-pressed", "true");
    markdownToolbar.hidden = false;
  }
  editorMenuToggle?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  editorMenuToggle?.addEventListener("click", () => {
    if (!editorTools || !editorMenuToggle) {
      return;
    }
    const open = !editorTools.classList.contains("open");
    editorTools.classList.toggle("open", open);
    editorMenuToggle.setAttribute("aria-expanded", String(open));
    if (!open) {
      closeSectionFormatPop();
      if (pop) {
        pop.hidden = true;
      }
    }
  });
  markdownToggle?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  markdownToolbar?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  markdownToggle?.addEventListener("click", () => {
    const held = stackState.get(note.id);
    if (!markdownToggle || !markdownToolbar || !held) {
      return;
    }
    held.mdBar = !held.mdBar;
    markdownToggle.setAttribute("aria-pressed", String(held.mdBar));
    markdownToolbar.hidden = !held.mdBar;
    closeSectionEditorMenu();
  });
  markdownToolbar?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const kind = button?.dataset.markdown;
    if (!kind) {
      return;
    }
    applySectionMarkdown(kind);
  });
  formatToggle?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  formatPop?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  formatToggle?.addEventListener("click", () => {
    if (!formatPop || !formatToggle) {
      return;
    }
    const open = formatPop.hidden;
    formatPop.hidden = !open;
    formatToggle.setAttribute("aria-expanded", String(open));
  });
  formatPop?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const action = button?.dataset.format;
    const held = stackState.get(note.id);
    if (!action || !held) {
      return;
    }
    if (action === "wrap") {
      held.wrap = !held.wrap;
      paintSectionCoder(section, held);
      refreshEditorFields(section);
      resizeAllBlockTextareas(section);
      closeSectionFormatPop();
      return;
    }
    if (action === "document") {
      applySectionMarkdown("json");
      closeSectionFormatPop();
      closeSectionEditorMenu();
    }
  });
  const mode = section.querySelector<HTMLButtonElement>(".mode-toggle");
  const preview = section.querySelector<HTMLElement>(".stack-preview");
  if (mode) {
    mode.title = `Preview (${previewShortcut()})`;
  }
  mode?.addEventListener("click", () => {
    toggleSectionPreview(section);
    closeSectionEditorMenu();
  });
  const coderToggle = section.querySelector<HTMLButtonElement>(".coder-toggle");
  coderToggle?.addEventListener("click", () => {
    const state = stackState.get(note.id);
    if (!state) {
      return;
    }
    state.coder = !memoUsesCoder(state.coder);
    paintSectionCoder(section, state);
    refreshEditorFields(section);
    resizeAllBlockTextareas(section);
    saveSectionLook(note.id, state);
    closeSectionEditorMenu();
  });
  preview?.addEventListener("change", (event) => {
    const target = event.target;
    const state = stackState.get(note.id);
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox" || !state || !preview) {
      return;
    }
    const boxes = [...preview.querySelectorAll("input[type='checkbox']")];
    const index = boxes.indexOf(target);
    if (index < 0) {
      return;
    }
    const next = toggleTask(state.content, index, target.checked);
    if (next == null || next === state.content) {
      if (next == null) {
        target.checked = !target.checked;
      }
      return;
    }
    pushSectionUndo(state, true);
    state.content = next;
    state.blocks = parseBlocks(next);
    renderSectionBlocks(section, state);
    scheduleSectionSave(section, state);
  });
  preview?.addEventListener("dblclick", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("a, input, img, video, audio, .media-audio, .file-attachment, button")
    ) {
      return;
    }
    const state = stackState.get(note.id);
    mode?.click();
    if (state) {
      sectionTargetArea(section, state)?.focus();
    }
  });
  const visLabel = section.querySelector<HTMLButtonElement>(".visibility-label");
  const audPop = section.querySelector<HTMLElement>(".audience-pop");
  const delNote = section.querySelector<HTMLButtonElement>(".delete-note");
  const delConfirm = section.querySelector<HTMLElement>(".delete-confirm");
  const delNo = section.querySelector<HTMLButtonElement>(".delete-no");
  const delYes = section.querySelector<HTMLButtonElement>(".delete-yes");
  const spaceChoices = section.querySelector<HTMLElement>(".space-choices");
  const resetSectionDelete = () => {
    if (delNote) delNote.hidden = false;
    if (delConfirm) delConfirm.hidden = true;
    if (delYes) delYes.textContent = "Delete";
  };
  const closeSectionAudience = () => {
    if (audPop) audPop.hidden = true;
    visLabel?.setAttribute("aria-expanded", "false");
    resetSectionDelete();
  };
  visLabel?.addEventListener("click", () => {
    if (!audPop) {
      return;
    }
    if (audPop.hidden) {
      resetSectionDelete();
      audPop.hidden = false;
      visLabel.setAttribute("aria-expanded", "true");
      if (spaceChoices) {
        revealPressedChoice(spaceChoices);
      }
      return;
    }
    closeSectionAudience();
  });
  delNote?.addEventListener("click", () => {
    if (delNote) delNote.hidden = true;
    if (delConfirm) delConfirm.hidden = false;
  });
  delNo?.addEventListener("click", () => {
    resetSectionDelete();
  });
  delYes?.addEventListener("click", () => {
    void (async () => {
      if (delYes) delYes.textContent = "Deleting…";
      const pending = saveTimers.get(note.id);
      if (pending) {
        clearTimeout(pending);
        saveTimers.delete(note.id);
      }
      await invoke("delete_note", { id: note.id });
      closeSectionAudience();
    })().catch((error: unknown) => {
      if (delYes) delYes.textContent = "Could not delete";
      console.error(error);
    });
  });
  section.querySelector<HTMLButtonElement>(".pin-toggle")?.addEventListener("click", () => {
    void (async () => {
      await flushSectionSaves([note.id]);
      await invoke("set_pinned", { id: note.id, pinned: false, fromComposer: false });
    })().catch((error: unknown) => {
      console.error(error);
    });
  });
  section.querySelector<HTMLButtonElement>(".fold-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!id || !state) {
      return;
    }
    if (state.collapsed && editingHoldSection === id) {
      editingHoldSection = null;
      if (autoOpenNewSection === id) {
        autoOpenNewSection = null;
      }
      state.hover = false;
      state.suppressHover = isElementHovered(section);
      const isBar = sectionBarOnly(id, state);
      section.classList.toggle("is-bar", isBar);
      section.classList.toggle("hover-open", state.collapsed && !isBar);
      paintSectionColor(section, state);
      paintChrome();
      return;
    }
    void toggleSection(id);
  });
  return section;
}

export async function loadStack() {
  if (!stackEl) {
    return;
  }
  if (!pinnedNoteId || !inTauri()) {
    stackState.clear();
    stackEl.replaceChildren();
    frameEl?.classList.remove("has-stack");
    cardEl.classList.remove("stacked-host", "is-bar");
    return;
  }
  const notes = await invoke<Note[]>("stack_chain", { hostId: pinnedNoteId });
  const existing = [...stackEl.children].map((node) => (node as HTMLElement).dataset.id);
  const previous = new Set(existing.filter((id): id is string => Boolean(id)));
  const nextIds = notes.map((note) => note.id);
  const same = existing.length === nextIds.length && existing.every((id, index) => id === nextIds[index]);
  const joinedIds = initialSizeSynced ? nextIds.filter((id) => !previous.has(id)) : [];
  const autoFoldedJoin = joinedIds.length > 0 && notes.length >= 3;
  if (autoFoldedJoin) {
    hostCollapsed = true;
    hostHover = false;
    suppressHostHover = isElementHovered(cardEl);
    const joinedId = joinedIds[0];
    editingHoldSection = joinedId;
    autoOpenNewSection = joinedId;
    lastActiveSection = joinedId;
  }
  const ids = new Set(nextIds);
  for (const id of [...stackState.keys()]) {
    if (!ids.has(id)) {
      stackState.delete(id);
    }
  }
  for (const note of notes) {
    const prev = stackState.get(note.id);
    const isJoined = autoFoldedJoin && note.id === joinedIds[0];
    const hasPendingSave = saveTimers.has(note.id);
    const content = prev && hasPendingSave ? prev.content : note.content;
    const blocks = prev && prev.content === content ? prev.blocks : parseBlocks(content);
    stackState.set(note.id, {
      collapsed: autoFoldedJoin ? true : Boolean(note.collapsed),
      hover: autoFoldedJoin ? false : (prev?.hover ?? false),
      suppressHover: autoFoldedJoin && !isJoined ? true : (prev?.suppressHover ?? false),
      loaded: prev?.loaded ?? note.content,
      content,
      blocks,
      caret: prev?.caret ?? null,
      history: prev?.history ?? new BlockHistory(),
      hueLight: note.hueLight,
      hueDark: note.hueDark,
      swatches: [...note.swatches],
      opacity: note.opacity,
      theme: prev?.theme ?? namedTheme(note.theme),
      coder:
        prev?.coder ??
        (note.coder === true ? true : note.coder === false ? false : null),
      wrap: prev?.wrap ?? false,
      mdBar: prev?.mdBar ?? false,
      visibility: note.visibility || "PRIVATE",
      space: note.space || "",
      syncState: note.syncState || "local",
      lastError: note.lastError ?? null,
    });
  }
  if (!same) {
    const sections = notes.map((note) => buildSection(note));
    stackEl.replaceChildren(...sections);
    for (const section of sections) {
      const id = section.dataset.id || "";
      const state = stackState.get(id);
      if (!previous.has(id) && state && !sectionBarOnly(id, state)) {
        section.classList.add("joining");
      }
    }
  }
  notes.forEach((note, index) => {
    const section = stackEl.children[index];
    if (section instanceof HTMLElement) {
      syncSection(section, note);
    }
  });
  if (autoFoldedJoin) {
    const joinedId = joinedIds[0];
    const joinedSection = stackEl.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(joinedId)}"]`);
    const joinedState = stackState.get(joinedId);
    if (joinedSection && joinedState) {
      sectionTargetArea(joinedSection, joinedState)?.focus();
    }
  }
  frameEl?.classList.toggle("has-stack", notes.length > 0);
  cardEl.classList.toggle("stacked-host", notes.length > 0);
  cardEl.classList.toggle("is-bar", notes.length > 0 && hostBarOnly());
  if (!initialSizeSynced) {
    initialSizeSynced = true;
    const box = frameEl?.clientHeight ?? 0;
    const { opens, bars } = stackCounts();
    if (opens === 1 && bars === 0 && box > 100) {
      openNoteHeight = Math.max(160, Math.round(box));
      savedHostHeight = 56 + openNoteHeight;
    } else if (opens > 1 && box >= opens * 260 + bars * NOTE_BAR) {
      openNoteHeight = Math.max(160, Math.round((box - bars * NOTE_BAR) / opens));
      savedHostHeight = 56 + openNoteHeight;
    }
  }
  applyOpenHeight();
  if (autoFoldedJoin) {
    const joinedId = joinedIds[0];
    document.documentElement.classList.toggle("collapsed", hostCollapsed);
    document.documentElement.classList.toggle("hover-open", hostCollapsed && !hostBarOnly());
    syncNoteTitle();
    paintThemeIcon();
    syncActiveNoteHeader();
    suppressHostHover = isElementHovered(cardEl);
    stackEl.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
      const id = section.dataset.id;
      const state = id ? stackState.get(id) : undefined;
      if (state && id !== joinedId) {
        state.suppressHover = isElementHovered(section);
      }
    });
  }
  const target = targetWindowHeight();
  const current = await logicalHeight();
  if (!same || Math.abs(target - current) > 4) {
    cancelHeightTween();
    await setLogicalHeight(target);
  }
  chromeSignature = `${stackCounts().opens}:${stackCounts().bars}:${hasStack() ? 1 : 0}`;
}

async function toggleSection(id: string) {
  const state = stackState.get(id);
  if (!state) {
    return;
  }
  state.collapsed = !state.collapsed;
  state.hover = false;
  if (state.collapsed && editingHoldSection === id) {
    editingHoldSection = null;
  }
  if (state.collapsed && autoOpenNewSection === id) {
    autoOpenNewSection = null;
  }
  const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
  state.suppressHover = state.collapsed && isElementHovered(section);
  const isBar = sectionBarOnly(id, state);
  section?.classList.toggle("is-bar", isBar);
  section?.classList.toggle("hover-open", state.collapsed && !isBar);
  paintChrome();
  await invoke("set_collapsed", { id, collapsed: state.collapsed }).catch((error: unknown) => {
    console.error(error);
  });
}

export function syncHeaderCompact() {
  for (const header of document.querySelectorAll<HTMLElement>("#card > header, .stack-note > header")) {
    const parent = header.parentElement;
    const isBar =
      (parent === cardEl && hostBarOnly()) || Boolean(parent?.classList.contains("is-bar"));
    if (isBar) {
      header.classList.remove("compact-meta", "compact-tools");
      continue;
    }
    const headerW = header.clientWidth || cardEl.clientWidth || (frameEl?.clientWidth ?? window.innerWidth - 48);
    if (headerW <= 0) {
      continue;
    }
    const availW = headerW - 20;
    const brandName = header.querySelector<HTMLElement>(".brand-name");
    const label = header.querySelector<HTMLElement>("#visibility-label, .visibility-label");
    const syncBadge = header.querySelector<HTMLElement>("#note-sync, .note-sync");
    const edited = header.querySelector<HTMLElement>("#edited-at, .edited-at");
    const brandW = brandName?.offsetWidth || 58;
    const hasLabel = Boolean(label && !label.hidden);
    const hasSync = Boolean(syncBadge && !syncBadge.hidden);
    const hasEdited = Boolean(edited && !edited.hidden);
    const labelW = hasLabel && label ? label.scrollWidth : 0;
    const syncW = hasSync ? 16 : 0;
    const editedW = hasEdited && edited ? edited.scrollWidth : 0;
    const hasBothMeta = hasLabel && hasEdited;
    const singleMetaW = hasBothMeta ? labelW + syncW + editedW + 12 : labelW + syncW + editedW;
    const twoLineMetaW = Math.max(labelW + syncW, editedW);
    const singleBrandW = brandW + (singleMetaW > 0 ? 6 + singleMetaW : 0);
    const twoLineBrandW = brandW + (twoLineMetaW > 0 ? 6 + twoLineMetaW : 0);
    const fullButtonsRightW = 165;
    const compactMeta = hasBothMeta && availW < singleBrandW + fullButtonsRightW;
    const effectiveBrandW = compactMeta ? twoLineBrandW : singleBrandW;
    const compactTools = availW < effectiveBrandW + fullButtonsRightW;
    header.classList.toggle("compact-meta", compactMeta);
    header.classList.toggle("compact-tools", compactTools);
    if (!compactTools) {
      const tools = header.querySelector<HTMLElement>(".editor-tools");
      const btn = header.querySelector<HTMLElement>(".editor-menu-toggle");
      tools?.classList.remove("open");
      btn?.setAttribute("aria-expanded", "false");
    }
  }
}

export function paintChrome() {
  const hostOpen = hostCollapsed && !hostBarOnly();
  document.documentElement.classList.toggle("collapsed", hostCollapsed);
  document.documentElement.classList.toggle("hover-open", hostOpen);
  const hostFoldBtn = document.querySelector<HTMLButtonElement>("#fold-toggle");
  if (hostFoldBtn) {
    const label = hostCollapsed ? "Unfold memo" : "Fold memo";
    hostFoldBtn.title = label;
    hostFoldBtn.setAttribute("aria-label", label);
    hostFoldBtn.setAttribute("aria-pressed", String(hostCollapsed));
  }
  frameEl?.classList.toggle("has-stack", hasStack());
  cardEl.classList.toggle("is-bar", hasStack() && hostBarOnly());
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (state) {
      const isBar = sectionBarOnly(id, state);
      section.classList.toggle("hover-open", state.collapsed && !isBar);
      const foldBtn = section.querySelector<HTMLButtonElement>(".fold-toggle");
      if (foldBtn) {
        const label = state.collapsed ? "Unfold memo" : "Fold memo";
        foldBtn.title = label;
        foldBtn.setAttribute("aria-label", label);
        foldBtn.setAttribute("aria-pressed", String(state.collapsed));
      }
      if (section.classList.contains("is-bar") !== isBar) {
        section.classList.toggle("is-bar", isBar);
        paintSectionColor(section, state);
      }
    }
  });
  syncNoteTitle();
  paintThemeIcon();
  syncActiveNoteHeader();
  syncHeaderCompact();
  applyOpenHeight();
  if (!inTauri() || isPreviewWindow()) {
    return;
  }
  const { opens, bars } = stackCounts();
  const signature = `${opens}:${bars}:${hasStack() ? 1 : 0}`;
  const first = chromeSignature === null;
  if (chromeSignature === signature) {
    return;
  }
  chromeSignature = signature;
  if (first) {
    return;
  }
  tweenWindowHeight(hasStack() ? targetWindowHeight() : hostBarOnly() ? WINDOW_BAR : savedHostHeight);
}

async function setHostCollapsed(collapsed: boolean) {
  if (hostCollapsed === collapsed) {
    return;
  }
  if (collapsed && !hasStack()) {
    savedHostHeight = await logicalHeight();
    rememberOpenSlice();
  }
  hostCollapsed = collapsed;
  hostHover = false;
  suppressHostHover = collapsed && isElementHovered(cardEl);
  if (collapsed && editingHoldSection === "host") {
    editingHoldSection = null;
  }
  const id = pinnedNoteId || getEditingId();
  if (id && inTauri()) {
    await invoke("set_collapsed", { id, collapsed: hostCollapsed }).catch((error: unknown) => {
      console.error(error);
    });
  }
  paintChrome();
}

export function syncCollapsedPeek() {
  let changed = false;
  if (hostCollapsed) {
    const over = isElementHovered(cardEl);
    if (!over && suppressHostHover) {
      suppressHostHover = false;
    }
    const next = over && !suppressHostHover;
    if (next && autoOpenNewSection !== null && autoOpenNewSection !== "host") {
      dismissAutoOpenNewSection();
      changed = true;
    }
    if (next !== hostHover) {
      hostHover = next;
      changed = true;
    }
  } else if (hostHover) {
    hostHover = false;
    suppressHostHover = false;
    changed = true;
  }
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!state?.collapsed) {
      if (state) {
        state.suppressHover = false;
      }
      return;
    }
    const over = isElementHovered(section);
    if (!over && state.suppressHover) {
      state.suppressHover = false;
    }
    const next = over && !state.suppressHover;
    if (next && autoOpenNewSection !== null && autoOpenNewSection !== id) {
      dismissAutoOpenNewSection();
      changed = true;
    }
    if (next === state.hover) {
      return;
    }
    state.hover = next;
    const isBar = sectionBarOnly(id, state);
    section.classList.toggle("is-bar", isBar);
    section.classList.toggle("hover-open", state.collapsed && !isBar);
    paintSectionColor(section, state);
    changed = true;
  });
  if (changed) {
    paintChrome();
  }
}

export function dragBlocked(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, a, input, textarea, select, audio, video, .media, .media-audio, .file-attachment, #media-context-menu, #resize-grip, .resize-handle, #color-pop, #audience-pop, #format-pop, #md-toolbar, #editor-tools, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools",
      ),
    )
  );
}

type ResizeDir = "w" | "e" | "s" | "sw" | "se";

function resizeZone(event: MouseEvent): ResizeDir | null {
  const target = event.target;
  if (target instanceof Element) {
    if (
      target.closest(
        "button, a, input, textarea, select, #color-pop, #audience-pop, #format-pop, #md-toolbar, #editor-tools, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools",
      )
    ) {
      return null;
    }
    const handle = target.closest<HTMLElement>("[data-resize]");
    const dir = handle?.dataset.resize;
    if (dir === "w" || dir === "e" || dir === "s" || dir === "sw" || dir === "se") {
      return dir;
    }
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = event.clientX;
  const y = event.clientY;
  const nearBottom = h - y <= 48;
  if (nearBottom && w - x <= 44) {
    return "se";
  }
  if (nearBottom && x <= 44) {
    return "sw";
  }
  if (h - y <= 40 && x > 44 && w - x > 44) {
    return "s";
  }
  if (y >= 24 && x <= 30) {
    return "w";
  }
  if (y >= 24 && w - x <= 30) {
    return "e";
  }
  return null;
}

let resizing = false;
let resizingVertical = false;

function startResize(event: MouseEvent, requestedDir?: ResizeDir) {
  if (resizing || !inTauri() || isPreviewWindow()) {
    return;
  }
  let dir = requestedDir ?? resizeZone(event);
  if (!dir) {
    return;
  }
  if (stackCounts().opens <= 0) {
    if (dir === "s") {
      return;
    }
    if (dir === "se") {
      dir = "e";
    } else if (dir === "sw") {
      dir = "w";
    }
  }
  event.preventDefault();
  event.stopPropagation();
  cancelHeightTween();
  resizing = true;
  resizingVertical = dir === "s" || dir === "se" || dir === "sw";
  void invoke("begin_corner_resize", { label: getCurrentWindow().label, edge: dir })
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => {
      const wasVertical = resizingVertical;
      resizing = false;
      resizingVertical = false;
      if (wasVertical) {
        rememberOpenSlice();
      }
    });
}

export function startWindowDrag(event: MouseEvent) {
  if (!inTauri() || isPreviewWindow() || sectionLift !== null) {
    return;
  }
  const dir = resizeZone(event);
  if (dir) {
    startResize(event, dir);
    return;
  }
  event.preventDefault();
  void invoke("begin_memo_drag", { label: getCurrentWindow().label });
}

function typingNote(): boolean {
  if (!document.hasFocus()) {
    return false;
  }
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

function slideOut() {
  if (!inTauri() || isPreviewWindow() || resizing) {
    return;
  }
  void invoke("slide_into_view", { label: getCurrentWindow().label }).catch((error: unknown) => {
    console.error(error);
  });
}

function slideHome() {
  if (!inTauri() || isPreviewWindow() || resizing || typingNote()) {
    return;
  }
  void invoke("slide_back", { label: getCurrentWindow().label }).catch((error: unknown) => {
    console.error(error);
  });
}

function finishSnapDrag() {
  if (!inTauri()) {
    return;
  }
  void invoke("end_memo_drag", { label: getCurrentWindow().label });
}

export function wireChrome() {
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      const dir = resizeZone(event);
      if (!dir) {
        return;
      }
      startResize(event, dir);
    },
    true,
  );
  window.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      const dir = resizeZone(event);
      if (!dir) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      startResize(event, dir);
    },
    true,
  );

  const hostHeader = document.querySelector<HTMLElement>("#card header");
  hostHeader?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragBlocked(event.target)) {
      return;
    }
    startWindowDrag(event);
  });
  const hostFold = document.querySelector<HTMLButtonElement>("#fold-toggle");
  hostFold?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (hostCollapsed && editingHoldSection === "host") {
      editingHoldSection = null;
      hostHover = false;
      suppressHostHover = isElementHovered(cardEl);
      paintChrome();
      return;
    }
    void setHostCollapsed(!hostCollapsed);
  });

  cardEl.addEventListener("click", (event) => {
    if (!hostBarOnly() || pressTravel > 8) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("textarea, button, input, #audience-pop, #color-pop, #format-pop, #md-toolbar, #editor-tools")
    ) {
      return;
    }
    void setHostCollapsed(false);
  });
  cardEl.addEventListener("mouseenter", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    syncCollapsedPeek();
  });
  document.documentElement.addEventListener("mouseenter", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    slideOut();
    syncCollapsedPeek();
  });
  document.documentElement.addEventListener("mouseleave", () => {
    cursorPoint = null;
    cursorKnown = true;
    if (autoOpenNewSection !== null) {
      dismissAutoOpenNewSection();
    }
    syncCollapsedPeek();
    paintChrome();
    slideHome();
  });
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target instanceof Element) {
      const section = target.closest<HTMLElement>(".stack-note");
      if (section?.dataset.id) {
        lastActiveSection = section.dataset.id;
      } else if (cardEl.contains(target)) {
        lastActiveSection = "host";
      }
    }
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "range")) {
      const section = target.closest<HTMLElement>(".stack-note");
      const nextHold = section?.dataset.id ?? (cardEl.contains(target) ? "host" : null);
      if (nextHold && nextHold !== editingHoldSection) {
        editingHoldSection = nextHold;
        syncCollapsedPeek();
        paintChrome();
      }
    }
    syncActiveNoteHeader();
    if (typingNote()) {
      slideOut();
    }
  });
  document.addEventListener("focusout", () => {
    window.setTimeout(() => {
      syncActiveNoteHeader();
      slideHome();
    }, 0);
  });
  window.addEventListener("focus", () => {
    syncActiveNoteHeader();
  });
  window.addEventListener("blur", () => {
    autoOpenNewSection = null;
    if (editingHoldSection !== null) {
      editingHoldSection = null;
      syncCollapsedPeek();
      paintChrome();
    }
    syncActiveNoteHeader();
    window.setTimeout(slideHome, 0);
  });
  cardEl.addEventListener("mouseleave", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    syncCollapsedPeek();
  });

  window.addEventListener("pointerdown", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    pressAt = { x: event.clientX, y: event.clientY };
    pressTravel = 0;
    const target = event.target;
    if (target instanceof Element) {
      const section = target.closest<HTMLElement>(".stack-note");
      if (section?.dataset.id) {
        lastActiveSection = section.dataset.id;
      } else if (cardEl.contains(target)) {
        lastActiveSection = "host";
      }
      syncActiveNoteHeader();
    }
  });
  window.addEventListener("pointermove", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    if (pressAt && event.buttons % 2 === 1) {
      const dx = event.clientX - pressAt.x;
      const dy = event.clientY - pressAt.y;
      pressTravel = Math.max(pressTravel, Math.hypot(dx, dy));
    }
    if (hostCollapsed || stackEl) {
      syncCollapsedPeek();
    }
  });
  window.addEventListener("pointerup", () => {
    finishSnapDrag();
  });
  if (inTauri() && !isPreviewWindow()) {
    void getCurrentWindow().listen<[number, number] | null>("window-cursor", (event) => {
      cursorKnown = true;
      cursorPoint = event.payload ? { x: event.payload[0], y: event.payload[1] } : null;
      if (!cursorPoint && autoOpenNewSection !== null) {
        dismissAutoOpenNewSection();
        paintChrome();
      }
      syncCollapsedPeek();
    });

    void getCurrentWindow().onDragDropEvent((event) => {
      if (mediaPointer.draggingName) {
        return;
      }
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        const factor = window.devicePixelRatio || 1;
        const x = payload.position.x / factor;
        const y = payload.position.y / factor;
        const el = document.elementFromPoint(x, y);
        const section = el?.closest<HTMLElement>(".stack-note") ?? null;
        cardEl.classList.toggle("dropping", !section);
        stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((s) => {
          s.classList.toggle("dropping", s === section);
        });
        return;
      }
      if (payload.type === "leave") {
        cardEl.classList.remove("dropping");
        stackEl?.querySelectorAll<HTMLElement>(".stack-note.dropping").forEach((s) => {
          s.classList.remove("dropping");
        });
        return;
      }
      if (payload.type === "drop") {
        cardEl.classList.remove("dropping");
        stackEl?.querySelectorAll<HTMLElement>(".stack-note.dropping").forEach((s) => {
          s.classList.remove("dropping");
        });
        const factor = window.devicePixelRatio || 1;
        const x = payload.position.x / factor;
        const y = payload.position.y / factor;
        const el = document.elementFromPoint(x, y);
        const targetSection = el?.closest<HTMLElement>(".stack-note") ?? activeStackSection()?.section ?? null;
        void (async () => {
          for (const path of payload.paths) {
            try {
              const md = await invoke<string>("save_media_file", { path });
              insertSnippet(md, targetSection);
            } catch (error) {
              console.error(error);
            }
          }
        })();
      }
    });
  }

  if (frameEl && typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      syncHeaderCompact();
      resizeAllBlockTextareas();
      if (sizingWindow || !resizing || !resizingVertical) {
        return;
      }
      rememberOpenSlice();
    });
    observer.observe(frameEl);
  }

}

export function toggleSectionPreview(section: HTMLElement) {
  const id = section.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  const mode = section.querySelector<HTMLButtonElement>(".mode-toggle");
  const preview = section.querySelector<HTMLElement>(".stack-preview");
  const sectionBlocks = section.querySelector<HTMLElement>(".stack-blocks");
  if (!mode || !preview || !sectionBlocks || !state) {
    return;
  }
  const shortcut = previewShortcut();
  const open = preview.hidden;
  preview.hidden = !open;
  sectionBlocks.hidden = open;
  mode.setAttribute("aria-label", open ? "Edit" : "Preview");
  mode.title = open ? `Edit (${shortcut})` : `Preview (${shortcut})`;
  mode.setAttribute("aria-pressed", String(open));
  if (open) {
    const parsed = marked.parse(state.content, { async: false });
    const html = typeof parsed === "string" ? parsed : "";
    preview.innerHTML = DOMPurify.sanitize(html);
    void hydratePreviewContent(preview, () => !preview.hidden, (name) => {
      void openPreview(name);
    });
  } else {
    renderSectionBlocks(section, state);
    sectionTargetArea(section, state)?.focus();
  }
}

export function insertSectionMedia(section: HTMLElement, name: string, label?: string) {
  const id = section.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  const sectionBlocks = section.querySelector<HTMLElement>(".stack-blocks");
  if (!id || !state || !sectionBlocks) {
    return;
  }
  pushSectionUndo(state, true);
  const area =
    document.activeElement instanceof HTMLTextAreaElement && sectionBlocks.contains(document.activeElement)
      ? document.activeElement
      : sectionTargetArea(section, state);
  const index = area ? Number(area.dataset.index) : state.blocks.length - 1;
  const block = state.blocks[index];
  if (!block || block.kind !== "text") {
    state.blocks.push({ kind: "media", name, label });
  } else {
    const { start, end } = area ? sectionAreaSelection(area, state) : { start: block.text.length, end: block.text.length };
    const before = block.text.slice(0, start).replace(/\n+$/, "");
    const after = block.text.slice(end).replace(/^\n+/, "");
    state.blocks.splice(
      index,
      1,
      { kind: "text", text: before },
      { kind: "media", name, label },
      { kind: "text", text: after },
    );
  }
  state.blocks = ensureTextSlots(state.blocks);
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state, name);
  scheduleSectionSave(section, state);
  const preview = section.querySelector<HTMLElement>(".stack-preview");
  if (preview && !preview.hidden) {
    const parsed = marked.parse(state.content, { async: false });
    const html = typeof parsed === "string" ? parsed : "";
    preview.innerHTML = DOMPurify.sanitize(html);
    void hydratePreviewContent(preview, () => !preview.hidden, (name) => {
      void openPreview(name);
    });
  }
}

export function activeStackSection(): { section: HTMLElement; state: StackState } | null {
  const active = document.activeElement;
  if (active instanceof Element) {
    const section = active.closest<HTMLElement>(".stack-note");
    const id = section?.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (section && state) {
      return { section, state };
    }
    if (cardEl.contains(active)) {
      return null;
    }
  }
  if (lastActiveSection && lastActiveSection !== "host") {
    const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(lastActiveSection)}"]`);
    const state = stackState.get(lastActiveSection);
    if (section && state) {
      return { section, state };
    }
  }
  if (lastActiveSection === "host") {
    return null;
  }
  const hovered = [...(stackEl?.querySelectorAll<HTMLElement>(".stack-note") ?? [])].find((section) =>
    isElementHovered(section),
  );
  const id = hovered?.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  if (hovered && state) {
    return { section: hovered, state };
  }
  return null;
}

