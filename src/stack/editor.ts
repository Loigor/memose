import { activeField, type Editable, fieldAt, fieldsIn } from "../editor/editable";
import { applyMediaFigureSize, focusLiftedCode, handleBlockAreaNavigation, handleBlockMediaDeletion, syncInlineLineSlot } from "../editor/editor-blocks";
import { codeSurface, denseLines, memoUsesCoder, readFolds, readLineMarks, wrapEditorField, writeFolds, writeLineMarks } from "../editor/editor-field";
import { cloneBlocks, remapBlockLines, restoreCaret } from "../editor/history";
import { mountLineEditor } from "../editor/line-editor";
import { type Block, closedFenceIn, completeOpenFence, dropCodeBlock, type Edit, ensureTextSlots, indentCode, isTypedBlock, mediaTokenRegex, noteTitle, parseBlocks, serializeBlocks, tabOnMarkdown, taskListOnEnter } from "../editor/markdown-edit";
import { editorShell, resizeAllBlockTextareas, sizeBlockTextarea } from "../editor/textarea";
import { createMedia, type MediaNoteMutator } from "../media/media-dnd";
import { hydratePreviewContent } from "../media/media-elements";
import { exactStamp, relativeTime } from "../time";
import type { SectionState, StackCtx } from "./context";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { marked } from "marked";

export function mountEditor(ctx: StackCtx) {
function sectionMarkRoot(state: SectionState): ParentNode {
    if (ctx.dom.stack) {
        for (const section of ctx.dom.stack.querySelectorAll<HTMLElement>(".stack-note")) {
            const id = section.dataset.id;
            if (id && ctx.notes.get(id) === state) {
                return section.querySelector(".stack-blocks") ?? section;
            }
        }
    }
    return document.createDocumentFragment();
}

function pushSectionUndo(state: SectionState, force = true) {
    if (!state.history.shouldCapture(force)) {
        return;
    }
    const root = sectionMarkRoot(state);
    state.history.push(state.blocks, state.caret, force, readLineMarks(root, state.marks), readFolds(root, state.folds));
}

function undoSection(section: HTMLElement, state: SectionState): boolean {
    const container = section.querySelector<HTMLElement>(".stack-blocks");
    const entry = state.history.takeUndo(state.blocks, state.caret, readLineMarks(container ?? section, state.marks), readFolds(container ?? section, state.folds));
    if (!entry) {
        return false;
    }
    state.blocks = cloneBlocks(entry.blocks);
    state.caret = entry.caret ? { ...entry.caret } : null;
    state.content = serializeBlocks(state.blocks);
    renderSectionBlocks(section, state);
    state.folds = entry.folds ?? [];
    state.marks = entry.marks ?? [];
    const next = section.querySelector<HTMLElement>(".stack-blocks");
    if (next) {
        writeFolds(next, state.folds);
        writeLineMarks(next, state.marks);
        restoreCaret(next, state.caret);
    }
    scheduleSectionSave(section, state);
    return true;
}

function redoSection(section: HTMLElement, state: SectionState): boolean {
    const container = section.querySelector<HTMLElement>(".stack-blocks");
    const entry = state.history.takeRedo(state.blocks, state.caret, readLineMarks(container ?? section, state.marks), readFolds(container ?? section, state.folds));
    if (!entry) {
        return false;
    }
    state.blocks = cloneBlocks(entry.blocks);
    state.caret = entry.caret ? { ...entry.caret } : null;
    state.content = serializeBlocks(state.blocks);
    renderSectionBlocks(section, state);
    state.folds = entry.folds ?? [];
    state.marks = entry.marks ?? [];
    const next = section.querySelector<HTMLElement>(".stack-blocks");
    if (next) {
        writeFolds(next, state.folds);
        writeLineMarks(next, state.marks);
        restoreCaret(next, state.caret);
    }
    scheduleSectionSave(section, state);
    return true;
}

function stackSectionFrom(event: Event): HTMLElement | null {
    const node = event.target;
    if (node instanceof Element) {
        return node.closest<HTMLElement>(".stack-note");
    }
    if (node instanceof Node) {
        return node.parentElement?.closest<HTMLElement>(".stack-note") ?? null;
    }
    return null;
}

function sectionAreaSelection(area: Editable, state: SectionState): {
    start: number;
    end: number;
} {
    const index = Number(area.dataset.index ?? 0);
    const active = document.activeElement;
    if (active instanceof Node && (active === area || area.contains(active))) {
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

function sectionTargetArea(section: HTMLElement, state: SectionState): Editable | null {
    const container = section.querySelector<HTMLElement>(".stack-blocks");
    if (!container) {
        return null;
    }
    const active = activeField(container);
    if (active) {
        return active;
    }
    if (state.caret) {
        const remembered = fieldAt(container, state.caret.index);
        if (remembered) {
            return remembered;
        }
    }
    const fields = fieldsIn(container);
    return fields[fields.length - 1] ?? null;
}

function scheduleSectionSave(section: HTMLElement, state: SectionState) {
    const id = section.dataset.id;
    if (!id) {
        return;
    }
    if (ctx.fold.autoOpenNewSection === id) {
        ctx.fold.autoOpenNewSection = null;
        ctx.fold.editingHoldSection = id;
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
        ctx.api.syncHeaderCompact();
    }
    const content = state.content;
    const pending = ctx.saveTimers.get(id);
    if (pending) {
        clearTimeout(pending);
    }
    ctx.saveTimers.set(id, setTimeout(() => {
        ctx.saveTimers.delete(id);
        state.loaded = content;
        void invoke("save_edit", { id, content }).catch((error: unknown) => {
            console.error(error);
        });
        void saveSectionEditorView(id, state).catch((error: unknown) => {
            console.error(error);
        });
    }, 300));
}

async function saveSectionEditorView(id: string, state: SectionState) {
    const section = ctx.dom.stack?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
    const container = section?.querySelector(".stack-blocks");
    if (container?.querySelector("textarea")) {
        state.folds = readFolds(container, state.folds);
        state.marks = readLineMarks(container, state.marks);
    }
    await invoke("save_editor_view", {
        id,
        lineWrap: state.wrap,
        folds: denseLines(state.folds),
        marks: denseLines(state.marks),
    });
}

function applySectionEdit(section: HTMLElement, state: SectionState, area: Editable, edit: Edit) {
    const index = Number(area.dataset.index ?? 0);
    const block = state.blocks[index];
    if (!block || !isTypedBlock(block)) {
        return;
    }
    pushSectionUndo(state, true);
    area.value = edit.value;
    block.text = edit.value;
    area.classList.toggle("empty-slot", edit.value.length === 0 && state.blocks.length > 1);
    state.content = serializeBlocks(state.blocks);
    if (block.kind === "text" && (mediaTokenRegex.test(area.value) || closedFenceIn(area.value))) {
        const fromIndex = index;
        state.blocks = parseBlocks(state.content);
        renderSectionBlocks(section, state);
        const container = section.querySelector<HTMLElement>(".stack-blocks");
        if (container) {
            focusLiftedCode(container, state.blocks, fromIndex, (next) => {
                state.caret = next;
            });
        }
        scheduleSectionSave(section, state);
        return;
    }
    if (area instanceof HTMLTextAreaElement) {
        sizeBlockTextarea(area);
    }
    area.focus();
    const start = Math.min(edit.start, area.value.length);
    const end = Math.min(edit.end, area.value.length);
    area.setSelectionRange(start, end);
    state.caret = { index, start, end };
    scheduleSectionSave(section, state);
}

function removeSectionMediaAt(section: HTMLElement, blockIndex: number, name: string) {
    const id = section.dataset.id;
    const state = id ? ctx.notes.get(id) : undefined;
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

function renderSectionBlocks(section: HTMLElement, state: SectionState, focusName?: string) {
    const container = section.querySelector<HTMLElement>(".stack-blocks");
    if (!container) {
        return;
    }
    ctx.api.paintSectionCoder(section, state);
    if (container.querySelector("textarea")) {
        state.folds = readFolds(container, state.folds);
        state.marks = readLineMarks(container, state.marks);
    }
    state.blocks = ensureTextSlots(state.blocks);
    const previousBlocks = ctx.renderedViews.get(state);
    if (previousBlocks) {
        state.folds = remapBlockLines(previousBlocks, state.blocks, state.folds);
        state.marks = remapBlockLines(previousBlocks, state.blocks, state.marks);
    }
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
    let currentRowSideArea: HTMLElement | null = null;
    state.blocks.forEach((block, index) => {
        if (isTypedBlock(block)) {
            const prevBlock = state.blocks[index - 1];
            const isAfterMedia = prevBlock?.kind === "media";
            const canSitOnMediaLine = block.kind === "text" &&
                isAfterMedia &&
                currentRow !== null &&
                currentRowSideArea === null &&
                !block.text.includes("\n");
            if (block.kind === "text" && !memoUsesCoder(state.coder)) {
                const assignedRow = canSitOnMediaLine ? currentRow : null;
                let field: Editable | null = null;
                const mounted = mountLineEditor({
                    text: block.text,
                    index,
                    placeholder: index === 0 && state.blocks.length === 1 ? "Write a memo..." : "",
                    grow: index === lastIndex && !canSitOnMediaLine,
                    inline: canSitOnMediaLine,
                    empty: block.text.length === 0 && state.blocks.length > 1 && !canSitOnMediaLine,
                    container,
                    blocks: () => state.blocks,
                    undo: (force) => {
                        pushSectionUndo(state, force);
                    },
                    change: (value, place) => {
                        if (!field) {
                            return;
                        }
                        block.text = value;
                        syncInlineLineSlot(field, prevBlock, assignedRow, container, index === lastIndex);
                        state.caret = { index, start: place.start, end: place.end };
                        state.content = serializeBlocks(state.blocks);
                        scheduleSectionSave(section, state);
                    },
                    reparse: (value) => {
                        block.text = value;
                        state.content = serializeBlocks(state.blocks);
                        const fromIndex = index;
                        state.blocks = parseBlocks(state.content);
                        renderSectionBlocks(section, state);
                        focusLiftedCode(container, state.blocks, fromIndex, (next) => {
                            state.caret = next;
                        });
                        scheduleSectionSave(section, state);
                    },
                    apply: (edit) => {
                        if (field) {
                            applySectionEdit(section, state, field, edit);
                        }
                    },
                    removeMedia: (mediaIndex, focusIdx, caretPos) => {
                        pushSectionUndo(state, true);
                        state.blocks = ensureTextSlots(state.blocks.filter((_, idx) => idx !== mediaIndex));
                        state.content = serializeBlocks(state.blocks);
                        renderSectionBlocks(section, state);
                        scheduleSectionSave(section, state);
                        const target = fieldAt(container, focusIdx);
                        if (target) {
                            target.focus();
                            const clamped = Math.min(caretPos, target.value.length);
                            target.setSelectionRange(clamped, clamped);
                        }
                    },
                    splitInline: (before, after) => {
                        pushSectionUndo(state, true);
                        if (prevBlock?.kind === "media") {
                            prevBlock.inline = before.length > 0;
                        }
                        state.blocks.splice(index, 1, { kind: "text", text: before }, { kind: "text", text: `\n${after}` });
                        state.blocks = ensureTextSlots(state.blocks);
                        state.content = serializeBlocks(state.blocks);
                        renderSectionBlocks(section, state);
                        scheduleSectionSave(section, state);
                        const target = fieldAt(container, index);
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
                        if (index === lastIndex) {
                            field.classList.add("grow");
                        }
                        const host = editorShell(field);
                        if (assignedRow && host.parentElement === assignedRow) {
                            assignedRow.after(host);
                        }
                        else {
                            container.append(host);
                        }
                        field.focus();
                    },
                    allowTab: () => true,
                    onCaret: () => {
                        if (!field) {
                            return;
                        }
                        state.caret = {
                            index,
                            start: field.selectionStart ?? field.value.length,
                            end: field.selectionEnd ?? field.value.length,
                        };
                    },
                });
                field = mounted.field;
                if (canSitOnMediaLine && currentRow) {
                    currentRow.append(mounted.shell);
                    currentRowSideArea = field;
                }
                else {
                    currentRow = null;
                    currentRowSideArea = null;
                    container.append(mounted.shell);
                }
                return;
            }
            const area = document.createElement("textarea");
            area.dataset.index = String(index);
            area.dataset.kind = block.kind;
            if (block.kind === "code" && block.lang) {
                area.dataset.lang = block.lang;
            }
            area.value = block.text;
            area.rows = 1;
            area.spellcheck = false;
            area.setAttribute("writingsuggestions", "false");
            area.autocomplete = "off";
            area.setAttribute("autocorrect", "off");
            area.setAttribute("autocapitalize", "off");
            if (index === 0 && state.blocks.length === 1 && block.kind === "text") {
                area.placeholder = "Write a memo...";
            }
            else if (canSitOnMediaLine) {
                area.classList.add("inline-line-slot");
            }
            else if (block.text.length === 0 && state.blocks.length > 1) {
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
                if (block.kind === "code" &&
                    event.key === "Backspace" &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.isComposing &&
                    area.value.length === 0 &&
                    (area.selectionStart ?? 0) === (area.selectionEnd ?? 0)) {
                    event.preventDefault();
                    pushSectionUndo(state, true);
                    const dropped = dropCodeBlock(state.blocks, index);
                    state.blocks = dropped.blocks;
                    state.content = serializeBlocks(state.blocks);
                    renderSectionBlocks(section, state);
                    scheduleSectionSave(section, state);
                    const target = fieldAt(container, dropped.index);
                    if (target) {
                        target.focus();
                        const clamped = Math.min(dropped.offset, target.value.length);
                        target.setSelectionRange(clamped, clamped);
                        state.caret = { index: dropped.index, start: clamped, end: clamped };
                    }
                    return;
                }
                if (handleBlockMediaDeletion(container, area, event, () => state.blocks, (mediaIndex, focusIdx, caretPos) => {
                    pushSectionUndo(state, true);
                    state.blocks = ensureTextSlots(state.blocks.filter((_, idx) => idx !== mediaIndex));
                    state.content = serializeBlocks(state.blocks);
                    renderSectionBlocks(section, state);
                    scheduleSectionSave(section, state);
                    const target = fieldAt(container, focusIdx);
                    if (target) {
                        target.focus();
                        const clamped = Math.min(caretPos, target.value.length);
                        target.setSelectionRange(clamped, clamped);
                    }
                })) {
                    return;
                }
                if (handleBlockAreaNavigation(container, area, event)) {
                    return;
                }
                if (event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.isComposing &&
                    area.classList.contains("inline-line-slot")) {
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
                        }
                        else {
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
                    state.blocks.splice(index, 1, { kind: "text", text: beforeLine }, { kind: "text", text: `\n${afterLine}` });
                    state.blocks = ensureTextSlots(state.blocks);
                    state.content = serializeBlocks(state.blocks);
                    renderSectionBlocks(section, state);
                    scheduleSectionSave(section, state);
                    const target = fieldAt(container, index);
                    if (target) {
                        target.focus();
                        const pos = Math.min(beforeLine.length + 1, target.value.length);
                        target.setSelectionRange(pos, pos);
                    }
                    return;
                }
                if (event.key === "Tab" &&
                    !event.altKey &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.isComposing &&
                    codeSurface(area)) {
                    event.preventDefault();
                    applySectionEdit(section, state, area, indentCode(area.value, area.selectionStart ?? 0, area.selectionEnd ?? 0, event.shiftKey));
                    return;
                }
                if (event.key === "Tab" &&
                    !event.altKey &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.isComposing) {
                    event.preventDefault();
                    const edit = tabOnMarkdown(area.value, area.selectionStart, area.selectionEnd, event.shiftKey);
                    applySectionEdit(section, state, area, edit);
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
                applySectionEdit(section, state, area, edit);
            });
            area.addEventListener("beforeinput", () => {
                pushSectionUndo(state, false);
            });
            area.addEventListener("input", (event) => {
                block.text = area.value;
                syncInlineLineSlot(area, prevBlock, assignedRow, container, index === lastIndex);
                if (block.kind === "text" &&
                    event instanceof InputEvent &&
                    (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph")) {
                    const closed = completeOpenFence(area.value, area.selectionStart);
                    if (closed) {
                        area.value = closed.value;
                        block.text = closed.value;
                    }
                }
                if (block.kind === "text" && (mediaTokenRegex.test(area.value) || closedFenceIn(area.value))) {
                    const fromIndex = index;
                    state.content = serializeBlocks(state.blocks);
                    state.blocks = parseBlocks(state.content);
                    renderSectionBlocks(section, state);
                    focusLiftedCode(container, state.blocks, fromIndex, (next) => {
                        state.caret = next;
                    });
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
            }
            else {
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
    if (container.querySelector("textarea")) {
        writeFolds(container, state.folds);
        writeLineMarks(container, state.marks);
    }
    ctx.renderedViews.set(state, cloneBlocks(state.blocks));
    resizeAllBlockTextareas(container);
    if (focusName) {
        const mediaIndex = state.blocks.findIndex((item) => item.kind === "media" && item.name === focusName);
        fieldAt(container, mediaIndex + 1)?.focus();
    }
}

function rerenderStackEditors() {
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
        if (!state) {
            return;
        }
        const preview = section.querySelector<HTMLElement>(".stack-preview");
        if (preview && !preview.hidden) {
            return;
        }
        renderSectionBlocks(section, state);
    });
}

function mediaMutatorForSection(section: HTMLElement): MediaNoteMutator | null {
    const id = section.dataset.id;
    const state = id ? ctx.notes.get(id) : undefined;
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

function toggleSectionPreview(section: HTMLElement) {
    const id = section.dataset.id;
    const state = id ? ctx.notes.get(id) : undefined;
    const mode = section.querySelector<HTMLButtonElement>(".mode-toggle");
    const preview = section.querySelector<HTMLElement>(".stack-preview");
    const sectionBlocks = section.querySelector<HTMLElement>(".stack-blocks");
    if (!mode || !preview || !sectionBlocks || !state) {
        return;
    }
    const shortcut = ctx.deps.editor.previewShortcut();
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
            void ctx.deps.editor.openPreview(name);
        });
    }
    else {
        renderSectionBlocks(section, state);
        sectionTargetArea(section, state)?.focus();
    }
}

function insertSectionMedia(section: HTMLElement, name: string, label?: string) {
    const id = section.dataset.id;
    const state = id ? ctx.notes.get(id) : undefined;
    const sectionBlocks = section.querySelector<HTMLElement>(".stack-blocks");
    if (!id || !state || !sectionBlocks) {
        return;
    }
    pushSectionUndo(state, true);
    const area = activeField(sectionBlocks) ?? sectionTargetArea(section, state);
    const index = area ? Number(area.dataset.index) : state.blocks.length - 1;
    const block = state.blocks[index];
    if (!block || block.kind !== "text") {
        state.blocks.push({ kind: "media", name, label });
    }
    else {
        const { start, end } = area ? sectionAreaSelection(area, state) : { start: block.text.length, end: block.text.length };
        const before = block.text.slice(0, start).replace(/\n+$/, "");
        const after = block.text.slice(end).replace(/^\n+/, "");
        state.blocks.splice(index, 1, { kind: "text", text: before }, { kind: "media", name, label }, { kind: "text", text: after });
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
            void ctx.deps.editor.openPreview(name);
        });
    }
}

function resumeStackEditor(): boolean {
    if (!ctx.fold.lastActiveSection || ctx.fold.lastActiveSection === "host") {
        return false;
    }
    const section = ctx.dom.stack?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(ctx.fold.lastActiveSection)}"]`);
    const state = ctx.notes.get(ctx.fold.lastActiveSection);
    const container = section?.querySelector<HTMLElement>(".stack-blocks");
    if (!section || !state?.caret || !container) {
        return false;
    }
    restoreCaret(container, state.caret);
    return true;
}
ctx.dom.stack?.addEventListener("memose-undo", (event) => {
    const section = stackSectionFrom(event);
    const id = section?.dataset.id;
    const held = id ? ctx.notes.get(id) : undefined;
    if (held) {
        pushSectionUndo(held, true);
    }
});
ctx.dom.stack?.addEventListener("memose-editor-view", (event) => {
    const section = stackSectionFrom(event);
    const id = section?.dataset.id;
    const held = id ? ctx.notes.get(id) : undefined;
    if (section && held) {
        const container = section.querySelector(".stack-blocks");
        if (container?.querySelector("textarea")) {
            held.folds = readFolds(container, held.folds);
            held.marks = readLineMarks(container, held.marks);
        }
        scheduleSectionSave(section, held);
    }
});
  return { pushSectionUndo, undoSection, redoSection, sectionAreaSelection, sectionTargetArea, scheduleSectionSave, saveSectionEditorView, applySectionEdit, renderSectionBlocks, rerenderStackEditors, mediaMutatorForSection, toggleSectionPreview, insertSectionMedia, resumeStackEditor };
}
