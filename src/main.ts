import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { audienceChoice, revealPressedChoice } from "./look/audience-ui";
import { applyMediaFigureSize, handleBlockAreaNavigation, handleBlockMediaDeletion, syncInlineLineSlot } from "./editor/editor-blocks";
import { memoUsesCoder, refreshEditorFields, setEditorPrefs, wrapEditorField, type EditorPrefs } from "./editor/editor-field";
import { filesFromTransfer, uniqueFiles } from "./media/files";
import { BlockHistory, cloneBlocks, restoreCaret, type Caret } from "./editor/history";
import { darkHue, defaultLook, lightHue, lookFromNote, tinted, type Look } from "./look/look";
import {
  applyCode,
  applyJsonFormat,
  applyTask,
  applyTitle,
  ensureTextSlots,
  mediaTokenRegex,
  noteTitle,
  parseBlocks,
  serializeBlocks,
  tabOnMarkdown,
  taskListOnEnter,
  toggleTask,
  wrapText,
  type Block,
  type Edit,
} from "./editor/markdown-edit";
import { bindMediaEditor, createMedia, isDraggingMedia } from "./media/media-dnd";
import {
  closeMediaContextMenu,
  hydratePreviewContent,
  initLightbox,
  mediaContextMenuOpen,
  previewBodyTarget,
} from "./media/media-elements";
import { paintSurface, paintThemeButton, palette, paperAt, type ThemeName } from "./look/memo-chrome";
import { pointIn, requireEl } from "./dom";
import { inTauri, isPreviewWindow } from "./platform";
import { defaultBinds, domMouseButton, formatBind, isModifierKey, matchBind, matchMouse, modifierDown, type ShortcutBinds } from "./shortcuts";
import {
  activeStackSection,
  applySectionEdit,
  applyStackEditorChrome,
  bindStack,
  dragBlocked,
  hasStack,
  insertSectionMedia,
  loadStack,
  mediaMutatorForSection,
  paintChrome,
  paintSectionAudience,
  redoSection,
  repaintStackColors,
  sectionAreaSelection,
  sectionHue,
  sectionTargetArea,
  sectionTheme,
  syncHeaderCompact,
  setHostCollapsedFlag,
  setSectionHue,
  stackEl,
  stackState,
  startWindowDrag,
  syncCollapsedPeek,
  toggleSectionPreview,
  undoSection,
  wireChrome,
} from "./stack";
import { syncIcon } from "./look/sync-status";
import { editorShell, resizeAllBlockTextareas, sizeBlockTextarea } from "./editor/textarea";
import { exactStamp, relativeTime } from "./time";
import type { MemoSpace, Note } from "./types";
import { isOfflinePrivate, visibilityOptions, visibilityShort } from "./look/visibility";

const card = document.querySelector<HTMLElement>("#card");
const blocks = document.querySelector<HTMLDivElement>("#blocks");
const preview = document.querySelector<HTMLDivElement>("#preview");
const notePane = document.querySelector<HTMLElement>("#note-pane");
const lightbox = document.querySelector<HTMLDivElement>("#lightbox");
const lightboxImage = document.querySelector<HTMLImageElement>("#lightbox-image");
const markdownToggle = document.querySelector<HTMLButtonElement>("#markdown-toggle");
const markdownToolbar = document.querySelector<HTMLDivElement>("#md-toolbar");
const editorMenuToggle = document.querySelector<HTMLButtonElement>("#editor-menu-toggle");
const editorTools = document.querySelector<HTMLDivElement>("#editor-tools");
const coderToggle = document.querySelector<HTMLButtonElement>("#coder-toggle");
const formatToggle = document.querySelector<HTMLButtonElement>("#format-toggle");
const formatPop = document.querySelector<HTMLDivElement>("#format-pop");
const modeToggle = document.querySelector<HTMLButtonElement>("#mode-toggle");
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
const themeIcon = document.querySelector<SVGElement>("#theme-icon");
const colorPop = document.querySelector<HTMLDivElement>("#color-pop");
const hueSlider = document.querySelector<HTMLInputElement>("#hue-slider");
const hueAdd = document.querySelector<HTMLButtonElement>("#hue-add");
const pinToggle = document.querySelector<HTMLButtonElement>("#pin-toggle");
const visibilityLabel = document.querySelector<HTMLButtonElement>("#visibility-label");
const noteSync = document.querySelector<HTMLElement>("#note-sync");
const audiencePop = document.querySelector<HTMLDivElement>("#audience-pop");
const visibilityChoices = document.querySelector<HTMLDivElement>("#visibility-choices");
const spaceBlock = document.querySelector<HTMLDivElement>("#space-block");
const spaceChoices = document.querySelector<HTMLDivElement>("#space-choices");
const editedSep = document.querySelector<HTMLElement>("#edited-sep");
const deleteConfirm = document.querySelector<HTMLDivElement>("#delete-confirm");
const deleteNote = document.querySelector<HTMLButtonElement>("#delete-note");
const deleteYes = document.querySelector<HTMLButtonElement>("#delete-yes");
const deleteNo = document.querySelector<HTMLButtonElement>("#delete-no");
const editedAt = document.querySelector<HTMLElement>("#edited-at");
const memoList = document.querySelector<HTMLElement>("#memo-list");
const recent = document.querySelector<HTMLUListElement>("#recent");
const recentSearch = document.querySelector<HTMLInputElement>("#recent-search");
const recentMore = document.querySelector<HTMLButtonElement>("#recent-more");
const conflict = document.querySelector<HTMLElement>("#conflict");
const conflictLocal = document.querySelector<HTMLButtonElement>("#conflict-local");
const conflictRemote = document.querySelector<HTMLButtonElement>("#conflict-remote");

const collapsedCount = 3;
const recentFetchLimit = 200;

let openGen = 0;
let recentExpanded = false;
let listHidden = false;
let memoQuery = "";
let editingId: string | null = null;
let binds: ShortcutBinds = defaultBinds();
let draftId: string | null = null;
let altHeld = false;
let gestureHeld = false;
let showingPreview = false;
let previewGen = 0;
const pinnedFromScript = (globalThis as { __memosePin?: unknown }).__memosePin;
const themeFromScript = (globalThis as { __memoseTheme?: unknown }).__memoseTheme;
const pinnedThemeHint: ThemeName | null =
  themeFromScript === "dark" || themeFromScript === "light" ? themeFromScript : null;
const pinnedNoteId =
  (typeof pinnedFromScript === "string" ? pinnedFromScript : "") ||
  new URLSearchParams(window.location.search).get("pin") ||
  document.documentElement.dataset.noteId ||
  "";
if (pinnedNoteId) {
  document.documentElement.dataset.noteId = pinnedNoteId;
  document.documentElement.classList.add("pin-window");
}
let noteContent = "";
let loadedContent = "";
let noteBlocks: Block[] = [{ kind: "text", text: "" }];
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let caret: Caret | null = null;

const hostHistory = new BlockHistory();

function pushHostUndo(force = true) {
  hostHistory.push(noteBlocks, caret, force);
}

function resetHostHistory() {
  hostHistory.reset();
}

function undoHost(): boolean {
  const entry = hostHistory.takeUndo(noteBlocks, caret);
  if (!entry) {
    return false;
  }
  noteBlocks = cloneBlocks(entry.blocks);
  caret = entry.caret ? { ...entry.caret } : null;
  publishBlocks();
  scheduleDraft();
  restoreCaret(blocksEl, caret);
  return true;
}

function redoHost(): boolean {
  const entry = hostHistory.takeRedo(noteBlocks, caret);
  if (!entry) {
    return false;
  }
  noteBlocks = cloneBlocks(entry.blocks);
  caret = entry.caret ? { ...entry.caret } : null;
  publishBlocks();
  scheduleDraft();
  restoreCaret(blocksEl, caret);
  return true;
}

marked.setOptions({ gfm: true, breaks: true });

const cardEl = requireEl(card, "card");
const blocksEl = requireEl(blocks, "blocks");
const previewEl = requireEl(preview, "preview");
const notePaneEl = requireEl(notePane, "note pane");
const lightboxEl = requireEl(lightbox, "lightbox");
const lightboxImageEl = requireEl(lightboxImage, "lightbox image");
const markdownToggleEl = requireEl(markdownToggle, "markdown toggle");
const markdownToolbarEl = requireEl(markdownToolbar, "markdown toolbar");
const editorMenuToggleEl = requireEl(editorMenuToggle, "editor menu toggle");
const editorToolsEl = requireEl(editorTools, "editor tools");
const coderToggleEl = requireEl(coderToggle, "coder toggle");
const formatToggleEl = requireEl(formatToggle, "format toggle");
const formatPopEl = requireEl(formatPop, "format menu");
const modeToggleEl = requireEl(modeToggle, "mode toggle");
const themeToggleEl = requireEl(themeToggle, "theme toggle");
const themeIconEl = requireEl(themeIcon, "theme icon");
const colorPopEl = requireEl(colorPop, "color pop");
const hueSliderEl = requireEl(hueSlider, "hue slider");
const hueAddEl = requireEl(hueAdd, "save hue");
const hueSlots = [...document.querySelectorAll<HTMLButtonElement>(".hue-slot")];
const pinToggleEl = requireEl(pinToggle, "pin toggle");
const visibilityLabelEl = requireEl(visibilityLabel, "visibility label");
const noteSyncEl = requireEl(noteSync, "note sync");
const audiencePopEl = requireEl(audiencePop, "audience pop");
const visibilityChoicesEl = requireEl(visibilityChoices, "visibility choices");
const spaceBlockEl = requireEl(spaceBlock, "space block");
const spaceChoicesEl = requireEl(spaceChoices, "space choices");
const editedSepEl = requireEl(editedSep, "edited separator");
const deleteConfirmEl = requireEl(deleteConfirm, "delete confirm");
const deleteNoteEl = requireEl(deleteNote, "delete note");
const deleteYesEl = requireEl(deleteYes, "delete yes");
const deleteNoEl = requireEl(deleteNo, "delete no");
const editedAtEl = requireEl(editedAt, "edited at");
const memoListEl = requireEl(memoList, "memo list");
const recentEl = requireEl(recent, "recent");
const recentSearchEl = requireEl(recentSearch, "recent search");
const recentMoreEl = requireEl(recentMore, "recent more");
const conflictEl = requireEl(conflict, "conflict");
const conflictLocalEl = requireEl(conflictLocal, "keep local");
const conflictRemoteEl = requireEl(conflictRemote, "use server");
let conflictId: string | null = null;

const maxMediaBytes = 32 * 1024 * 1024;

function publishBlocks(focusName?: string) {
  noteBlocks = ensureTextSlots(noteBlocks);
  noteContent = serializeBlocks(noteBlocks);
  syncNoteTitle();
  renderSurface(focusName);
}

function showStored(content: string) {
  showingPreview = false;
  noteContent = content;
  noteBlocks = parseBlocks(content);
  resetHostHistory();
  syncNoteTitle();
  renderSurface();
}

function focusNote() {
  const areas = blocksEl.querySelectorAll("textarea");
  const area = areas.item(areas.length - 1);
  if (area instanceof HTMLTextAreaElement) {
    area.focus();
  }
}

function previewShortcut(): string {
  return formatBind(binds.preview);
}

function renderSurface(focusName?: string) {
  const shortcut = previewShortcut();
  modeToggleEl.setAttribute("aria-pressed", String(showingPreview));
  if (showingPreview) {
    blocksEl.hidden = true;
    previewEl.hidden = false;
    modeToggleEl.setAttribute("aria-label", "Edit");
    modeToggleEl.title = `Edit (${shortcut})`;
    void paintPreview();
    return;
  }
  previewEl.hidden = true;
  blocksEl.hidden = false;
  modeToggleEl.setAttribute("aria-label", "Preview");
  modeToggleEl.title = `Preview (${shortcut})`;
  renderBlocks(focusName);
}

async function paintPreview() {
  const generation = ++previewGen;
  const parsed = marked.parse(noteContent, { async: false });
  const html = typeof parsed === "string" ? parsed : await parsed;
  if (generation !== previewGen) {
    return;
  }
  previewEl.innerHTML = DOMPurify.sanitize(html);
  await hydratePreviewContent(previewEl, () => generation === previewGen, (name) => {
    void openPreview(name);
  });
}

previewEl.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    return;
  }
  const boxes = [...previewEl.querySelectorAll("input[type='checkbox']")];
  const index = boxes.indexOf(target);
  if (index < 0) {
    return;
  }
  const next = toggleTask(noteContent, index, target.checked);
  if (next == null || next === noteContent) {
    if (next == null) {
      target.checked = !target.checked;
    }
    return;
  }
  pushHostUndo(true);
  noteContent = next;
  noteBlocks = parseBlocks(next);
  scheduleDraft();
});

let previewClick: { at: number; x: number; y: number } | null = null;

cardEl.addEventListener(
  "mousedown",
  (event) => {
    if (event.button !== 0 || gestureHeld || modifierDown(binds.gesture, event) || !previewBodyTarget(event.target)) {
      previewClick = null;
      return;
    }
    const now = event.timeStamp;
    const previous = previewClick;
    if (
      showingPreview &&
      previous &&
      now - previous.at < 600 &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 8
    ) {
      previewClick = null;
      event.preventDefault();
      event.stopPropagation();
      togglePreview();
      return;
    }
    previewClick = { at: now, x: event.clientX, y: event.clientY };
  },
  true,
);

function togglePreview() {
  const target = activeStackSection();
  if (target) {
    toggleSectionPreview(target.section);
    return;
  }
  showingPreview = !showingPreview;
  renderSurface();
  if (!showingPreview) {
    focusNote();
  }
}

function renderBlocks(focusName?: string) {
  const reuse = new Map<string, HTMLElement[]>();
  for (const node of blocksEl.querySelectorAll<HTMLElement>("[data-media]")) {
    const name = node.dataset.media;
    if (name) {
      const list = reuse.get(name) ?? [];
      list.push(node);
      reuse.set(name, list);
    }
  }
  blocksEl.replaceChildren();
  let lastText = -1;
  noteBlocks.forEach((block, index) => {
    if (block.kind === "text") {
      lastText = index;
    }
  });
  let currentRow: HTMLElement | null = null;
  let currentRowSideArea: HTMLTextAreaElement | null = null;

  noteBlocks.forEach((block, index) => {
    if (block.kind === "text") {
      const prevBlock = noteBlocks[index - 1];
      const isAfterMedia = prevBlock?.kind === "media";
      const area = document.createElement("textarea");
      area.rows = 1;
      area.spellcheck = false;
      area.autocomplete = "off";
      area.autocapitalize = "off";
      area.setAttribute("autocorrect", "off");
      area.setAttribute("writingsuggestions", "false");
      area.dataset.index = String(index);
      area.value = block.text;
      const canSitOnMediaLine =
        isAfterMedia &&
        currentRow !== null &&
        currentRowSideArea === null &&
        !block.text.includes("\n");
      if (noteBlocks.length === 1) {
        area.placeholder = "Write a note…";
      } else if (canSitOnMediaLine) {
        area.classList.add("inline-line-slot");
      }
      if (index === lastText && !area.classList.contains("inline-line-slot")) {
        area.classList.add("grow");
      }
      const assignedRow = canSitOnMediaLine ? currentRow : null;
      const remember = () => {
        caret = { index, start: area.selectionStart, end: area.selectionEnd };
      };
      area.addEventListener("focus", () => {
        remember();
        sizeBlockTextarea(area);
      });
      area.addEventListener("blur", () => {
        sizeBlockTextarea(area);
      });
      area.addEventListener("keyup", remember);
      area.addEventListener("mouseup", remember);
      area.addEventListener("select", remember);
      area.addEventListener("keydown", (event) => {
        if (
          handleBlockMediaDeletion(
            blocksEl,
            area,
            event,
            () => noteBlocks,
            (mediaIndex, focusIdx, caretPos) => {
              pushHostUndo(true);
              noteBlocks.splice(mediaIndex, 1);
              publishBlocks();
              scheduleDraft();
              const target = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${focusIdx}"]`);
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
        if (handleBlockAreaNavigation(blocksEl, area, event)) {
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
            if (index === lastText) {
              area.classList.add("grow");
            }
            if (assignedRow && editorShell(area).parentElement === assignedRow) {
              assignedRow.after(editorShell(area));
            } else {
              blocksEl.append(editorShell(area));
            }
            sizeBlockTextarea(area);
            area.focus();
            return;
          }
          event.preventDefault();
          pushHostUndo(true);
          const { start, end } = areaSelection(area);
          const beforeLine = area.value.slice(0, start);
          const afterLine = area.value.slice(end);
          if (prevBlock?.kind === "media") {
            prevBlock.inline = beforeLine.length > 0;
          }
          noteBlocks.splice(
            index,
            1,
            { kind: "text", text: beforeLine },
            { kind: "text", text: `\n${afterLine}` },
          );
          publishBlocks();
          scheduleDraft();
          const target = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${index}"]`);
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
          const isEmptyNewMemo =
            !pinnedNoteId &&
            editingId === null &&
            noteContent.trim().length === 0 &&
            noteBlocks.length === 1 &&
            area.value.length === 0;
          if (!isEmptyNewMemo) {
            event.preventDefault();
            const edit = tabOnMarkdown(area.value, area.selectionStart, area.selectionEnd, event.shiftKey);
            applyEdit(area, edit);
            return;
          }
        }
        if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
          return;
        }
        const edit = taskListOnEnter(area.value, area.selectionStart, area.selectionEnd);
        if (!edit) {
          return;
        }
        event.preventDefault();
        applyEdit(area, edit);
      });
      area.addEventListener("beforeinput", () => {
        pushHostUndo(false);
      });
      area.addEventListener("input", () => {
        block.text = area.value;
        syncInlineLineSlot(area, prevBlock, assignedRow, blocksEl, index === lastText);
        noteContent = serializeBlocks(noteBlocks);
        if (mediaTokenRegex.test(area.value)) {
          noteBlocks = parseBlocks(noteContent);
          renderBlocks();
          syncNoteTitle();
          scheduleDraft();
          return;
        }
        sizeBlockTextarea(area);
        remember();
        followEnd(area);
        dismissList();
        syncNoteTitle();
        scheduleDraft();
      });
      if (canSitOnMediaLine && currentRow) {
        currentRow.append(wrapEditorField(area));
        currentRowSideArea = area;
      } else {
        currentRow = null;
        currentRowSideArea = null;
        blocksEl.append(wrapEditorField(area));
      }
      sizeBlockTextarea(area);
      return;
    }
    const existingList = reuse.get(block.name);
    const figure = existingList?.shift() ?? createMedia(block.name, block.label, null, block.width);
    applyMediaFigureSize(figure, block.width);
    figure.dataset.index = String(index);
    const row = document.createElement("div");
    row.className = "media-row";
    row.append(figure);
    blocksEl.append(row);
    currentRow = row;
    currentRowSideArea = null;
  });
  if (!focusName) {
    return;
  }
  const media = blocksEl.querySelector(`[data-media="${CSS.escape(focusName)}"]`);
  const next = media?.parentElement?.querySelector("textarea") ?? media?.nextElementSibling;
  if (next instanceof HTMLTextAreaElement) {
    next.focus();
  }
}

function removeMediaAt(index: number, name: string) {
  const from =
    noteBlocks[index]?.kind === "media"
      ? index
      : noteBlocks.findIndex((block) => block.kind === "media" && block.name === name);
  if (from < 0) {
    return;
  }
  pushHostUndo(true);
  noteBlocks.splice(from, 1);
  publishBlocks();
  syncNoteTitle();
  scheduleDraft();
}

function insertMedia(name: string, label?: string) {
  pushHostUndo(true);
  const area = document.activeElement instanceof HTMLTextAreaElement && blocksEl.contains(document.activeElement)
    ? document.activeElement
    : targetArea();
  const index = area ? Number(area.dataset.index) : noteBlocks.length - 1;
  const block = noteBlocks[index];
  if (!block || block.kind !== "text") {
    noteBlocks.push({ kind: "media", name, label });
  } else {
    const { start, end } = area ? areaSelection(area) : { start: block.text.length, end: block.text.length };
    const before = block.text.slice(0, start).replace(/\n+$/, "");
    const after = block.text.slice(end).replace(/^\n+/, "");
    noteBlocks.splice(
      index,
      1,
      { kind: "text", text: before },
      { kind: "media", name, label },
      { kind: "text", text: after },
    );
  }
  publishBlocks(name);
  syncNoteTitle();
  scheduleDraft();
}

async function openPreview(name: string) {
  await invoke("open_media_preview", { name });
}

function applyEdit(area: HTMLTextAreaElement, edit: Edit) {
  const index = Number(area.dataset.index);
  const block = noteBlocks[index];
  if (!block || block.kind !== "text") {
    return;
  }
  pushHostUndo(true);
  area.value = edit.value;
  block.text = edit.value;
  noteContent = serializeBlocks(noteBlocks);
  if (mediaTokenRegex.test(area.value)) {
    noteBlocks = parseBlocks(noteContent);
    renderBlocks();
    syncNoteTitle();
    scheduleDraft();
    return;
  }
  sizeBlockTextarea(area);
  const start = Math.min(edit.start, edit.value.length);
  const end = Math.min(edit.end, edit.value.length);
  area.focus();
  area.setSelectionRange(start, end);
  caret = { index, start, end };
  followEnd(area);
  dismissList();
  syncNoteTitle();
  scheduleDraft();
}

function followEnd(area: HTMLTextAreaElement) {
  if (area.selectionStart !== area.value.length || area.selectionEnd !== area.value.length) {
    return;
  }
  const container = area.closest<HTMLElement>("#blocks, .stack-blocks");
  const pin = () => {
    if (area.selectionEnd === area.value.length && container) {
      const cRect = container.getBoundingClientRect();
      const aRect = area.getBoundingClientRect();
      if (aRect.bottom > cRect.bottom) {
        container.scrollTop += aRect.bottom - cRect.bottom + 8;
      }
    }
  };
  pin();
  requestAnimationFrame(pin);
}

function areaSelection(area: HTMLTextAreaElement): { start: number; end: number } {
  if (document.activeElement === area) {
    return { start: area.selectionStart, end: area.selectionEnd };
  }
  if (caret && Number(area.dataset.index) === caret.index) {
    return {
      start: Math.min(caret.start, area.value.length),
      end: Math.min(caret.end, area.value.length),
    };
  }
  return { start: area.value.length, end: area.value.length };
}

function targetArea(): HTMLTextAreaElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && blocksEl.contains(active)) {
    return active;
  }
  if (caret) {
    const found = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${caret.index}"]`);
    if (found) {
      return found;
    }
  }
  const areas = blocksEl.querySelectorAll("textarea");
  const last = areas.item(areas.length - 1);
  return last instanceof HTMLTextAreaElement ? last : null;
}

function applyMarkdown(kind: string) {
  if (showingPreview) {
    showingPreview = false;
    renderSurface();
  }
  const area = targetArea();
  if (!area) {
    return;
  }
  const { start, end } = areaSelection(area);
  const value = area.value;
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
  applyEdit(area, edit);
}

function closeFormatPop() {
  formatPopEl.hidden = true;
  formatToggleEl.setAttribute("aria-expanded", "false");
}

function insertSnippet(snippet: string, targetSection?: HTMLElement | null) {
  const match = snippet.trim().match(mediaTokenRegex);
  if (!match?.[3]) {
    return;
  }
  const section = targetSection !== undefined ? targetSection : (activeStackSection()?.section ?? null);
  if (section) {
    insertSectionMedia(section, match[3], match[2] || undefined);
    return;
  }
  insertMedia(match[3], match[2] || undefined);
}

async function attachFiles(files: File[], targetSection?: HTMLElement | null) {
  if (!inTauri()) {
    return;
  }
  for (const file of files) {
    if (file.size > maxMediaBytes) {
      console.error("File is larger than 32 MB");
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const markdown = await invoke<string>("save_media", {
        bytes,
        filename: file.name || null,
        mime: file.type || null,
      });
      insertSnippet(markdown, targetSection);
    } catch (error) {
      console.error(error);
    }
  }
}

function syncNoteTitle() {
  const title = document.querySelector("#note-title");
  if (title) {
    title.textContent = noteTitle(noteContent) || "Note";
  }
}

function scheduleDraft() {
  if (!inTauri()) {
    return;
  }
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    void persistDraft().catch((error: unknown) => {
      console.error(error);
    });
  }, 300);
}

async function persistDraft() {
  const noteId = editingId || pinnedNoteId || null;
  if (noteId) {
    await invoke("save_edit", { id: noteId, content: noteContent });
    setEditedAt(Date.now());
    if (lookUnsaved || lookTimer !== undefined) {
      await flushLook();
    }
    return;
  }
  const saved = await invoke<Note | null>("upsert_draft", { content: noteContent });
  if (!saved) {
    draftId = null;
    setEditedAt(null);
    return;
  }
  setEditedAt(saved.updatedAt);
  if (audienceDirty) {
    await saveNoteAudience(saved.id);
  }
  const idChanged = draftId !== saved.id;
  draftId = saved.id;
  if (idChanged || lookUnsaved || lookTimer !== undefined) {
    clearTimeout(lookTimer);
    lookTimer = undefined;
    lookUnsaved = false;
    await enqueueLook(saved.id);
  }
}

async function openRecent(item: Note) {
  if (pinnedNoteId) {
    dismissList();
    if (item.id === pinnedNoteId) {
      focusNote();
      return;
    }
    const stackedSection = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(item.id)}"]`);
    const stackedState = stackState.get(item.id);
    if (stackedSection && stackedState) {
      sectionTargetArea(stackedSection, stackedState)?.focus();
      return;
    }
    if (inTauri()) {
      await invoke("set_pinned", { id: item.id, pinned: true, fromComposer: false });
    }
    return;
  }
  if (editingId === item.id) {
    await returnToNewMemo(openGen);
    return;
  }
  clearTimeout(draftTimer);
  const typed = noteContent;
  const savingNewMemo = editingId === null && typed.trim().length > 0;
  if (inTauri() && savingNewMemo) {
    if (audienceDirty) {
      await persistDraft();
    }
    await attachPendingLook();
    await invoke("commit_note", { content: typed });
  } else {
    if (inTauri() && editingId !== null && typed.trim().length > 0) {
      await invoke("save_edit", { id: editingId, content: typed });
    }
    await flushLook();
  }
  let opened = item;
  if (inTauri() && (item.syncState === "remote" || item.syncState === "conflict")) {
    try {
      opened = await invoke<Note>("get_note", { id: item.id });
    } catch (error) {
      console.error(error);
      return;
    }
  }
  editingId = opened.id;
  draftId = null;
  showStored(opened.content);
  adoptLook(lookFromNote(opened));
  setConflict(opened.syncState === "conflict" ? opened.id : null);
  setPinPressed(opened.pinned);
  setEditedAt(opened.updatedAt);
  paintAudience(opened);
  markSelectedNote();
  focusNote();
  if (savingNewMemo || opened.syncState !== item.syncState) {
    await refreshRecent();
  }
}

function setConflict(id: string | null) {
  conflictId = id;
  conflictEl.hidden = id === null;
}

function setPinPressed(on: boolean) {
  pinToggleEl.setAttribute("aria-pressed", String(on));
}

let syncEnabled = false;
let defaultVisibility = "PRIVATE";
let defaultSpace = "";
let knownSpaces: MemoSpace[] = [];
let audienceDirty = false;
let audiencePainted = false;
let chosenVisibility = "PRIVATE";
let chosenSpace = "";
let chosenSyncState = "local";
let chosenSyncError: string | null = null;

function paintNoteSync() {
  const icon = syncIcon(chosenSyncState, chosenVisibility);
  noteSyncEl.hidden = visibilityLabelEl.hidden;
  noteSyncEl.innerHTML = icon.svg;
  noteSyncEl.title = chosenSyncError ?? icon.label;
}

function refreshMetaSep() {
  editedSepEl.hidden = visibilityLabelEl.hidden || editedAtEl.hidden;
  paintNoteSync();
  syncHeaderCompact();
}

function paintAudienceMenu() {
  visibilityChoicesEl.replaceChildren();
  for (const option of visibilityOptions) {
    if (option.value === "SPACE" && knownSpaces.length === 0) {
      continue;
    }
    visibilityChoicesEl.append(
      audienceChoice(option.label, option.hint, chosenVisibility === option.value, () => {
        chooseVisibility(option.value);
      }),
    );
  }
  spaceChoicesEl.replaceChildren();
  spaceBlockEl.hidden = knownSpaces.length === 0 || isOfflinePrivate(chosenVisibility);
  if (spaceBlockEl.hidden) {
    return;
  }
  spaceChoicesEl.append(
    audienceChoice("Unassigned", "", chosenSpace === "", () => {
      chooseSpace("");
    }),
  );
  for (const space of knownSpaces) {
    spaceChoicesEl.append(
      audienceChoice(
        space.title,
        space.synced === false ? "Not on server" : "",
        chosenSpace === space.name,
        () => {
          chooseSpace(space.name);
        },
      ),
    );
  }
  if (!audiencePopEl.hidden) {
    revealPressedChoice(spaceChoicesEl);
  }
}

function paintAudience(
  note: {
    visibility?: string | null;
    space?: string | null;
    syncState?: string | null;
    lastError?: string | null;
  } | null,
) {
  audiencePainted = true;
  let visibility = note?.visibility || defaultVisibility || "PRIVATE";
  if (!visibilityOptions.some((option) => option.value === visibility)) {
    visibility = "PRIVATE";
  }
  if (visibility === "SPACE" && knownSpaces.length === 0 && !note?.visibility) {
    visibility = "PRIVATE";
  }
  chosenVisibility = visibility;
  chosenSpace = isOfflinePrivate(visibility)
    ? ""
    : (note?.space ?? (note?.visibility ? "" : defaultSpace));
  chosenSyncState = note?.syncState || "local";
  chosenSyncError = note?.lastError ?? null;
  visibilityLabelEl.hidden = false;
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace, knownSpaces);
  paintAudienceMenu();
  refreshMetaSep();
  audienceDirty = false;
  if (!note && look.hueLight == null && look.hueDark == null) {
    applySpaceDefaultLook(chosenSpace);
  }
}

function composerIsNewMemo() {
  return !pinnedNoteId && !editingId;
}

function spaceDefaultHue(name: string): number | null {
  if (!name) {
    return null;
  }
  const hue = knownSpaces.find((item) => item.name === name)?.hue;
  return typeof hue === "number" ? hue : null;
}

function applySpaceDefaultLook(space: string) {
  if (!composerIsNewMemo()) {
    return;
  }
  const hue = spaceDefaultHue(space);
  look.hueLight = hue;
  look.hueDark = hue;
  paintLook();
  syncSlider();
  scheduleLook();
}

function chooseVisibility(value: string) {
  chosenVisibility = value;
  if (isOfflinePrivate(value)) {
    chosenSpace = "";
    chosenSyncState = "local";
    chosenSyncError = null;
  } else if (value === "SPACE" && chosenSpace === "" && knownSpaces[0]) {
    chosenSpace = knownSpaces[0].name;
  }
  if (!isOfflinePrivate(value) && chosenSyncState === "local" && syncEnabled) {
    chosenSyncState = "pending";
  }
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace, knownSpaces);
  paintAudienceMenu();
  paintNoteSync();
  persistAudience();
  applySpaceDefaultLook(chosenSpace);
}

function chooseSpace(value: string) {
  chosenSpace = value;
  if (isOfflinePrivate(chosenVisibility)) {
    chosenVisibility = "PRIVATE";
  } else if (value === "" && chosenVisibility === "SPACE") {
    chosenVisibility = "PRIVATE";
  }
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace, knownSpaces);
  paintAudienceMenu();
  paintNoteSync();
  persistAudience();
  applySpaceDefaultLook(chosenSpace);
}

function persistAudience() {
  audienceDirty = true;
  const id = currentNoteId();
  if (!id) {
    return;
  }
  void saveNoteAudience(id).catch((error: unknown) => {
    console.error(error);
  });
}

async function loadAudience() {
  if (!inTauri()) {
    return;
  }
  try {
    const settings = await invoke<{ baseUrl: string; visibility: string; space: string }>("get_settings");
    syncEnabled = settings.baseUrl.trim() !== "";
    defaultVisibility = settings.visibility || "PRIVATE";
    defaultSpace = settings.space || "";
    knownSpaces = syncEnabled ? await invoke<MemoSpace[]>("list_memo_spaces") : [];
  } catch (error) {
    console.error(error);
    syncEnabled = false;
    knownSpaces = [];
  }
  if (!audiencePainted || (!pinnedNoteId && !editingId && !audienceDirty)) {
    paintAudience(null);
    return;
  }
  visibilityLabelEl.hidden = false;
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace, knownSpaces);
  paintAudienceMenu();
  refreshMetaSep();
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (state) {
      paintSectionAudience(section, state);
    }
  });
}

async function saveNoteAudience(id: string) {
  audienceDirty = false;
  await invoke("set_note_audience", {
    id,
    visibility: chosenVisibility,
    space: chosenSpace,
  });
}

function setEditedAt(ms: number | null) {
  if (ms == null || ms <= 0) {
    editedAtEl.hidden = true;
    editedAtEl.textContent = "";
    editedAtEl.removeAttribute("title");
    refreshMetaSep();
    return;
  }
  editedAtEl.hidden = false;
  editedAtEl.textContent = relativeTime(ms);
  editedAtEl.title = exactStamp(ms);
  refreshMetaSep();
}

function clearMemoQuery() {
  memoQuery = "";
  recentSearchEl.value = "";
}

function showMemoSearch(on: boolean) {
  recentSearchEl.hidden = !on;
  if (!on) {
    clearMemoQuery();
  }
}

function dismissList() {
  if (pinnedNoteId) {
    if (!document.documentElement.classList.contains("pin-search-open")) {
      return;
    }
    document.documentElement.classList.remove("pin-search-open");
    recentExpanded = false;
    listHidden = true;
    memoListEl.hidden = true;
    recentEl.hidden = true;
    recentEl.classList.remove("expanded");
    showMemoSearch(false);
    recentMoreEl.hidden = true;
    return;
  }
  if (listHidden) {
    return;
  }
  recentExpanded = false;
  listHidden = true;
  memoListEl.hidden = true;
  recentEl.hidden = true;
  recentEl.classList.remove("expanded");
  showMemoSearch(false);
  recentMoreEl.hidden = false;
  recentMoreEl.textContent = "More";
  recentMoreEl.setAttribute("aria-expanded", "false");
  void refreshRecent().catch((error: unknown) => {
    console.error(error);
  });
}

let recentFlight: Promise<void> | null = null;
let recentAgain = false;
let recentTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRecent() {
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => {
    void refreshRecent();
  }, 200);
}

async function refreshRecent() {
  if (pinnedNoteId && !document.documentElement.classList.contains("pin-search-open")) {
    return;
  }
  if (recentFlight) {
    recentAgain = true;
    return recentFlight;
  }
  recentFlight = refreshRecentNow().finally(() => {
    recentFlight = null;
    if (recentAgain) {
      recentAgain = false;
      void refreshRecent();
    }
  });
  return recentFlight;
}

async function refreshRecentNow() {
  const notes = await invoke<Note[]>("list_recent", { limit: recentFetchLimit });
  const openId = editingId || draftId;
  if (openId) {
    const current = notes.find((item) => item.id === openId);
    if (current) {
      chosenSyncState = current.syncState;
      chosenSyncError = current.lastError ?? null;
      if (current.visibility) {
        chosenVisibility = current.visibility;
      }
      paintNoteSync();
    }
  }
  const forcePinSearch = Boolean(pinnedNoteId && document.documentElement.classList.contains("pin-search-open"));
  if (notes.length === 0 && !forcePinSearch) {
    memoListEl.hidden = true;
    recentEl.replaceChildren();
    recentEl.hidden = true;
    showMemoSearch(false);
    recentMoreEl.hidden = true;
    return;
  }
  if (listHidden && !forcePinSearch) {
    memoListEl.hidden = true;
    recentEl.replaceChildren();
    recentEl.hidden = true;
    recentEl.classList.remove("expanded");
    showMemoSearch(false);
    recentMoreEl.hidden = false;
    recentMoreEl.textContent = "More";
    recentMoreEl.setAttribute("aria-expanded", "false");
    return;
  }
  if (notes.length <= collapsedCount && !forcePinSearch && !recentExpanded) {
    recentExpanded = false;
  }
  memoListEl.hidden = false;
  recentEl.hidden = false;
  showMemoSearch(recentExpanded || forcePinSearch);
  const visible = recentExpanded || forcePinSearch
    ? notes.filter((item) => item.content.toLowerCase().includes(memoQuery))
    : notes.slice(0, collapsedCount);
  recentEl.classList.toggle("expanded", recentExpanded || forcePinSearch);
  recentEl.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No matches";
    recentEl.append(empty);
  }
  for (const item of visible) {
    const row = document.createElement("li");
    row.dataset.id = item.id;
    if (item.id === editingId) {
      row.classList.add("selected");
    }
    const title = document.createElement("button");
    title.type = "button";
    title.className = "title";
    title.textContent = noteTitle(item.content);
    title.addEventListener("click", () => {
      void openRecent(item).catch((error: unknown) => {
        console.error(error);
      });
    });
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = relativeTime(item.updatedAt);
    when.title = exactStamp(item.updatedAt);
    const sync = document.createElement("span");
    sync.className = "sync";
    const icon = syncIcon(item.syncState, item.visibility);
    sync.innerHTML = icon.svg;
    sync.title = item.lastError ?? icon.label;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin icon-button";
    pin.innerHTML = pinToggleEl.innerHTML;
    pin.setAttribute("aria-label", item.pinned ? "Unpin" : "Pin");
    pin.setAttribute("aria-pressed", String(item.pinned));
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      void invoke("set_pinned", { id: item.id, pinned: !item.pinned, fromComposer: false })
        .then(() => refreshRecent())
        .catch((error: unknown) => {
          console.error(error);
        });
    });
    const label = document.createElement("div");
    label.className = "label";
    label.append(title, when);
    row.append(label, sync, pin);
    recentEl.append(row);
  }
  recentMoreEl.hidden = notes.length <= collapsedCount;
  recentMoreEl.textContent = recentExpanded ? "Less" : "More";
  recentMoreEl.setAttribute("aria-expanded", String(recentExpanded));
}

async function loadDraft() {
  await flushLook();
  const draft = await invoke<Note | null>("load_draft");
  draftId = draft?.id ?? null;
  showStored(draft?.content ?? "");
  editingId = null;
  setEditedAt(draft?.updatedAt ?? null);
  paintAudience(draft);
  adoptLook(draft ? lookFromNote(draft) : defaultLook());
  if (!draft || (draft.hueLight == null && draft.hueDark == null)) {
    applySpaceDefaultLook(draft?.space || chosenSpace);
  }
}

let look: Look = { opacity: 100, hueLight: null, hueDark: null, swatches: [], theme: null, coder: null };
let coderWrap = false;
let appTheme: ThemeName = "light";
let lookTimer: ReturnType<typeof setTimeout> | undefined;
let lookWrite: Promise<void> = Promise.resolve();
let lookUnsaved = false;
let opacityCarry = 100;

function currentTheme(): ThemeName {
  return look.theme ?? pinnedThemeHint ?? appTheme;
}

function currentLookId(): string | null {
  if (pinnedNoteId) {
    return pinnedNoteId;
  }
  return editingId || draftId;
}

function adoptLook(next: Look) {
  look = {
    opacity: next.opacity,
    hueLight: next.hueLight,
    hueDark: next.hueDark,
    swatches: [...next.swatches],
    theme: next.theme,
    coder: next.coder ?? null,
  };
  opacityCarry = look.opacity;
  lookUnsaved = false;
  coderWrap = false;
  paintLook();
  syncSlider();
}

function themeHue(): number | null {
  return currentTheme() === "dark" ? look.hueDark : look.hueLight;
}

function activeHue(): number {
  return themeHue() ?? (currentTheme() === "dark" ? darkHue : lightHue);
}

function paintThemeIcon() {
  const hostColorMode = hasStack() ? !altHeld : altHeld;
  paintThemeButton(themeToggleEl, themeIconEl, currentTheme(), hostColorMode);
  repaintStackColors();
}

function paintLook() {
  const theme = currentTheme();
  const hue = theme === "dark" ? look.hueDark : look.hueLight;
  paintSurface(cardEl, theme, hue, look.opacity);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.setProperty("--paper-alpha", `${look.opacity}%`);
  const colors = hue == null ? null : palette(theme, hue);
  for (const name of tinted) {
    if (colors) {
      root.style.setProperty(name, colors[name]);
    } else {
      root.style.removeProperty(name);
    }
  }
  if (altHeld) {
    paintThemeIcon();
  }
  paintCoder();
  repaintStackColors();
}

function paintCoder() {
  const on = memoUsesCoder(look.coder);
  cardEl.toggleAttribute("data-coder", on);
  cardEl.toggleAttribute("data-wrap", on && coderWrap);
  coderToggleEl.setAttribute("aria-pressed", String(on));
  formatPopEl.querySelector("[data-format='wrap']")?.setAttribute("aria-pressed", String(coderWrap));
  if (!on) {
    closeFormatPop();
  }
  applyStackEditorChrome();
  refreshEditorFields();
  resizeAllBlockTextareas(cardEl);
}

function paintSlots() {
  const theme = currentTheme();
  const current = themeHue();
  hueSlots.forEach((slot, index) => {
    const hue = look.swatches[index];
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
  const hue = Number(hueSliderEl.value);
  hueAddEl.disabled = look.swatches.length >= 6 || look.swatches.includes(hue);
}

function syncSlider() {
  const hue = activeHue();
  hueSliderEl.value = String(hue);
  hueSliderEl.style.setProperty("--thumb", paperAt(currentTheme(), hue));
  paintSlots();
}

function applyTheme(theme: ThemeName) {
  appTheme = theme;
  paintThemeIcon();
  paintLook();
  syncSlider();
}

function enqueueLook(id: string): Promise<void> {
  const payload = {
    id,
    opacity: look.opacity,
    hueLight: look.hueLight,
    hueDark: look.hueDark,
    swatches: [...look.swatches],
    theme: look.theme,
    coder: look.coder,
  };
  lookWrite = lookWrite
    .then(() => invoke("save_look", payload))
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error(error);
    });
  return lookWrite;
}

let pinnedOpacityTimer: ReturnType<typeof setTimeout> | undefined;

function showingPinned(): boolean {
  return pinnedNoteId !== "" || pinToggleEl.getAttribute("aria-pressed") === "true";
}

let pinnedOpacityFrame = 0;
let pinnedOpacityLive = 0;

function schedulePinnedOpacity(opacity: number) {
  pinnedOpacityLive = opacity;
  if (pinnedOpacityFrame === 0) {
    pinnedOpacityFrame = requestAnimationFrame(() => {
      pinnedOpacityFrame = 0;
      const value = pinnedOpacityLive;
      void invoke("set_pinned_opacity", { opacity: value, persist: false }).catch((error: unknown) => {
        console.error(error);
      });
    });
  }
  clearTimeout(pinnedOpacityTimer);
  pinnedOpacityTimer = setTimeout(() => {
    pinnedOpacityTimer = undefined;
    void invoke("set_pinned_opacity", { opacity: pinnedOpacityLive }).catch((error: unknown) => {
      console.error(error);
    });
  }, 160);
}

function scheduleLook() {
  clearTimeout(lookTimer);
  const id = currentLookId();
  if (!id || !inTauri()) {
    lookUnsaved = true;
    return;
  }
  lookUnsaved = false;
  lookTimer = setTimeout(() => {
    lookTimer = undefined;
    void enqueueLook(id);
  }, 80);
}

function flushLook(): Promise<void> {
  const pending = lookTimer !== undefined || lookUnsaved;
  clearTimeout(lookTimer);
  lookTimer = undefined;
  const id = currentLookId();
  if (!pending || !id || !inTauri()) {
    return Promise.resolve();
  }
  lookUnsaved = false;
  return enqueueLook(id);
}

async function attachPendingLook() {
  if (!pinnedNoteId && !editingId && (lookUnsaved || lookTimer !== undefined) && !draftId && noteContent.trim()) {
    const saved = await invoke<Note | null>("upsert_draft", { content: noteContent });
    if (saved) {
      draftId = saved.id;
    }
  }
  await flushLook();
}

function markSelectedNote() {
  for (const row of recentEl.querySelectorAll<HTMLElement>("li[data-id]")) {
    row.classList.toggle("selected", row.dataset.id === editingId);
  }
}

type RandomStrategy = "golden-ratio" | "analogous" | "clamped-random" | "complementary";

function randomHue(strategy: RandomStrategy = "golden-ratio") {
  const target = activeStackSection();
  const current = target
    ? (sectionHue(target.state) ?? (sectionTheme(target.state) === "dark" ? darkHue : lightHue))
    : activeHue();

  let hue = current;
  switch (strategy) {
    case "golden-ratio": {
      const jitter = Math.random() * 36 - 18;
      hue = Math.floor((current + 222.5 + jitter + 360) % 360);
      break;
    }
    case "analogous": {
      const shift = Math.random() > 0.5 ? 35 : -35;
      hue = Math.floor((current + shift + 360) % 360);
      break;
    }
    case "complementary":
      hue = Math.floor((current + 180) % 360);
      break;
    case "clamped-random":
    default:
      hue = (current + 45 + Math.floor(Math.random() * 270)) % 360;
      break;
  }

  if (target) {
    const slider = target.section.querySelector<HTMLInputElement>(".hue-slider");
    if (slider) {
      slider.value = String(hue);
    }
    setSectionHue(target.section, target.state, hue);
  } else {
    setThemeHue(hue);
  }
}

function setThemeHue(hue: number) {
  if (currentTheme() === "dark") {
    look.hueDark = hue;
  } else {
    look.hueLight = hue;
  }
  paintLook();
  syncSlider();
  scheduleLook();
}

async function loadTheme() {
  if (!inTauri()) {
    return;
  }
  const theme = await invoke<string>("get_theme");
  applyTheme(theme === "dark" ? "dark" : "light");
}

async function focusComposer(generation: number) {
  openGen = generation;
  setConflict(null);
  listHidden = false;
  await loadDraft();
  setPinPressed(false);
  await refreshRecent();
  focusNote();
}

async function cycleComposer(generation: number) {
  openGen = generation;
  if (editingId === null) {
    await openLastModified();
    return;
  }
  await returnToNewMemo(generation);
}

async function openLastModified() {
  clearTimeout(draftTimer);
  const notes = await invoke<Note[]>("list_recent", { limit: 1 });
  const latest = notes.find((note) => note.id !== draftId);
  if (!latest) {
    focusNote();
    return;
  }
  const typed = noteContent;
  if (editingId === null && typed.trim().length > 0) {
    if (audienceDirty) {
      await persistDraft();
    }
    await attachPendingLook();
    await invoke("commit_note", { content: typed });
    showStored("");
  }
  await openRecent(latest);
}

async function returnToNewMemo(generation: number) {
  openGen = generation;
  setConflict(null);
  listHidden = false;
  recentExpanded = false;
  clearTimeout(draftTimer);
  const noteId = editingId;
  if (noteId && noteContent.trim().length > 0) {
    await invoke("save_edit", { id: noteId, content: noteContent });
  }
  await flushLook();
  editingId = null;
  draftId = null;
  showStored("");
  adoptLook(defaultLook());
  setPinPressed(false);
  setEditedAt(null);
  paintAudience(null);
  await refreshRecent();
  focusNote();
}

async function startFresh(generation: number) {
  openGen = generation;
  setConflict(null);
  listHidden = false;
  recentExpanded = false;
  clearTimeout(draftTimer);
  const noteId = editingId;
  if (noteId) {
    if (noteContent.trim().length > 0) {
      await invoke("save_edit", { id: noteId, content: noteContent });
    }
    await flushLook();
  } else if (noteContent.trim().length > 0 && !pinnedNoteId) {
    if (audienceDirty) {
      await persistDraft();
    }
    await attachPendingLook();
    await invoke("commit_note", { content: noteContent });
  } else {
    await flushLook();
  }
  editingId = null;
  draftId = null;
  showStored("");
  adoptLook(defaultLook());
  setPinPressed(false);
  setEditedAt(null);
  paintAudience(null);
  await refreshRecent();
  focusNote();
}

recentSearchEl.addEventListener("input", () => {
  memoQuery = recentSearchEl.value.trim().toLowerCase();
  void refreshRecent().catch((error: unknown) => {
    console.error(error);
  });
});

recentMoreEl.addEventListener("click", () => {
  if (listHidden) {
    listHidden = false;
  } else {
    recentExpanded = !recentExpanded;
  }
  void refreshRecent().catch((error: unknown) => {
    console.error(error);
  });
});

function toggleMemoSearchByTab() {
  if (pinnedNoteId) {
    const isOpen = document.documentElement.classList.contains("pin-search-open");
    if (isOpen) {
      dismissList();
      if (document.activeElement === recentSearchEl) {
        recentSearchEl.blur();
      }
      return;
    }
    document.documentElement.classList.add("pin-search-open");
    listHidden = false;
    recentExpanded = true;
    showMemoSearch(true);
    memoListEl.hidden = false;
    recentEl.hidden = false;
    recentSearchEl.focus();
    recentSearchEl.select();
    void refreshRecent().catch((error: unknown) => {
      console.error(error);
    });
    return;
  }
  const searchOpen = !recentSearchEl.hidden && !listHidden && recentExpanded;
  if (searchOpen) {
    recentExpanded = false;
    showMemoSearch(false);
    void refreshRecent().then(() => {
      if (!pinnedNoteId && editingId === null && noteContent.trim().length === 0) {
        focusNote();
      } else if (document.activeElement === recentSearchEl) {
        recentSearchEl.blur();
      }
    }).catch((error: unknown) => {
      console.error(error);
    });
    return;
  }
  listHidden = false;
  recentExpanded = true;
  showMemoSearch(true);
  memoListEl.hidden = false;
  recentEl.hidden = false;
  recentSearchEl.focus();
  recentSearchEl.select();
  void refreshRecent().then(() => {
    recentSearchEl.focus();
  }).catch((error: unknown) => {
    console.error(error);
  });
}

notePaneEl.addEventListener("mousedown", () => {
  dismissList();
});

cardEl.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
    return;
  }
  const target = event.target;
  if (target instanceof Element && target.closest("#card > header, .stack-note")) {
    return;
  }
  if (gestureHeld || modifierDown(binds.gesture, event)) {
    if (
      target instanceof Element &&
      target.closest(
        "#theme-toggle, #color-pop, #audience-pop, #visibility-label, #markdown-toggle, #md-toolbar, #coder-toggle, #format-toggle, #format-pop, #editor-menu-toggle, #editor-tools, .editor-menu-toggle, .editor-tools, #resize-grip, .resize-handle",
      )
    ) {
      return;
    }
    startWindowDrag(event);
    return;
  }
  if (!(target instanceof Element)) {
    return;
  }
  if (dragBlocked(target)) {
    return;
  }
  startWindowDrag(event);
});

let lastPasteHandledAt = 0;

function insertPlainText(text: string, targetSection?: HTMLElement | null) {
  if (targetSection) {
    const id = targetSection.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!state) {
      return;
    }
    const area = sectionTargetArea(targetSection, state);
    if (!area) {
      return;
    }
    const { start, end } = sectionAreaSelection(area, state);
    const value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
    const cursor = start + text.length;
    applySectionEdit(targetSection, state, area, { value, start: cursor, end: cursor });
    return;
  }
  const area = targetArea();
  if (!area) {
    return;
  }
  const { start, end } = areaSelection(area);
  const value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
  const cursor = start + text.length;
  applyEdit(area, { value, start: cursor, end: cursor });
}

document.addEventListener("paste", (event) => {
  if (isPreviewWindow()) {
    return;
  }
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    return;
  }
  lastPasteHandledAt = performance.now();
  const targetSection =
    (target instanceof Element ? target.closest<HTMLElement>(".stack-note") : null) ??
    activeStackSection()?.section ??
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
      const nativeSnippets = await invoke<string[]>("paste_clipboard_media");
      if (nativeSnippets.length > 0) {
        for (const md of nativeSnippets) {
          insertSnippet(md, targetSection);
        }
        return;
      }
    } catch (error) {
      console.error(error);
    }
    if (allFiles.length > 0) {
      await attachFiles(allFiles, targetSection);
      return;
    }
    if (plainText.length > 0) {
      insertPlainText(plainText, targetSection);
    }
  })();
});

cardEl.addEventListener("dragover", (event) => {
  if (isDraggingMedia() || ![...(event.dataTransfer?.types ?? [])].includes("Files")) {
    return;
  }
  event.preventDefault();
  cardEl.classList.add("dropping");
});

cardEl.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && cardEl.contains(event.relatedTarget)) {
    return;
  }
  cardEl.classList.remove("dropping");
});

cardEl.addEventListener("drop", (event) => {
  if (isPreviewWindow() || isDraggingMedia()) {
    return;
  }
  const files = filesFromTransfer(event.dataTransfer);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  cardEl.classList.remove("dropping");
  const targetSection =
    (event.target instanceof Element ? event.target.closest<HTMLElement>(".stack-note") : null) ??
    activeStackSection()?.section ??
    null;
  void attachFiles(files, targetSection);
});

function closeEditorMenu() {
  editorToolsEl.classList.remove("open");
  editorMenuToggleEl.setAttribute("aria-expanded", "false");
  closeFormatPop();
}

editorMenuToggleEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

editorMenuToggleEl.addEventListener("click", () => {
  const open = !editorToolsEl.classList.contains("open");
  editorToolsEl.classList.toggle("open", open);
  editorMenuToggleEl.setAttribute("aria-expanded", String(open));
  if (!open) {
    closeFormatPop();
    colorPopEl.hidden = true;
  }
});

modeToggleEl.addEventListener("click", () => {
  togglePreview();
  closeEditorMenu();
});

coderToggleEl.addEventListener("click", () => {
  look.coder = !memoUsesCoder(look.coder);
  paintCoder();
  scheduleLook();
  closeEditorMenu();
});

markdownToggleEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

markdownToolbarEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

markdownToggleEl.addEventListener("click", () => {
  const on = markdownToggleEl.getAttribute("aria-pressed") !== "true";
  markdownToggleEl.setAttribute("aria-pressed", String(on));
  markdownToolbarEl.hidden = !on;
  closeEditorMenu();
});

markdownToolbarEl.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  const kind = button?.dataset.markdown;
  if (!kind) {
    return;
  }
  applyMarkdown(kind);
});

formatToggleEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

formatPopEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

formatToggleEl.addEventListener("click", () => {
  const open = formatPopEl.hidden;
  formatPopEl.hidden = !open;
  formatToggleEl.setAttribute("aria-expanded", String(open));
});

formatPopEl.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  const action = button?.dataset.format;
  if (!action) {
    return;
  }
  if (action === "wrap") {
    coderWrap = !coderWrap;
    paintCoder();
    closeFormatPop();
    return;
  }
  if (action === "document") {
    applyMarkdown("json");
    closeFormatPop();
    closeEditorMenu();
  }
});

document.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (!formatPopEl.hidden && !formatPopEl.contains(target) && !formatToggleEl.contains(target)) {
    closeFormatPop();
  }
  if (
    editorToolsEl.classList.contains("open") &&
    !editorToolsEl.contains(target) &&
    !editorMenuToggleEl.contains(target)
  ) {
    closeEditorMenu();
  }
});

function currentNoteId(): string | null {
  return pinnedNoteId || editingId || draftId;
}

function resetDeleteConfirm() {
  deleteNoteEl.hidden = false;
  deleteConfirmEl.hidden = true;
  deleteYesEl.textContent = "Delete";
}

function closeAudiencePop() {
  audiencePopEl.hidden = true;
  visibilityLabelEl.setAttribute("aria-expanded", "false");
  resetDeleteConfirm();
}

visibilityLabelEl.addEventListener("click", () => {
  if (audiencePopEl.hidden) {
    resetDeleteConfirm();
    audiencePopEl.hidden = false;
    visibilityLabelEl.setAttribute("aria-expanded", "true");
    revealPressedChoice(spaceChoicesEl);
    return;
  }
  closeAudiencePop();
});

deleteNoteEl.addEventListener("click", () => {
  if (!currentNoteId() && !noteContent.trim()) {
    return;
  }
  deleteNoteEl.hidden = true;
  deleteConfirmEl.hidden = false;
});

deleteNoEl.addEventListener("click", () => {
  resetDeleteConfirm();
});

deleteYesEl.addEventListener("click", () => {
  void (async () => {
    const id = currentNoteId();
    if (!id && !noteContent.trim()) {
      closeAudiencePop();
      return;
    }
    clearTimeout(draftTimer);
    deleteYesEl.textContent = "Deleting…";
    if (id && inTauri()) {
      await invoke("delete_note", { id });
    }
    closeAudiencePop();
    if (pinnedNoteId) {
      return;
    }
    editingId = null;
    draftId = null;
    showStored("");
    setPinPressed(false);
    setEditedAt(null);
    paintAudience(null);
    await refreshRecent();
  })().catch((error: unknown) => {
    deleteYesEl.textContent = "Could not delete";
    console.error(error);
  });
});

pinToggleEl.addEventListener("click", () => {
  void (async () => {
    const pressed = pinToggleEl.getAttribute("aria-pressed") === "true";
    const id = pinnedNoteId || editingId;
    if (pressed) {
      if (!id) {
        return;
      }
      await invoke("set_pinned", { id, pinned: false, fromComposer: false });
      setPinPressed(false);
      await refreshRecent();
      return;
    }
    if (!editingId && audienceDirty && draftId) {
      await saveNoteAudience(draftId);
    }
    const note = await invoke<Note>("publish_note", { id: editingId || draftId || null, content: noteContent });
    if (!editingId && audienceDirty) {
      await saveNoteAudience(note.id);
    }
    clearTimeout(lookTimer);
    lookTimer = undefined;
    lookUnsaved = false;
    await enqueueLook(note.id);
    await invoke("set_pinned", { id: note.id, pinned: true, fromComposer: !pinnedNoteId });
    if (!pinnedNoteId) {
      editingId = null;
      draftId = null;
      showStored("");
      setPinPressed(false);
      setEditedAt(null);
      paintAudience(null);
      await invoke("hide_composer");
    } else {
      setPinPressed(true);
      setEditedAt(note.updatedAt);
    }
    await refreshRecent();
  })().catch((error: unknown) => {
    console.error(error);
  });
});

themeToggleEl.addEventListener("click", (event) => {
  const alt = event.altKey || altHeld;
  const colorMode = hasStack() ? !alt : alt;
  if (colorMode) {
    colorPopEl.hidden = !colorPopEl.hidden;
    if (!colorPopEl.hidden) {
      syncSlider();
    }
    return;
  }
  colorPopEl.hidden = true;
  look.theme = currentTheme() === "dark" ? "light" : "dark";
  paintThemeIcon();
  paintLook();
  syncSlider();
  scheduleLook();
});

hueSliderEl.addEventListener("input", () => {
  setThemeHue(Number(hueSliderEl.value));
});

function saveHue() {
  const hue = Number(hueSliderEl.value);
  if (look.swatches.includes(hue) || look.swatches.length >= 6) {
    return;
  }
  look.swatches.push(hue);
  setThemeHue(hue);
}

for (const slot of hueSlots) {
  slot.addEventListener("click", () => {
    const raw = slot.dataset.hue;
    if (raw == null || raw === "") {
      return;
    }
    setThemeHue(Number(raw));
  });
}

colorPopEl.addEventListener(
  "mousedown",
  (event) => {
    const slot = hueSlots.find((item) => pointIn(item.getBoundingClientRect(), event.clientX, event.clientY));
    const overAdd = pointIn(hueAddEl.getBoundingClientRect(), event.clientX, event.clientY);
    if (!slot && !overAdd) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (slot) {
      const raw = slot.dataset.hue;
      if (raw == null || raw === "") {
        return;
      }
      setThemeHue(Number(raw));
      return;
    }
    saveHue();
  },
  true,
);

hueAddEl.addEventListener("click", () => {
  saveHue();
});

document.addEventListener("mousedown", (event) => {
  if (colorPopEl.hidden) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (colorPopEl.contains(target) || themeToggleEl.contains(target)) {
    return;
  }
  colorPopEl.hidden = true;
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
  if (audiencePopEl.hidden) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (audiencePopEl.contains(target) || visibilityLabelEl.contains(target)) {
    return;
  }
  closeAudiencePop();
});

document.addEventListener(
  "wheel",
  (event) => {
    if ((!gestureHeld && !modifierDown(binds.gesture, event)) || isPreviewWindow()) {
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
    opacityCarry = Math.min(100, Math.max(0, opacityCarry - pixels * 0.1));
    const next = Math.round(opacityCarry);
    if (next === look.opacity) {
      return;
    }
    look.opacity = next;
    paintLook();
    if (event.metaKey) {
      schedulePinnedOpacity(next);
      if (!showingPinned()) {
        scheduleLook();
      }
      return;
    }
    scheduleLook();
  },
  { passive: false, capture: true },
);

bindStack({
  cardEl,
  pinnedNoteId,
  getLook: () => look,
  getAltHeld: () => altHeld,
  getKnownSpaces: () => knownSpaces,
  getDefaultVisibility: () => defaultVisibility,
  getEditingId: () => editingId,
  currentTheme,
  previewShortcut,
  openPreview: (name) => {
    void openPreview(name);
  },
  insertSnippet,
  attachFiles,
  syncNoteTitle,
  paintThemeIcon,
});
bindMediaEditor({
  hostContainer: blocksEl,
  host: {
    getBlocks: () => noteBlocks,
    setBlocks: (blocks) => {
      noteBlocks = blocks;
    },
    pushUndo: pushHostUndo,
    afterMove: () => {
      publishBlocks();
      scheduleDraft();
    },
    afterWidth: () => {
      noteContent = serializeBlocks(noteBlocks);
      scheduleDraft();
      resizeAllBlockTextareas(blocksEl);
    },
    removeMediaAt,
  },
  forSection: mediaMutatorForSection,
  openPreview: (name) => {
    void openPreview(name);
  },
});
wireChrome();

if (!isPreviewWindow()) {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Alt") {
        if (!event.repeat) {
          altHeld = true;
          paintThemeIcon();
        }
        event.preventDefault();
      }
      if (isModifierKey(binds.gesture, event.key)) {
        if (!event.repeat) {
          gestureHeld = true;
          syncCollapsedPeek();
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
        const inTextarea = active instanceof HTMLTextAreaElement;
        const isEmptyNewMemo =
          !pinnedNoteId &&
          editingId === null &&
          noteContent.trim().length === 0 &&
          noteBlocks.length === 1 &&
          (inTextarea ? active.value.length === 0 : true);
        if (!inTextarea || isEmptyNewMemo) {
          event.preventDefault();
          event.stopPropagation();
          toggleMemoSearchByTab();
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
          !colorPopEl.hidden ||
          !audiencePopEl.hidden ||
          !formatPopEl.hidden ||
          editorToolsEl.classList.contains("open") ||
          openStackPops.length > 0 ||
          openSectionTools.length > 0)
      ) {
        closeMediaContextMenu();
        colorPopEl.hidden = true;
        closeAudiencePop();
        closeFormatPop();
        closeEditorMenu();
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
            activeStackSection()?.section ??
            null;
          if (targetSection) {
            const id = targetSection.dataset.id;
            const state = id ? stackState.get(id) : undefined;
            if (state && (isUndo ? undoSection(targetSection, state) : redoSection(targetSection, state))) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          } else if (isUndo ? undoHost() : redoHost()) {
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
          activeStackSection()?.section ??
          null;
        window.setTimeout(() => {
          if (lastPasteHandledAt >= keydownAt) {
            return;
          }
          lastPasteHandledAt = performance.now();
          void invoke<string[]>("paste_clipboard_media")
            .then((snippets) => {
              for (const md of snippets) {
                insertSnippet(md, targetSection);
              }
            })
            .catch((error: unknown) => {
              console.error(error);
            });
        }, 35);
      }
      if (matchBind(event, binds.randomHue)) {
        event.preventDefault();
        randomHue();
        return;
      }
      if (matchBind(event, binds.preview)) {
        event.preventDefault();
        togglePreview();
        return;
      }
      if (!inTauri() || !matchBind(event, binds.hide)) {
        return;
      }
      event.preventDefault();
      void invoke("hide_memos").catch((error: unknown) => {
        console.error(error);
      });
    },
    true,
  );
  window.addEventListener("keyup", (event) => {
    if (event.key === "Alt") {
      altHeld = false;
      paintThemeIcon();
    }
    if (isModifierKey(binds.gesture, event.key)) {
      gestureHeld = false;
      syncCollapsedPeek();
    }
  });
  window.addEventListener("blur", () => {
    gestureHeld = false;
    syncCollapsedPeek();
    if (!altHeld) {
      return;
    }
    altHeld = false;
    paintThemeIcon();
  });
  if (inTauri()) {
    const applyBinds = (next: ShortcutBinds) => {
      binds = next;
      const shortcut = previewShortcut();
      modeToggleEl.title = showingPreview ? `Edit (${shortcut})` : `Preview (${shortcut})`;
      stackEl?.querySelectorAll<HTMLButtonElement>(".stack-note .mode-toggle").forEach((btn) => {
        const open = btn.getAttribute("aria-pressed") === "true";
        btn.title = open ? `Edit (${shortcut})` : `Preview (${shortcut})`;
      });
    };
    void invoke<ShortcutBinds>("get_shortcuts")
      .then(applyBinds)
      .catch((error: unknown) => {
        console.error(error);
      });
    void listen<ShortcutBinds>("shortcuts-changed", (event) => {
      applyBinds(event.payload);
    });
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
        const matched = [binds.newMemo, binds.togglePinned, binds.preview, binds.hide, binds.randomHue].some((binding) =>
          matchMouse(chord, binding),
        );
        if (!matched) {
          return;
        }
        event.preventDefault();
        void invoke("mouse_chord", {
          button,
          alt: event.altKey,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        }).catch((error: unknown) => {
          console.error(error);
        });
      },
      true,
    );
    void listen<{ button: number; alt: boolean; ctrl: boolean; shift: boolean; meta: boolean }>("mouse-chord", (event) => {
      if (!document.hasFocus()) {
        return;
      }
      const chord = {
        button: event.payload.button - 1,
        altKey: event.payload.alt,
        ctrlKey: event.payload.ctrl,
        shiftKey: event.payload.shift,
        metaKey: event.payload.meta,
      };
      if (matchMouse(chord, binds.randomHue)) {
        randomHue();
        return;
      }
      if (matchMouse(chord, binds.preview)) {
        togglePreview();
        return;
      }
      if (matchMouse(chord, binds.hide)) {
        void invoke("hide_memos").catch((error: unknown) => {
          console.error(error);
        });
      }
    });
  }
}

if (pinnedThemeHint) {
  look.theme = pinnedThemeHint;
  paintLook();
}

renderSurface();

let pinLoad = 0;

function applyPinned(note: Note) {
  const dirty = loadedContent.length > 0 && noteContent !== loadedContent;
  if (!dirty && (editingId !== note.id || loadedContent !== note.content)) {
    editingId = note.id;
    showStored(note.content);
    loadedContent = note.content;
  }
  setConflict(note.syncState === "conflict" ? note.id : null);
  setPinPressed(note.pinned);
  setEditedAt(note.updatedAt);
  setHostCollapsedFlag(Boolean(note.collapsed));
  paintAudience(note);
  if (lookTimer === undefined) {
    adoptLook(lookFromNote(note));
  }
}

async function loadPinned(id: string) {
  if (id !== pinnedNoteId) {
    return;
  }
  const ticket = ++pinLoad;
  const stored = await invoke<Note>("get_note", { id: pinnedNoteId, materialize: false });
  if (ticket !== pinLoad || stored.id !== pinnedNoteId) {
    return;
  }
  applyPinned(stored);
  await loadStack();
  paintChrome();
  await loadTheme();
  if (stored.syncState !== "remote") {
    return;
  }
  const note = await invoke<Note>("get_note", { id: pinnedNoteId });
  if (ticket !== pinLoad || note.id !== pinnedNoteId) {
    return;
  }
  applyPinned(note);
  paintChrome();
}

conflictLocalEl.addEventListener("click", () => {
  if (!conflictId) {
    return;
  }
  void resolveConflict(conflictId, "local");
});

conflictRemoteEl.addEventListener("click", () => {
  if (!conflictId) {
    return;
  }
  void resolveConflict(conflictId, "remote");
});

async function resolveConflict(id: string, choice: "local" | "remote") {
  try {
    const note = await invoke<Note>("resolve_conflict", { id, choice });
    if (editingId === note.id || pinnedNoteId === note.id) {
      editingId = note.id;
      showStored(note.content);
      setConflict(null);
      setPinPressed(note.pinned);
      setEditedAt(note.updatedAt);
    }
    await refreshRecent();
  } catch (error) {
    console.error(error);
  }
}

if (inTauri() && !isPreviewWindow()) {
  const applyEditorPrefs = (settings: EditorPrefs) => {
    setEditorPrefs({
      coderEditor: Boolean(settings.coderEditor),
      markdownHighlight: settings.markdownHighlight !== false,
      markdownScheme: settings.markdownScheme,
    });
    paintCoder();
  };
  window.addEventListener("resize", () => {
    refreshEditorFields();
  });
  void invoke<EditorPrefs>("get_settings")
    .then(applyEditorPrefs)
    .catch((error: unknown) => {
      console.error(error);
    });
  void listen<EditorPrefs>("editor-prefs-changed", (event) => {
    applyEditorPrefs(event.payload);
  });
}

if (inTauri() && !isPreviewWindow()) {
  void listen<number>("pinned-opacity", (event) => {
    if (pinnedOpacityTimer !== undefined || !showingPinned()) {
      return;
    }
    const next = Math.min(100, Math.max(0, Math.round(event.payload)));
    if (next === look.opacity) {
      return;
    }
    look.opacity = next;
    opacityCarry = next;
    paintLook();
  });
}

if (isPreviewWindow()) {
  void initLightbox(lightboxEl, lightboxImageEl).catch((error: unknown) => {
    console.error(error);
  });
} else if (pinnedNoteId && inTauri()) {
  void loadAudience().catch((error: unknown) => {
    console.error(error);
  });
  void listen("settings-changed", () => {
    void loadAudience().catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen("spaces-changed", () => {
    void loadAudience().catch((error: unknown) => {
      console.error(error);
    });
  });
  void loadPinned(pinnedNoteId).catch((error: unknown) => {
    console.error(error);
  });
  void getCurrentWindow().listen<string>("show-pin", (event) => {
    if (event.payload !== pinnedNoteId) {
      return;
    }
    void loadPinned(pinnedNoteId).catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen("notes-changed", () => {
    void loadPinned(pinnedNoteId).catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen("stack-changed", () => {
    void loadStack().catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen<string>("stack-aim", (event) => {
    const notes = document.getElementById("notes");
    const mode = event.payload;
    notes?.classList.toggle("stack-aim", mode === "hold" || mode === "ready");
    notes?.classList.toggle("stack-ready", mode === "ready");
  });
} else if (inTauri()) {
  void listen<number>("composer-focus", (event) => {
    void focusComposer(event.payload);
  });

  void listen("notes-changed", () => {
    scheduleRecent();
  });

  void listen("settings-changed", () => {
    void loadAudience().catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen("spaces-changed", () => {
    void loadAudience().catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen<number>("composer-fresh", (event) => {
    void startFresh(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen<number>("composer-cycle", (event) => {
    void cycleComposer(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen<number>("composer-flush", (event) => {
    clearTimeout(draftTimer);
    const generation = event.payload;
    const content = noteContent;
    const noteId = editingId;
    recentExpanded = false;
    listHidden = false;
    if (generation === openGen) {
      showStored("");
      editingId = null;
      draftId = null;
      setPinPressed(false);
      setEditedAt(null);
      paintAudience(null);
    }
    void invoke("finalize_composer", { generation, content, noteId })
      .then(() => refreshRecent())
      .catch((error: unknown) => {
        console.error(error);
      });
  });

  void loadTheme().catch((error: unknown) => {
    console.error(error);
  });
  void loadAudience().catch((error: unknown) => {
    console.error(error);
  });
}
