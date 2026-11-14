import { pointOnScrollGutter, type ScrollBox } from "../dom";
import { editingHost } from "../editor/editable";
import { resizeAllBlockTextareas } from "../editor/textarea";
import { mediaPointer } from "../media/media-elements";
import { inTauri, isPreviewWindow } from "../platform";
import type { StackCtx } from "./context";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDir = "w" | "e" | "n" | "s" | "nw" | "ne" | "sw" | "se";

type ScreenEdgeCue = {
  left: number | null;
  right: number | null;
  top: number | null;
  bottom: number | null;
  origin_x: number;
  origin_y: number;
};

export function mountChrome(ctx: StackCtx) {
function dragBlocked(target: EventTarget | null): boolean {
    return (target instanceof Element &&
        Boolean(target.closest("button, a, input, textarea, .md-lines, select, audio, video, .media, .media-audio, .file-attachment, #media-context-menu, #resize-grip, .resize-handle, #color-pop, #audience-pop, #format-pop, #md-toolbar, #editor-tools, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools, .md-tag")));
}

function scrollBoxFromElement(node: HTMLElement): {
    rect: DOMRect;
    box: ScrollBox;
} {
    const style = getComputedStyle(node);
    return {
        rect: node.getBoundingClientRect(),
        box: {
            clientWidth: node.clientWidth,
            clientHeight: node.clientHeight,
            scrollWidth: node.scrollWidth,
            scrollHeight: node.scrollHeight,
            offsetWidth: node.offsetWidth,
            offsetHeight: node.offsetHeight,
            borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
            borderRight: Number.parseFloat(style.borderRightWidth) || 0,
            borderTop: Number.parseFloat(style.borderTopWidth) || 0,
            borderBottom: Number.parseFloat(style.borderBottomWidth) || 0,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
        },
    };
}

function pointerOnScrollbar(event: MouseEvent): boolean {
    let node: Element | null = event.target instanceof Element ? event.target : null;
    while (node) {
        if (node instanceof HTMLElement) {
            const { rect, box } = scrollBoxFromElement(node);
            if (pointOnScrollGutter(event.clientX, event.clientY, rect, box)) {
                return true;
            }
        }
        node = node.parentElement;
    }
    return false;
}

function asResizeDir(value: string | undefined): ResizeDir | null {
    if (value === "w" ||
        value === "e" ||
        value === "n" ||
        value === "s" ||
        value === "nw" ||
        value === "ne" ||
        value === "sw" ||
        value === "se") {
        return value;
    }
    return null;
}

function resizeZone(event: MouseEvent): ResizeDir | null {
    if (pointerOnScrollbar(event)) {
        return null;
    }
    const target = event.target;
    if (target instanceof Element) {
        if (target.closest("button, a, input, textarea, select, #color-pop, #audience-pop, #format-pop, #md-toolbar, #editor-tools, .color-pop, .audience-pop, .format-pop, .md-toolbar, .editor-tools")) {
            return null;
        }
        const handle = target.closest<HTMLElement>("[data-resize]");
        const dir = asResizeDir(handle?.dataset.resize);
        if (dir) {
            return dir;
        }
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    const x = event.clientX;
    const y = event.clientY;
    const nearTop = y <= 24;
    const nearBottom = h - y <= 48;
    if (nearTop && w - x <= 44) {
        return "ne";
    }
    if (nearTop && x <= 44) {
        return "nw";
    }
    if (y <= 24 && x > 44 && w - x > 44) {
        return "n";
    }
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

function startResize(event: MouseEvent, requestedDir?: ResizeDir) {
    if (ctx.pointer.resizing || !inTauri() || isPreviewWindow()) {
        return;
    }
    let dir = requestedDir ?? resizeZone(event);
    if (!dir) {
        return;
    }
    if (ctx.api.stackCounts().opens <= 0) {
        if (dir === "s" || dir === "n") {
            return;
        }
        if (dir === "se" || dir === "ne") {
            dir = "e";
        }
        else if (dir === "sw" || dir === "nw") {
            dir = "w";
        }
    }
    event.preventDefault();
    event.stopPropagation();
    ctx.api.cancelHeightTween();
    ctx.pointer.resizing = true;
    ctx.pointer.resizingVertical =
        dir === "s" || dir === "se" || dir === "sw" || dir === "n" || dir === "ne" || dir === "nw";
    void invoke("begin_corner_resize", { label: getCurrentWindow().label, edge: dir })
        .catch((error: unknown) => {
        console.error(error);
    })
        .finally(() => {
        const wasVertical = ctx.pointer.resizingVertical;
        ctx.pointer.resizing = false;
        ctx.pointer.resizingVertical = false;
        if (wasVertical) {
            ctx.api.rememberOpenSlice();
        }
    });
}

function startWindowDrag(event: MouseEvent) {
    if (!inTauri() || isPreviewWindow() || ctx.pointer.sectionLift !== null) {
        return;
    }
    if (pointerOnScrollbar(event)) {
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
    return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || editingHost(el) != null;
}

function slideOut() {
    if (!inTauri() || isPreviewWindow() || ctx.pointer.resizing) {
        return;
    }
    void invoke("slide_into_view", { label: getCurrentWindow().label }).catch((error: unknown) => {
        console.error(error);
    });
}

function slideHome() {
    if (!inTauri() || isPreviewWindow() || ctx.pointer.resizing || typingNote()) {
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

function placeScreenEdges(cue: ScreenEdgeCue) {
    const root = document.querySelector<HTMLElement>("#screen-edges");
    const frame = document.querySelector<HTMLElement>("#frame");
    if (!root || !frame) {
        return;
    }
    const box = frame.getBoundingClientRect();
    root.style.left = `${box.left}px`;
    root.style.top = `${box.top}px`;
    root.style.width = `${box.width}px`;
    root.style.height = `${box.height}px`;
    const place = (name: "left" | "right" | "top" | "bottom", at: number | null) => {
        const edge = root.querySelector<HTMLElement>(`[data-edge="${name}"]`);
        if (!edge) {
            return;
        }
        edge.hidden = at === null;
        if (at === null) {
            return;
        }
        const local = (name === "left" || name === "right" ? at - box.left : at - box.top);
        if (name === "left" || name === "right") {
            edge.style.left = `${name === "right" ? local - 20 : local}px`;
        }
        else {
            edge.style.top = `${name === "bottom" ? local - 20 : local}px`;
        }
    };
    place("left", cue.left);
    place("right", cue.right);
    place("top", cue.top);
    place("bottom", cue.bottom);
}

function paintScreenEdges(cue: ScreenEdgeCue) {
    const root = document.querySelector<HTMLElement>("#screen-edges");
    if (!root) {
        return;
    }
    const clear = cue.left === null && cue.right === null && cue.top === null && cue.bottom === null;
    if (clear) {
        root.hidden = true;
        root.classList.add("is-clear");
        return;
    }
    root.hidden = false;
    root.classList.remove("is-clear");
    placeScreenEdges(cue);
}

function wireChrome() {
    window.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) {
            return;
        }
        const dir = resizeZone(event);
        if (!dir) {
            return;
        }
        startResize(event, dir);
    }, true);
    window.addEventListener("mousedown", (event) => {
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
    }, true);
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
        void ctx.api.setHostCollapsed(!ctx.fold.hostCollapsed);
    });
    ctx.deps.card.addEventListener("click", (event) => {
        if (!ctx.fold.hostCollapsed || ctx.pointer.pressTravel > 8) {
            return;
        }
        if (event.target instanceof Element &&
            event.target.closest("textarea, button, input, #audience-pop, #color-pop, #format-pop, #md-toolbar, #editor-tools")) {
            return;
        }
        if (ctx.api.holdCollapsed("host")) {
            ctx.api.paintChrome();
        }
    });
    ctx.deps.card.addEventListener("mouseenter", (event) => {
        ctx.pointer.cursorPoint = { x: event.clientX, y: event.clientY };
        ctx.pointer.cursorKnown = true;
        ctx.api.syncCollapsedPeek();
    });
    document.documentElement.addEventListener("mouseenter", (event) => {
        ctx.pointer.cursorPoint = { x: event.clientX, y: event.clientY };
        ctx.pointer.cursorKnown = true;
        slideOut();
        ctx.api.syncCollapsedPeek();
    });
    document.documentElement.addEventListener("mouseleave", () => {
        ctx.pointer.cursorPoint = null;
        ctx.pointer.cursorKnown = true;
        if (ctx.fold.autoOpenNewSection !== null) {
            ctx.api.dismissAutoOpenNewSection();
        }
        ctx.api.syncCollapsedPeek();
        ctx.api.paintChrome();
        slideHome();
    });
    document.addEventListener("focusin", (event) => {
        const target = event.target;
        if (target instanceof Element) {
            const section = target.closest<HTMLElement>(".stack-note");
            if (section?.dataset.id) {
                ctx.fold.lastActiveSection = section.dataset.id;
            }
            else if (ctx.deps.card.contains(target)) {
                ctx.fold.lastActiveSection = "host";
            }
        }
        const field = target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "range")
            ? target
            : editingHost(target);
        if (field) {
            const section = field.closest<HTMLElement>(".stack-note");
            const nextHold = section?.dataset.id ?? (ctx.deps.card.contains(field) ? "host" : null);
            if (nextHold && nextHold !== ctx.fold.editingHoldSection) {
                ctx.fold.editingHoldSection = nextHold;
                ctx.api.syncCollapsedPeek();
                ctx.api.paintChrome();
            }
        }
        ctx.api.syncActiveNoteHeader();
        if (typingNote()) {
            slideOut();
        }
    });
    document.addEventListener("focusout", () => {
        window.setTimeout(() => {
            ctx.api.syncActiveNoteHeader();
            slideHome();
        }, 0);
    });
    window.addEventListener("focus", () => {
        ctx.api.syncActiveNoteHeader();
    });
    window.addEventListener("blur", () => {
        ctx.fold.autoOpenNewSection = null;
        if (ctx.fold.editingHoldSection !== null) {
            ctx.fold.editingHoldSection = null;
            ctx.api.syncCollapsedPeek();
            ctx.api.paintChrome();
        }
        ctx.api.syncActiveNoteHeader();
        window.setTimeout(slideHome, 0);
    });
    ctx.deps.card.addEventListener("mouseleave", (event) => {
        ctx.pointer.cursorPoint = { x: event.clientX, y: event.clientY };
        ctx.pointer.cursorKnown = true;
        ctx.api.syncCollapsedPeek();
    });
    window.addEventListener("pointerdown", (event) => {
        ctx.pointer.cursorPoint = { x: event.clientX, y: event.clientY };
        ctx.pointer.cursorKnown = true;
        ctx.pointer.pressAt = { x: event.clientX, y: event.clientY };
        ctx.pointer.pressTravel = 0;
        const target = event.target;
        if (target instanceof Element) {
            const section = target.closest<HTMLElement>(".stack-note");
            if (section?.dataset.id) {
                ctx.fold.lastActiveSection = section.dataset.id;
            }
            else if (ctx.deps.card.contains(target)) {
                ctx.fold.lastActiveSection = "host";
            }
            const folding = Boolean(target.closest("#fold-toggle, .fold-toggle"));
            const nextHold = section?.dataset.id ?? (ctx.deps.card.contains(target) ? "host" : null);
            if (!folding && nextHold && ctx.api.holdCollapsed(nextHold)) {
                ctx.api.syncCollapsedPeek();
                ctx.api.paintChrome();
            }
            ctx.api.syncActiveNoteHeader();
        }
    });
    window.addEventListener("pointermove", (event) => {
        ctx.pointer.cursorPoint = { x: event.clientX, y: event.clientY };
        ctx.pointer.cursorKnown = true;
        if (ctx.pointer.pressAt && event.buttons % 2 === 1) {
            const dx = event.clientX - ctx.pointer.pressAt.x;
            const dy = event.clientY - ctx.pointer.pressAt.y;
            ctx.pointer.pressTravel = Math.max(ctx.pointer.pressTravel, Math.hypot(dx, dy));
        }
        if (ctx.fold.hostCollapsed || ctx.dom.stack) {
            ctx.api.syncCollapsedPeek();
        }
    });
    window.addEventListener("pointerup", () => {
        finishSnapDrag();
    });
    if (inTauri() && !isPreviewWindow()) {
        void getCurrentWindow()
            .listen<ScreenEdgeCue>("screen-edges", (event) => {
            paintScreenEdges(event.payload);
        })
            .then(() => invoke("sync_screen_edges", { label: getCurrentWindow().label }))
            .catch((error: unknown) => {
            console.error(error);
        });
        void getCurrentWindow().listen<[
            number,
            number
        ] | null>("window-cursor", (event) => {
            ctx.pointer.cursorKnown = true;
            ctx.pointer.cursorPoint = event.payload ? { x: event.payload[0], y: event.payload[1] } : null;
            if (!ctx.pointer.cursorPoint && ctx.fold.autoOpenNewSection !== null) {
                ctx.api.dismissAutoOpenNewSection();
                ctx.api.paintChrome();
            }
            ctx.api.syncCollapsedPeek();
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
                ctx.deps.card.classList.toggle("dropping", !section);
                ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((s) => {
                    s.classList.toggle("dropping", s === section);
                });
                return;
            }
            if (payload.type === "leave") {
                ctx.deps.card.classList.remove("dropping");
                ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note.dropping").forEach((s) => {
                    s.classList.remove("dropping");
                });
                return;
            }
            if (payload.type === "drop") {
                ctx.deps.card.classList.remove("dropping");
                ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note.dropping").forEach((s) => {
                    s.classList.remove("dropping");
                });
                const factor = window.devicePixelRatio || 1;
                const x = payload.position.x / factor;
                const y = payload.position.y / factor;
                const el = document.elementFromPoint(x, y);
                const targetSection = el?.closest<HTMLElement>(".stack-note") ?? ctx.api.activeStackSection()?.section ?? null;
                void (async () => {
                    for (const path of payload.paths) {
                        try {
                            const md = await invoke<string>("save_media_file", { path });
                            ctx.deps.editor.insertSnippet(md, targetSection);
                        }
                        catch (error) {
                            console.error(error);
                        }
                    }
                })();
            }
        });
    }
    if (ctx.dom.frame && typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => {
            ctx.api.syncHeaderCompact();
            resizeAllBlockTextareas();
            if (ctx.size.sizingWindow || !ctx.pointer.resizing || !ctx.pointer.resizingVertical) {
                return;
            }
            ctx.api.rememberOpenSlice();
        });
        observer.observe(ctx.dom.frame);
    }
}

  return { dragBlocked, startWindowDrag, wireChrome };
}
