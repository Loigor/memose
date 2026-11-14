import { denseLines, memoUsesCoder, refreshEditorFields } from "../editor/editor-field";
import { BlockHistory } from "../editor/history";
import { applyCode, applyJsonFormat, applyList, applyOrdered, applyQuote, applyTask, applyTitle, noteTitle, parseBlocks, toggleTask, wrapText } from "../editor/markdown-edit";
import { resizeAllBlockTextareas } from "../editor/textarea";
import { revealPressedChoice } from "../look/audience-ui";
import { namedTheme } from "../look/look";
import { markdownToolbarHtml, stackHeaderHtml } from "../look/memo-chrome";
import { hueSwatches, saveHueSwatches } from "../look/swatches";
import { filesFromTransfer } from "../media/files";
import { mediaPointer } from "../media/media-elements";
import { inTauri, isPreviewWindow } from "../platform";
import { exactStamp, relativeTime } from "../time";
import type { Note } from "../types";
import { NOTE_BAR, type StackCtx } from "./context";
import { invoke } from "@tauri-apps/api/core";

export function mountSections(ctx: StackCtx) {
function syncSection(section: HTMLElement, note: Note) {
    const state = ctx.notes.get(note.id);
    if (!state) {
        return;
    }
    const isBar = ctx.api.sectionBarOnly(note.id, state);
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
        }
        else {
            edited.hidden = true;
        }
    }
    ctx.api.paintSectionAudience(section, state);
    const container = section.querySelector<HTMLElement>(".stack-blocks");
    const activeInside = Boolean(container && document.activeElement && container.contains(document.activeElement));
    if (!activeInside && (state.content === state.loaded || state.content === note.content)) {
        const changed = state.content !== note.content || (container?.childElementCount ?? 0) === 0;
        state.content = note.content;
        state.loaded = note.content;
        if (changed) {
            state.blocks = parseBlocks(note.content);
            ctx.api.renderSectionBlocks(section, state);
        }
        else if (container) {
            resizeAllBlockTextareas(container);
        }
    }
    const hue = section.querySelector<HTMLInputElement>(".hue-slider");
    if (hue && document.activeElement !== hue) {
        hue.value = String(ctx.api.sectionHue(state) ?? 48);
    }
    ctx.api.paintSectionSlots(section, state);
    ctx.api.paintSectionColor(section, state);
}

function beginSectionLift(section: HTMLElement, title: HTMLElement, event: PointerEvent) {
    const id = section.dataset.id;
    if (!id) {
        return;
    }
    ctx.pointer.sectionLift = {
        id,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        started: false,
    };
    title.setPointerCapture(event.pointerId);
}

function moveSectionLift(section: HTMLElement, title: HTMLElement, event: PointerEvent) {
    const lift = ctx.pointer.sectionLift;
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
    let detachedCardsHeight = ctx.size.openNoteHeight;
    for (let i = 1; i < sources.length; i += 1) {
        const tailId = sources[i].dataset.id;
        const tailState = tailId ? ctx.notes.get(tailId) : undefined;
        detachedCardsHeight += tailState?.collapsed ? NOTE_BAR : ctx.size.openNoteHeight;
    }
    const h = Math.round((detachedCardsHeight + 56) * factor);
    const grabX = Math.round(event.screenX * factor) - x;
    const grabY = Math.round(event.screenY * factor) - y;
    const state = ctx.notes.get(lift.id);
    void invoke("detach_stack", {
        guestId: lift.id,
        x,
        y,
        w,
        h,
        theme: state ? ctx.api.sectionTheme(state) : ctx.deps.look.theme(),
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
    const lift = ctx.pointer.sectionLift;
    if (!lift || event.pointerId !== lift.pointerId) {
        return;
    }
    ctx.pointer.sectionLift = null;
    if (title.hasPointerCapture(event.pointerId)) {
        title.releasePointerCapture(event.pointerId);
    }
}

async function flushSectionSaves(ids?: Iterable<string>) {
    const targets = ids ? [...ids] : [...ctx.saveTimers.keys()];
    await Promise.all(targets.map(async (id) => {
        const timer = ctx.saveTimers.get(id);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        ctx.saveTimers.delete(id);
        const state = ctx.notes.get(id);
        if (!state) {
            return;
        }
        state.loaded = state.content;
        await invoke("save_edit", { id, content: state.content });
        await ctx.api.saveSectionEditorView(id, state);
    }));
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
    const state = ctx.notes.get(note.id);
    if (state) {
        ctx.api.renderSectionBlocks(section, state);
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
        void ctx.deps.editor.attachFiles(files, section);
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
        if (ctx.api.dragBlocked(target)) {
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
        const state = ctx.notes.get(note.id);
        if (!state || !state.collapsed || ctx.pointer.pressTravel > 8 || header.dataset.moved === "1") {
            return;
        }
        if (event.target instanceof Element && event.target.closest("textarea, .md-lines, button, input, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools")) {
            return;
        }
        if (ctx.api.holdCollapsed(note.id)) {
            ctx.api.paintChrome();
        }
    });
    section.addEventListener("pointerdown", (event) => {
        if (ctx.fold.autoOpenNewSection === note.id) {
            ctx.fold.autoOpenNewSection = null;
            ctx.fold.editingHoldSection = note.id;
        }
        if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        if (target.closest("header, button, input, textarea, .md-lines, .media, .media-audio, .file-attachment, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools, #resize-grip, .resize-handle")) {
            return;
        }
        ctx.api.startWindowDrag(event);
    });
    section.addEventListener("mouseenter", (event) => {
        ctx.pointer.cursorPoint = { x: event.clientX, y: event.clientY };
        ctx.pointer.cursorKnown = true;
        ctx.api.syncCollapsedPeek();
    });
    section.addEventListener("mouseleave", (event) => {
        ctx.pointer.cursorPoint = { x: event.clientX, y: event.clientY };
        ctx.pointer.cursorKnown = true;
        if (ctx.fold.autoOpenNewSection === note.id) {
            ctx.api.dismissAutoOpenNewSection();
        }
        ctx.api.syncCollapsedPeek();
        ctx.api.paintChrome();
    });
    const themeButton = section.querySelector<HTMLButtonElement>(".theme-toggle");
    const pop = section.querySelector<HTMLElement>(".color-pop");
    const hue = section.querySelector<HTMLInputElement>(".hue-slider");
    themeButton?.addEventListener("click", (event) => {
        const state = ctx.notes.get(note.id);
        if (!state || !pop) {
            return;
        }
        const alt = event.altKey || ctx.deps.look.altHeld();
        if (!alt) {
            pop.hidden = !pop.hidden;
            return;
        }
        pop.hidden = true;
        state.theme = ctx.api.sectionTheme(state) === "dark" ? "light" : "dark";
        ctx.api.paintSectionColor(section, state);
        ctx.api.paintSectionSlots(section, state);
        ctx.api.saveSectionLook(note.id, state);
    });
    hue?.addEventListener("input", () => {
        const state = ctx.notes.get(note.id);
        if (!state || !hue) {
            return;
        }
        ctx.api.setSectionHue(section, state, Number(hue.value));
    });
    section.querySelectorAll<HTMLButtonElement>(".hue-slot").forEach((slot) => {
        slot.addEventListener("click", () => {
            const state = ctx.notes.get(note.id);
            const raw = slot.dataset.hue;
            if (!state || raw == null || raw === "") {
                return;
            }
            ctx.api.setSectionHue(section, state, Number(raw));
        });
    });
    section.querySelector<HTMLButtonElement>(".hue-add")?.addEventListener("click", () => {
        const state = ctx.notes.get(note.id);
        if (!state || !hue) {
            return;
        }
        const value = Number(hue.value);
        const swatches = hueSwatches();
        if (swatches.includes(value) || swatches.length >= 6) {
            return;
        }
        void saveHueSwatches([...swatches, value]).then(() => {
            ctx.api.setSectionHue(section, state, value);
        });
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
        const state = ctx.notes.get(note.id);
        if (!state) {
            return;
        }
        const field = ctx.api.sectionTargetArea(section, state);
        if (!field) {
            return;
        }
        const { start, end } = ctx.api.sectionAreaSelection(field, state);
        const value = field.value;
        const edit = kind === "bold"
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
        if (!edit) {
            return;
        }
        ctx.api.applySectionEdit(section, state, field, edit);
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
        const held = ctx.notes.get(note.id);
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
        const held = ctx.notes.get(note.id);
        if (!action || !held) {
            return;
        }
        if (action === "wrap") {
            held.wrap = !held.wrap;
            ctx.api.paintSectionCoder(section, held);
            refreshEditorFields(section);
            resizeAllBlockTextareas(section);
            ctx.api.scheduleSectionSave(section, held);
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
        mode.title = `Preview (${ctx.deps.editor.previewShortcut()})`;
    }
    mode?.addEventListener("click", () => {
        ctx.api.toggleSectionPreview(section);
        closeSectionEditorMenu();
    });
    const coderToggle = section.querySelector<HTMLButtonElement>(".coder-toggle");
    coderToggle?.addEventListener("click", () => {
        const state = ctx.notes.get(note.id);
        if (!state) {
            return;
        }
        state.coder = !memoUsesCoder(state.coder);
        ctx.api.paintSectionCoder(section, state);
        const previewOpen = section.querySelector<HTMLElement>(".stack-preview");
        if (!previewOpen || previewOpen.hidden) {
            ctx.api.renderSectionBlocks(section, state);
        }
        refreshEditorFields(section);
        resizeAllBlockTextareas(section);
        ctx.api.saveSectionLook(note.id, state);
        closeSectionEditorMenu();
    });
    preview?.addEventListener("change", (event) => {
        const target = event.target;
        const state = ctx.notes.get(note.id);
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
        ctx.api.pushSectionUndo(state, true);
        state.content = next;
        state.blocks = parseBlocks(next);
        ctx.api.renderSectionBlocks(section, state);
        ctx.api.scheduleSectionSave(section, state);
    });
    preview?.addEventListener("dblclick", (event) => {
        if (event.target instanceof Element &&
            event.target.closest("a, input, img, video, audio, .media-audio, .file-attachment, button")) {
            return;
        }
        const state = ctx.notes.get(note.id);
        mode?.click();
        if (state) {
            ctx.api.sectionTargetArea(section, state)?.focus();
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
        if (delNote)
            delNote.hidden = false;
        if (delConfirm)
            delConfirm.hidden = true;
        if (delYes)
            delYes.textContent = "Delete";
    };
    const closeSectionAudience = () => {
        if (audPop)
            audPop.hidden = true;
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
        if (delNote)
            delNote.hidden = true;
        if (delConfirm)
            delConfirm.hidden = false;
    });
    delNo?.addEventListener("click", () => {
        resetSectionDelete();
    });
    delYes?.addEventListener("click", () => {
        void (async () => {
            if (delYes)
                delYes.textContent = "Deleting…";
            const pending = ctx.saveTimers.get(note.id);
            if (pending) {
                clearTimeout(pending);
                ctx.saveTimers.delete(note.id);
            }
            await invoke("delete_note", { id: note.id });
            closeSectionAudience();
        })().catch((error: unknown) => {
            if (delYes)
                delYes.textContent = "Could not delete";
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
        const state = id ? ctx.notes.get(id) : undefined;
        if (!id || !state) {
            return;
        }
        void ctx.api.toggleSection(id);
    });
    return section;
}

async function loadStack() {
    if (!ctx.dom.stack) {
        return;
    }
    if (!ctx.deps.pinnedNoteId || !inTauri()) {
        ctx.notes.clear();
        ctx.dom.stack.replaceChildren();
        ctx.dom.frame?.classList.remove("has-stack");
        ctx.deps.card.classList.remove("stacked-host", "is-bar");
        return;
    }
    const notes = await invoke<Note[]>("stack_chain", { hostId: ctx.deps.pinnedNoteId });
    const existing = [...ctx.dom.stack.children].map((node) => (node as HTMLElement).dataset.id);
    const previous = new Set(existing.filter((id): id is string => Boolean(id)));
    const nextIds = notes.map((note) => note.id);
    const same = existing.length === nextIds.length && existing.every((id, index) => id === nextIds[index]);
    const joinedIds = ctx.size.initialSizeSynced ? nextIds.filter((id) => !previous.has(id)) : [];
    const autoFoldedJoin = joinedIds.length > 0 && notes.length >= 3;
    if (autoFoldedJoin) {
        ctx.fold.hostCollapsed = true;
        ctx.fold.hostHover = false;
        ctx.fold.suppressHostHover = ctx.api.isElementHovered(ctx.deps.card);
        const joinedId = joinedIds[0];
        ctx.fold.editingHoldSection = joinedId;
        ctx.fold.autoOpenNewSection = joinedId;
        ctx.fold.lastActiveSection = joinedId;
    }
    const ids = new Set(nextIds);
    for (const id of [...ctx.notes.keys()]) {
        if (!ids.has(id)) {
            ctx.notes.delete(id);
        }
    }
    for (const note of notes) {
        const prev = ctx.notes.get(note.id);
        const isJoined = autoFoldedJoin && note.id === joinedIds[0];
        const hasPendingSave = ctx.saveTimers.has(note.id);
        const content = prev && hasPendingSave ? prev.content : note.content;
        const blocks = prev && prev.content === content ? prev.blocks : parseBlocks(content);
        ctx.notes.set(note.id, {
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
            coder: prev?.coder ??
                (note.coder === true ? true : note.coder === false ? false : null),
            wrap: prev?.wrap ?? note.lineWrap === true,
            folds: prev?.folds ?? denseLines(note.folds),
            marks: prev?.marks ?? denseLines(note.marks),
            mdBar: prev?.mdBar ?? false,
            visibility: note.visibility || "PRIVATE",
            space: note.space || "",
            syncState: note.syncState || "local",
            lastError: note.lastError ?? null,
        });
    }
    if (!same) {
        const sections = notes.map((note) => buildSection(note));
        ctx.dom.stack.replaceChildren(...sections);
        for (const section of sections) {
            const id = section.dataset.id || "";
            const state = ctx.notes.get(id);
            if (!previous.has(id) && state && !ctx.api.sectionBarOnly(id, state)) {
                section.classList.add("joining");
            }
        }
    }
    const stackEl = ctx.dom.stack;
    notes.forEach((note, index) => {
        const section = stackEl.children[index];
        if (section instanceof HTMLElement) {
            syncSection(section, note);
        }
    });
    if (autoFoldedJoin) {
        const joinedId = joinedIds[0];
        const joinedSection = ctx.dom.stack.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(joinedId)}"]`);
        const joinedState = ctx.notes.get(joinedId);
        if (joinedSection && joinedState) {
            ctx.api.sectionTargetArea(joinedSection, joinedState)?.focus();
        }
    }
    ctx.dom.frame?.classList.toggle("has-stack", notes.length > 0);
    ctx.deps.card.classList.toggle("stacked-host", notes.length > 0);
    ctx.deps.card.classList.toggle("is-bar", notes.length > 0 && ctx.api.hostBarOnly());
    if (!ctx.size.initialSizeSynced) {
        ctx.size.initialSizeSynced = true;
        const box = ctx.dom.frame?.clientHeight ?? 0;
        const { opens, bars } = ctx.api.stackCounts();
        if (opens === 1 && bars === 0 && box > 100) {
            ctx.size.openNoteHeight = Math.max(160, Math.round(box));
            ctx.size.savedHostHeight = 56 + ctx.size.openNoteHeight;
        }
        else if (opens > 1 && box >= opens * 260 + bars * NOTE_BAR) {
            ctx.size.openNoteHeight = Math.max(160, Math.round((box - bars * NOTE_BAR) / opens));
            ctx.size.savedHostHeight = 56 + ctx.size.openNoteHeight;
        }
    }
    ctx.api.applyOpenHeight();
    if (autoFoldedJoin) {
        const joinedId = joinedIds[0];
        document.documentElement.classList.toggle("collapsed", ctx.fold.hostCollapsed);
        document.documentElement.classList.toggle("hover-open", ctx.fold.hostCollapsed && !ctx.api.hostBarOnly());
        ctx.deps.editor.syncTitle();
        ctx.deps.look.paintThemeIcon();
        ctx.api.syncActiveNoteHeader();
        ctx.fold.suppressHostHover = ctx.api.isElementHovered(ctx.deps.card);
        ctx.dom.stack.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
            const id = section.dataset.id;
            const state = id ? ctx.notes.get(id) : undefined;
            if (state && id !== joinedId) {
                state.suppressHover = ctx.api.isElementHovered(section);
            }
        });
    }
    const target = ctx.api.targetWindowHeight();
    const current = await ctx.api.logicalHeight();
    if (!same || Math.abs(target - current) > 4) {
        ctx.api.cancelHeightTween();
        await ctx.api.setLogicalHeight(target);
    }
    ctx.size.chromeSignature = `${ctx.api.stackCounts().opens}:${ctx.api.stackCounts().bars}:${ctx.api.hasStack() ? 1 : 0}`;
}

  return { loadStack };
}
