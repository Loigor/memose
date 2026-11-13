import DOMPurify from "dompurify";
import { marked } from "marked";

import { activeField, fieldAt, fieldsIn, isEditable, type Editable } from "../../editor/editable";
import {
  applyMediaFigureSize,
  focusLiftedCode,
  handleBlockAreaNavigation,
  handleBlockMediaDeletion,
  syncInlineLineSlot,
} from "../../editor/editor-blocks";
import {
  codeSurface,
  denseLines,
  readFolds,
  readLineMarks,
  refreshEditorFields,
  setEditorPrefs,
  wrapEditorField,
  writeFolds,
  writeLineMarks,
  type EditorPrefs,
} from "../../editor/editor-field";
import {
  cloneBlocks,
  readPlace,
  remapBlockLines,
  restoreCaret,
  restorePlace,
} from "../../editor/history";
import { lineOffsetAtPoint, mountLineEditor } from "../../editor/line-editor";
import {
  applyCode,
  applyJsonFormat,
  applyList,
  applyOrdered,
  applyQuote,
  applyTask,
  applyTitle,
  closedFenceIn,
  completeOpenFence,
  dropCodeBlock,
  ensureTextSlots,
  indentCode,
  isTypedBlock,
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
} from "../../editor/markdown-edit";
import {
  charOffsetAtPoint,
  editorShell,
  resizeAllBlockTextareas,
  sizeBlockTextarea,
} from "../../editor/textarea";
import { createMedia } from "../../media/media-dnd";
import { hydratePreviewContent, previewBodyTarget } from "../../media/media-elements";
import { inTauri } from "../../platform";
import type { AppContext } from "../context";
import type { EditorState } from "../state";
import type { EditorView, LookEditor } from "./look-controller";

const maxMediaBytes = 32 * 1024 * 1024;

export interface EditorSession {
  currentNoteId(): string | null;
  placeKey(): string;
  isNewMemo(): boolean;
}

export interface EditorDraftScheduling {
  scheduleDraft(): void;
}

export interface EditorRecent {
  dismissRecent(): void;
}

export interface EditorLook {
  usesCoder(): boolean;
}

export interface EditorInput {
  gestureActive(event: MouseEvent): boolean;
  previewShortcut(): string;
}

export interface EditorStack {
  activeSection(): HTMLElement | null;
  resumeActiveEditor(): boolean;
  toggleActivePreview(): boolean;
  insertMedia(section: HTMLElement, name: string, label?: string): void;
  applyEditorChrome(): void;
}

export interface EditorMediaHost {
  getBlocks(): Block[];
  setBlocks(blocks: Block[]): void;
  pushUndo(force?: boolean): void;
  afterMove(): void;
  afterWidth(): void;
  removeMediaAt(index: number, name: string): void;
}

export interface EditorController extends LookEditor {
  content(): string;
  isEmpty(): boolean;
  isEmptyNewMemo(): boolean;
  showStored(content: string): void;
  renderSurface(focusName?: string): void;
  focus(): void;
  focusEditing(): void;
  rememberPlace(): void;
  resumePlace(): void;
  togglePreview(): void;
  undo(): boolean;
  redo(): boolean;
  insertSnippet(snippet: string, targetSection?: HTMLElement | null): void;
  insertPlainText(text: string): void;
  attachFiles(files: File[], targetSection?: HTMLElement | null): Promise<void>;
  openPreview(name: string): Promise<void>;
  syncTitle(): void;
  scheduleView(): void;
  flushView(): Promise<void>;
  saveView(id: string): Promise<void>;
  viewUnsaved(): boolean;
  resetView(): void;
  applyPrefs(settings: EditorPrefs): boolean;
  resize(): void;
  refreshPreviewShortcut(): void;
  closeFormatMenu(): void;
  mediaHost: EditorMediaHost;
  offsetInField(field: Editable, x: number, y: number): number | null;
}

export function createEditorController(
  context: AppContext,
  state: EditorState,
  session: EditorSession,
  drafts: EditorDraftScheduling,
  recent: EditorRecent,
  look: EditorLook,
  input: EditorInput,
  stack: EditorStack,
): EditorController {
  const {
    card,
    blocks: blocksEl,
    preview: previewEl,
    markdownToggle,
    markdownToolbar,
    editorMenuToggle,
    editorTools,
    coderToggle,
    formatToggle,
    formatPop,
    modeToggle,
    colorPop,
  } = context.dom;

  marked.setOptions({ gfm: true, breaks: true });

  function rememberPlace() {
    const place = readPlace(blocksEl, state.caret);
    if (!place) {
      return;
    }
    state.caret = { ...place.caret };
    state.places.set(session.placeKey(), place);
  }

  function isEmptyNewMemo() {
    return session.isNewMemo() && state.content.trim().length === 0 && state.blocks.length === 1;
  }

  function resumePlace() {
    if (stack.resumeActiveEditor()) {
      return;
    }
    const focused = typeof document === "undefined" ? true : document.hasFocus();
    if (restorePlace(blocksEl, state.places.get(session.placeKey()) ?? null, focused)) {
      return;
    }
    if (focused) {
      focus();
    }
  }

  function pushUndo(force = true) {
    if (!state.history.shouldCapture(force)) {
      return;
    }
    state.history.push(
      state.blocks,
      state.caret,
      force,
      readLineMarks(blocksEl, state.marks),
      readFolds(blocksEl, state.folds),
    );
  }

  function resetHistory() {
    state.history.reset();
  }

  function restoreView(folds: number[][], marks: number[][]) {
    state.folds = folds ?? [];
    state.marks = marks ?? [];
    writeFolds(blocksEl, state.folds);
    writeLineMarks(blocksEl, state.marks);
  }

  function undo(): boolean {
    const entry = state.history.takeUndo(
      state.blocks,
      state.caret,
      readLineMarks(blocksEl, state.marks),
      readFolds(blocksEl, state.folds),
    );
    if (!entry) {
      return false;
    }
    state.blocks = cloneBlocks(entry.blocks);
    state.caret = entry.caret ? { ...entry.caret } : null;
    publishBlocks();
    restoreView(entry.folds, entry.marks);
    drafts.scheduleDraft();
    restoreCaret(blocksEl, state.caret);
    return true;
  }

  function redo(): boolean {
    const entry = state.history.takeRedo(
      state.blocks,
      state.caret,
      readLineMarks(blocksEl, state.marks),
      readFolds(blocksEl, state.folds),
    );
    if (!entry) {
      return false;
    }
    state.blocks = cloneBlocks(entry.blocks);
    state.caret = entry.caret ? { ...entry.caret } : null;
    publishBlocks();
    restoreView(entry.folds, entry.marks);
    drafts.scheduleDraft();
    restoreCaret(blocksEl, state.caret);
    return true;
  }

  function publishBlocks(focusName?: string) {
    state.blocks = ensureTextSlots(state.blocks);
    state.content = serializeBlocks(state.blocks);
    syncTitle();
    renderSurface(focusName);
  }

  function showStored(content: string) {
    state.skipCapture = true;
    state.showingPreview = false;
    state.content = content;
    state.blocks = parseBlocks(content);
    resetHistory();
    syncTitle();
    renderSurface();
  }

  function focus() {
    const fields = fieldsIn(blocksEl);
    const field = fields[fields.length - 1];
    if (!field) {
      return;
    }
    field.focus();
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? start;
    field.setSelectionRange(start, end);
  }

  function focusEditing() {
    if (state.showingPreview) {
      return;
    }
    if (!restorePlace(blocksEl, state.places.get(session.placeKey()) ?? null, true)) {
      focus();
    }
  }

  function refreshPreviewShortcut() {
    const shortcut = input.previewShortcut();
    modeToggle.title = state.showingPreview ? `Edit (${shortcut})` : `Preview (${shortcut})`;
  }

  function renderSurface(focusName?: string) {
    const shortcut = input.previewShortcut();
    modeToggle.setAttribute("aria-pressed", String(state.showingPreview));
    if (state.showingPreview) {
      blocksEl.hidden = true;
      previewEl.hidden = false;
      modeToggle.setAttribute("aria-label", "Edit");
      modeToggle.title = `Edit (${shortcut})`;
      void paintPreview();
      return;
    }
    previewEl.hidden = true;
    blocksEl.hidden = false;
    modeToggle.setAttribute("aria-label", "Preview");
    modeToggle.title = `Preview (${shortcut})`;
    renderBlocks(focusName);
  }

  async function paintPreview() {
    const generation = ++state.previewGeneration;
    const parsed = marked.parse(state.content, { async: false });
    const html = typeof parsed === "string" ? parsed : await parsed;
    if (generation !== state.previewGeneration) {
      return;
    }
    previewEl.innerHTML = DOMPurify.sanitize(html);
    await hydratePreviewContent(previewEl, () => generation === state.previewGeneration, (name) => {
      void openPreview(name);
    });
  }

  function togglePreview() {
    if (stack.toggleActivePreview()) {
      return;
    }
    state.showingPreview = !state.showingPreview;
    renderSurface();
    if (!state.showingPreview) {
      resumePlace();
    }
  }

  function renderBlocks(focusName?: string) {
    const captureView = !state.skipCapture;
    if (captureView && blocksEl.querySelector("textarea")) {
      state.folds = readFolds(blocksEl, state.folds);
      state.marks = readLineMarks(blocksEl, state.marks);
    }
    if (captureView && state.viewBlocks.length > 0) {
      state.folds = remapBlockLines(state.viewBlocks, state.blocks, state.folds);
      state.marks = remapBlockLines(state.viewBlocks, state.blocks, state.marks);
    }
    state.skipCapture = false;
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
    state.blocks.forEach((block, index) => {
      if (isTypedBlock(block)) {
        lastText = index;
      }
    });
    let currentRow: HTMLElement | null = null;
    let currentRowSideArea: HTMLElement | null = null;

    state.blocks.forEach((block, index) => {
      if (isTypedBlock(block)) {
        const prevBlock = state.blocks[index - 1];
        const isAfterMedia = prevBlock?.kind === "media";
        const canSitOnMediaLine =
          block.kind === "text" &&
          isAfterMedia &&
          currentRow !== null &&
          currentRowSideArea === null &&
          !block.text.includes("\n");
        if (block.kind === "text" && !look.usesCoder()) {
          const assignedRow = canSitOnMediaLine ? currentRow : null;
          let field: Editable | null = null;
          const mounted = mountLineEditor({
            text: block.text,
            index,
            placeholder: state.blocks.length === 1 ? "Write a note…" : "",
            grow: index === lastText && !canSitOnMediaLine,
            inline: canSitOnMediaLine,
            empty: false,
            container: blocksEl,
            blocks: () => state.blocks,
            undo: pushUndo,
            change: (value, place) => {
              if (!field) {
                return;
              }
              block.text = value;
              syncInlineLineSlot(field, prevBlock, assignedRow, blocksEl, index === lastText);
              state.content = serializeBlocks(state.blocks);
              state.caret = { index, start: place.start, end: place.end };
              rememberPlace();
              followEnd(field);
              recent.dismissRecent();
              syncTitle();
              drafts.scheduleDraft();
            },
            reparse: (value) => {
              block.text = value;
              state.content = serializeBlocks(state.blocks);
              const fromIndex = index;
              state.blocks = parseBlocks(state.content);
              renderBlocks();
              focusLiftedCode(blocksEl, state.blocks, fromIndex, (next) => {
                state.caret = next;
                rememberPlace();
              });
              syncTitle();
              drafts.scheduleDraft();
            },
            apply: (edit) => {
              if (field) {
                applyEdit(field, edit);
              }
            },
            removeMedia: (mediaIndex, focusIdx, caretPos) => {
              pushUndo(true);
              state.blocks.splice(mediaIndex, 1);
              publishBlocks();
              drafts.scheduleDraft();
              const target = fieldAt(blocksEl, focusIdx);
              if (target) {
                target.focus();
                const clamped = Math.min(caretPos, target.value.length);
                target.setSelectionRange(clamped, clamped);
              }
            },
            splitInline: (before, after) => {
              pushUndo(true);
              if (prevBlock?.kind === "media") {
                prevBlock.inline = before.length > 0;
              }
              state.blocks.splice(index, 1, { kind: "text", text: before }, { kind: "text", text: `\n${after}` });
              publishBlocks();
              drafts.scheduleDraft();
              const target = fieldAt(blocksEl, index);
              if (target) {
                target.focus();
                const pos = Math.min(before.length + 1, target.value.length);
                target.setSelectionRange(pos, pos);
              }
            },
            releaseInline: () => {
              if (!field) {
                return;
              }
              if (prevBlock?.kind === "media") {
                prevBlock.inline = false;
              }
              field.classList.remove("inline-line-slot");
              if (index === lastText) {
                field.classList.add("grow");
              }
              const host = editorShell(field);
              if (assignedRow && host.parentElement === assignedRow) {
                assignedRow.after(host);
              } else {
                blocksEl.append(host);
              }
              field.focus();
            },
            allowTab: () => !isEmptyNewMemo(),
            onCaret: () => {
              if (!field) {
                return;
              }
              state.caret = {
                index,
                start: field.selectionStart ?? field.value.length,
                end: field.selectionEnd ?? field.value.length,
              };
              rememberPlace();
            },
          });
          field = mounted.field;
          if (canSitOnMediaLine && currentRow) {
            currentRow.append(mounted.shell);
            currentRowSideArea = field;
          } else {
            currentRow = null;
            currentRowSideArea = null;
            blocksEl.append(mounted.shell);
          }
          return;
        }
        const area = document.createElement("textarea");
        area.rows = 1;
        area.spellcheck = false;
        area.autocomplete = "off";
        area.autocapitalize = "off";
        area.setAttribute("autocorrect", "off");
        area.setAttribute("writingsuggestions", "false");
        area.dataset.index = String(index);
        area.dataset.kind = block.kind;
        if (block.kind === "code" && block.lang) {
          area.dataset.lang = block.lang;
        }
        area.value = block.text;
        if (state.blocks.length === 1 && block.kind === "text") {
          area.placeholder = "Write a note…";
        } else if (canSitOnMediaLine) {
          area.classList.add("inline-line-slot");
        }
        if (index === lastText && !area.classList.contains("inline-line-slot")) {
          area.classList.add("grow");
        }
        const assignedRow = canSitOnMediaLine ? currentRow : null;
        const remember = () => {
          state.caret = { index, start: area.selectionStart, end: area.selectionEnd };
          rememberPlace();
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
        area.addEventListener("scroll", rememberPlace);
        area.addEventListener("keydown", (event) => {
          if (
            block.kind === "code" &&
            event.key === "Backspace" &&
            !event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing &&
            area.value.length === 0 &&
            (area.selectionStart ?? 0) === (area.selectionEnd ?? 0)
          ) {
            event.preventDefault();
            pushUndo(true);
            const dropped = dropCodeBlock(state.blocks, index);
            state.blocks = dropped.blocks;
            publishBlocks();
            drafts.scheduleDraft();
            const target = fieldAt(blocksEl, dropped.index);
            if (target) {
              target.focus();
              const clamped = Math.min(dropped.offset, target.value.length);
              target.setSelectionRange(clamped, clamped);
              state.caret = { index: dropped.index, start: clamped, end: clamped };
              rememberPlace();
            }
            return;
          }
          if (
            handleBlockMediaDeletion(
              blocksEl,
              area,
              event,
              () => state.blocks,
              (mediaIndex, focusIdx, caretPos) => {
                pushUndo(true);
                state.blocks.splice(mediaIndex, 1);
                publishBlocks();
                drafts.scheduleDraft();
                const target = fieldAt(blocksEl, focusIdx);
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
            pushUndo(true);
            const { start, end } = areaSelection(area);
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
            publishBlocks();
            drafts.scheduleDraft();
            const target = fieldAt(blocksEl, index);
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
            !event.isComposing &&
            codeSurface(area)
          ) {
            event.preventDefault();
            applyEdit(area, indentCode(area.value, area.selectionStart ?? 0, area.selectionEnd ?? 0, event.shiftKey));
            return;
          }
          if (
            event.key === "Tab" &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.isComposing &&
            !isEmptyNewMemo()
          ) {
            event.preventDefault();
            applyEdit(area, tabOnMarkdown(area.value, area.selectionStart, area.selectionEnd, event.shiftKey));
            return;
          }
          if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
            return;
          }
          if (block.kind === "code") {
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
          pushUndo(false);
        });
        area.addEventListener("input", (event) => {
          block.text = area.value;
          syncInlineLineSlot(area, prevBlock, assignedRow, blocksEl, index === lastText);
          state.content = serializeBlocks(state.blocks);
          if (
            block.kind === "text" &&
            event instanceof InputEvent &&
            (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph")
          ) {
            const closed = completeOpenFence(area.value, area.selectionStart);
            if (closed) {
              area.value = closed.value;
              block.text = closed.value;
              state.content = serializeBlocks(state.blocks);
            }
          }
          if (block.kind === "text" && (mediaTokenRegex.test(area.value) || closedFenceIn(area.value))) {
            const fromIndex = index;
            state.blocks = parseBlocks(state.content);
            renderBlocks();
            focusLiftedCode(blocksEl, state.blocks, fromIndex, (next) => {
              state.caret = next;
              rememberPlace();
            });
            syncTitle();
            drafts.scheduleDraft();
            return;
          }
          sizeBlockTextarea(area);
          remember();
          followEnd(area);
          recent.dismissRecent();
          syncTitle();
          drafts.scheduleDraft();
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
    if (blocksEl.querySelector("textarea")) {
      writeFolds(blocksEl, state.folds);
      writeLineMarks(blocksEl, state.marks);
    }
    state.viewBlocks = cloneBlocks(state.blocks);
    if (!focusName) {
      return;
    }
    const media = blocksEl.querySelector(`[data-media="${CSS.escape(focusName)}"]`);
    const row = media?.parentElement;
    const next = row?.querySelector("[data-block-field]") ?? row?.nextElementSibling?.querySelector("[data-block-field]");
    if (isEditable(next)) {
      next.focus();
    }
  }

  function removeMediaAt(index: number, name: string) {
    const from =
      state.blocks[index]?.kind === "media"
        ? index
        : state.blocks.findIndex((block) => block.kind === "media" && block.name === name);
    if (from < 0) {
      return;
    }
    pushUndo(true);
    state.blocks.splice(from, 1);
    publishBlocks();
    syncTitle();
    drafts.scheduleDraft();
  }

  function insertMedia(name: string, label?: string) {
    pushUndo(true);
    const area = activeField(blocksEl) ?? targetArea();
    const index = area ? Number(area.dataset.index) : state.blocks.length - 1;
    const block = state.blocks[index];
    if (!block || block.kind !== "text") {
      state.blocks.push({ kind: "media", name, label });
    } else {
      const { start, end } = area ? areaSelection(area) : { start: block.text.length, end: block.text.length };
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
    publishBlocks(name);
    syncTitle();
    drafts.scheduleDraft();
  }

  function openPreview(name: string) {
    return context.backend.openMediaPreview(name);
  }

  function applyEdit(area: Editable, edit: Edit) {
    const index = Number(area.dataset.index);
    const block = state.blocks[index];
    if (!block || !isTypedBlock(block)) {
      return;
    }
    pushUndo(true);
    area.value = edit.value;
    block.text = edit.value;
    state.content = serializeBlocks(state.blocks);
    if (block.kind === "text" && (mediaTokenRegex.test(area.value) || closedFenceIn(area.value))) {
      const fromIndex = index;
      state.blocks = parseBlocks(state.content);
      renderBlocks();
      focusLiftedCode(blocksEl, state.blocks, fromIndex, (next) => {
        state.caret = next;
        rememberPlace();
      });
      syncTitle();
      drafts.scheduleDraft();
      return;
    }
    if (area instanceof HTMLTextAreaElement) {
      sizeBlockTextarea(area);
    }
    const start = Math.min(edit.start, edit.value.length);
    const end = Math.min(edit.end, edit.value.length);
    area.focus();
    area.setSelectionRange(start, end);
    state.caret = { index, start, end };
    followEnd(area);
    recent.dismissRecent();
    syncTitle();
    drafts.scheduleDraft();
  }

  function followEnd(area: Editable) {
    if ((area.selectionStart ?? 0) !== area.value.length || (area.selectionEnd ?? 0) !== area.value.length) {
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

  function areaSelection(area: Editable): { start: number; end: number } {
    const active = document.activeElement;
    if (active instanceof Node && (active === area || area.contains(active))) {
      return { start: area.selectionStart ?? area.value.length, end: area.selectionEnd ?? area.value.length };
    }
    if (state.caret && Number(area.dataset.index) === state.caret.index) {
      return {
        start: Math.min(state.caret.start, area.value.length),
        end: Math.min(state.caret.end, area.value.length),
      };
    }
    return { start: area.value.length, end: area.value.length };
  }

  function targetArea(): Editable | null {
    const active = activeField(blocksEl);
    if (active) {
      return active;
    }
    if (state.caret) {
      const found = fieldAt(blocksEl, state.caret.index);
      if (found) {
        return found;
      }
    }
    const fields = fieldsIn(blocksEl);
    return fields[fields.length - 1] ?? null;
  }

  function applyMarkdown(kind: string) {
    if (state.showingPreview) {
      state.showingPreview = false;
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
            : kind === "list"
              ? applyList(value, start, end)
              : kind === "ordered"
                ? applyOrdered(value, start, end)
                : kind === "task"
                  ? applyTask(value, start, end)
                  : kind === "quote"
                    ? applyQuote(value, start, end)
                    : kind === "code"
                      ? applyCode(value, start, end)
                      : kind === "json"
                        ? applyJsonFormat(value)
                        : null;
    if (edit) {
      applyEdit(area, edit);
    }
  }

  function closeFormatMenu() {
    formatPop.hidden = true;
    formatToggle.setAttribute("aria-expanded", "false");
  }

  function closeMenu() {
    editorTools.classList.remove("open");
    editorMenuToggle.setAttribute("aria-expanded", "false");
    closeFormatMenu();
  }

  function insertSnippet(snippet: string, targetSection?: HTMLElement | null) {
    const match = snippet.trim().match(mediaTokenRegex);
    if (!match?.[3]) {
      return;
    }
    const section = targetSection !== undefined ? targetSection : stack.activeSection();
    if (section) {
      stack.insertMedia(section, match[3], match[2] || undefined);
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
        const markdown = await context.backend.saveMedia(bytes, file.name || null, file.type || null);
        insertSnippet(markdown, targetSection);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function insertPlainText(text: string) {
    const area = targetArea();
    if (!area) {
      return;
    }
    const { start, end } = areaSelection(area);
    const value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
    const cursor = start + text.length;
    applyEdit(area, { value, start: cursor, end: cursor });
  }

  function syncTitle() {
    const title = document.querySelector("#note-title");
    if (title) {
      title.textContent = noteTitle(state.content) || "Note";
    }
  }

  function scheduleView() {
    state.viewUnsaved = true;
    if (!inTauri() || !session.currentNoteId()) {
      return;
    }
    clearTimeout(state.viewTimer);
    state.viewTimer = setTimeout(() => {
      state.viewTimer = undefined;
      void flushView();
    }, 300);
  }

  async function flushView() {
    clearTimeout(state.viewTimer);
    state.viewTimer = undefined;
    const id = session.currentNoteId();
    if (!id || !inTauri()) {
      state.viewUnsaved = false;
      return;
    }
    await saveView(id);
  }

  async function saveView(id: string) {
    if (!inTauri()) {
      return;
    }
    clearTimeout(state.viewTimer);
    state.viewTimer = undefined;
    if (blocksEl.querySelector("textarea")) {
      state.folds = readFolds(blocksEl, state.folds);
      state.marks = readLineMarks(blocksEl, state.marks);
    }
    const lineWrap = state.coderWrap;
    const folds = denseLines(state.folds);
    const marks = denseLines(state.marks);
    state.viewUnsaved = false;
    state.viewWrite = state.viewWrite
      .then(() => context.backend.saveEditorView(id, lineWrap, folds, marks))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(error);
      });
    await state.viewWrite;
  }

  function adoptView(view: EditorView, restore: boolean) {
    state.coderWrap = view.lineWrap === true;
    state.folds = denseLines(view.folds);
    state.marks = denseLines(view.marks);
    if (restore) {
      writeFolds(blocksEl, state.folds);
      writeLineMarks(blocksEl, state.marks);
    }
  }

  function paintCoder(on: boolean) {
    card.toggleAttribute("data-coder", on);
    card.toggleAttribute("data-wrap", on && state.coderWrap);
    coderToggle.setAttribute("aria-pressed", String(on));
    formatPop.querySelector("[data-format='wrap']")?.setAttribute("aria-pressed", String(state.coderWrap));
    if (!on) {
      closeFormatMenu();
    }
    stack.applyEditorChrome();
    refreshEditorFields();
    resizeAllBlockTextareas(card);
  }

  function resetView() {
    state.coderWrap = false;
    state.folds = [];
    state.marks = [];
    state.viewUnsaved = false;
  }

  function applyPrefs(settings: EditorPrefs): boolean {
    const before = look.usesCoder();
    setEditorPrefs({
      coderEditor: Boolean(settings.coderEditor),
      markdownHighlight: settings.markdownHighlight !== false,
      markdownScheme: settings.markdownScheme,
      indentWidth: settings.indentWidth,
    });
    const after = look.usesCoder();
    paintCoder(after);
    if (before !== after && !state.showingPreview) {
      renderBlocks();
    }
    return before !== after;
  }

  function resize() {
    refreshEditorFields();
  }

  function offsetInField(field: Editable, x: number, y: number): number | null {
    return field instanceof HTMLTextAreaElement
      ? charOffsetAtPoint(field, x, y)
      : lineOffsetAtPoint(field, x, y);
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
    const next = toggleTask(state.content, index, target.checked);
    if (next == null || next === state.content) {
      if (next == null) {
        target.checked = !target.checked;
      }
      return;
    }
    pushUndo(true);
    state.content = next;
    state.blocks = parseBlocks(next);
    drafts.scheduleDraft();
  });

  card.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0 || input.gestureActive(event) || !previewBodyTarget(event.target)) {
        state.previewClick = null;
        return;
      }
      const now = event.timeStamp;
      const previous = state.previewClick;
      if (
        state.showingPreview &&
        previous &&
        now - previous.at < 600 &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 8
      ) {
        state.previewClick = null;
        event.preventDefault();
        event.stopPropagation();
        togglePreview();
        return;
      }
      state.previewClick = { at: now, x: event.clientX, y: event.clientY };
    },
    true,
  );

  blocksEl.addEventListener("memose-undo", () => {
    pushUndo(true);
  });
  blocksEl.addEventListener("memose-editor-view", () => {
    state.folds = readFolds(blocksEl, state.folds);
    state.marks = readLineMarks(blocksEl, state.marks);
    scheduleView();
  });
  blocksEl.addEventListener("scroll", rememberPlace);

  editorMenuToggle.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  editorMenuToggle.addEventListener("click", () => {
    const open = !editorTools.classList.contains("open");
    editorTools.classList.toggle("open", open);
    editorMenuToggle.setAttribute("aria-expanded", String(open));
    if (!open) {
      closeFormatMenu();
      colorPop.hidden = true;
    }
  });
  modeToggle.addEventListener("click", () => {
    togglePreview();
    closeMenu();
  });
  markdownToggle.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  markdownToolbar.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  markdownToggle.addEventListener("click", () => {
    const on = markdownToggle.getAttribute("aria-pressed") !== "true";
    markdownToggle.setAttribute("aria-pressed", String(on));
    markdownToolbar.hidden = !on;
    closeMenu();
  });
  markdownToolbar.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const kind = button?.dataset.markdown;
    if (kind) {
      applyMarkdown(kind);
    }
  });
  formatToggle.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  formatPop.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  formatToggle.addEventListener("click", () => {
    const open = formatPop.hidden;
    formatPop.hidden = !open;
    formatToggle.setAttribute("aria-expanded", String(open));
  });
  formatPop.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const action = button?.dataset.format;
    if (!action) {
      return;
    }
    if (action === "wrap") {
      state.coderWrap = !state.coderWrap;
      paintCoder(look.usesCoder());
      scheduleView();
      closeFormatMenu();
      return;
    }
    if (action === "document") {
      applyMarkdown("json");
      closeFormatMenu();
      closeMenu();
    }
  });
  document.addEventListener("mousedown", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (!formatPop.hidden && !formatPop.contains(target) && !formatToggle.contains(target)) {
      closeFormatMenu();
    }
    if (editorTools.classList.contains("open") && !editorTools.contains(target) && !editorMenuToggle.contains(target)) {
      closeMenu();
    }
  });

  const mediaHost: EditorMediaHost = {
    getBlocks: () => state.blocks,
    setBlocks(blocks) {
      state.blocks = blocks;
    },
    pushUndo,
    afterMove() {
      publishBlocks();
      drafts.scheduleDraft();
    },
    afterWidth() {
      state.content = serializeBlocks(state.blocks);
      drafts.scheduleDraft();
      resizeAllBlockTextareas(blocksEl);
    },
    removeMediaAt,
  };

  return {
    content: () => state.content,
    isEmpty: () => state.content.trim().length === 0,
    isEmptyNewMemo,
    showStored,
    renderSurface,
    focus,
    focusEditing,
    rememberPlace,
    resumePlace,
    togglePreview,
    undo,
    redo,
    insertSnippet,
    insertPlainText,
    attachFiles,
    openPreview,
    syncTitle,
    scheduleView,
    flushView,
    saveView,
    viewUnsaved: () => state.viewUnsaved,
    resetView,
    applyPrefs,
    resize,
    refreshPreviewShortcut,
    adoptView,
    paintCoder,
    renderAfterCoderChange: renderBlocks,
    isPreviewing: () => state.showingPreview,
    closeMenu,
    closeFormatMenu,
    mediaHost,
    offsetInField,
  };
}
