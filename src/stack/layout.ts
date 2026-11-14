import { inTauri, isPreviewWindow } from "../platform";
import { NOTE_BAR, type SectionState, type StackCtx, WINDOW_BAR } from "./context";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function mountLayout(ctx: StackCtx) {
function setHostCollapsedFlag(collapsed: boolean) {
    ctx.fold.hostCollapsed = collapsed;
}

function isElementHovered(el: HTMLElement | null | undefined): boolean {
    if (!el) {
        return false;
    }
    if (ctx.pointer.cursorPoint) {
        const rect = el.getBoundingClientRect();
        const bottom = Math.max(rect.bottom, rect.top + NOTE_BAR);
        return (ctx.pointer.cursorPoint.x >= rect.left &&
            ctx.pointer.cursorPoint.x <= rect.right &&
            ctx.pointer.cursorPoint.y >= rect.top &&
            ctx.pointer.cursorPoint.y <= bottom);
    }
    if (ctx.pointer.cursorKnown) {
        return false;
    }
    return el.matches(":hover");
}

function dismissAutoOpenNewSection() {
    if (ctx.fold.autoOpenNewSection === null) {
        return;
    }
    const id = ctx.fold.autoOpenNewSection;
    ctx.fold.autoOpenNewSection = null;
    if (ctx.fold.editingHoldSection === id) {
        ctx.fold.editingHoldSection = null;
    }
    const section = ctx.dom.stack?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
    if (document.activeElement instanceof HTMLElement && section?.contains(document.activeElement)) {
        document.activeElement.blur();
    }
}

function syncActiveNoteHeader() {
    const winFocused = document.hasFocus();
    const activeEl = document.activeElement;
    let activeKey: string | null = null;
    if (winFocused) {
        if (activeEl instanceof Element) {
            const section = activeEl.closest<HTMLElement>(".stack-note");
            if (section?.dataset.id) {
                activeKey = section.dataset.id;
            }
            else if (ctx.deps.card.contains(activeEl)) {
                activeKey = "host";
            }
        }
        if (!activeKey) {
            activeKey = ctx.fold.lastActiveSection;
        }
    }
    ctx.deps.card.classList.toggle("is-editing", activeKey === "host");
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        section.classList.toggle("is-editing", Boolean(activeKey && section.dataset.id === activeKey));
    });
}

function hostBarOnly(): boolean {
    return ctx.fold.hostCollapsed && !ctx.fold.hostHover && ctx.fold.editingHoldSection !== "host";
}

function sectionBarOnly(id: string | undefined, state: SectionState): boolean {
    return state.collapsed && !state.hover && ctx.fold.editingHoldSection !== id;
}

function holdCollapsed(id: string): boolean {
    if (ctx.fold.editingHoldSection === id) {
        return false;
    }
    ctx.fold.editingHoldSection = id;
    return true;
}

function hasStack(): boolean {
    return ctx.dom.stack != null && ctx.dom.stack.childElementCount > 0;
}

function stackCounts(): {
    opens: number;
    bars: number;
} {
    let opens = hostBarOnly() ? 0 : 1;
    let bars = hostBarOnly() ? 1 : 0;
    if (hasStack()) {
        for (const [id, state] of ctx.notes.entries()) {
            if (sectionBarOnly(id, state)) {
                bars += 1;
            }
            else {
                opens += 1;
            }
        }
    }
    return { opens, bars };
}

function targetWindowHeight(): number {
    const chrome = 56;
    if (!hasStack()) {
        return hostBarOnly() ? WINDOW_BAR : Math.max(196, Math.round(chrome + ctx.size.openNoteHeight));
    }
    const { opens, bars } = stackCounts();
    return Math.round(chrome + opens * ctx.size.openNoteHeight + bars * NOTE_BAR);
}

function applyOpenHeight() {
    document.documentElement.style.setProperty("--open-h", `${Math.round(ctx.size.openNoteHeight)}px`);
    document.documentElement.style.setProperty("--bar-h", `${NOTE_BAR}px`);
}

function rememberOpenSlice() {
    const box = ctx.dom.frame?.clientHeight ?? 0;
    if (box < NOTE_BAR || ctx.size.sizingWindow) {
        return;
    }
    const { opens, bars } = stackCounts();
    if (opens <= 0) {
        return;
    }
    const available = Math.max(140 * opens, box - bars * NOTE_BAR);
    const slice = Math.max(140, Math.round(available / opens));
    ctx.size.openNoteHeight = slice;
    ctx.size.savedHostHeight = 56 + slice;
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
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
    }
    catch {
        return window.innerHeight;
    }
}

async function setLogicalHeight(height: number) {
    if (!inTauri()) {
        return;
    }
    ctx.size.sizingWindow = true;
    clearTimeout(ctx.size.sizingTimer);
    try {
        await invoke("set_window_height", {
            label: getCurrentWindow().label,
            height: Math.max(96, Math.round(height)),
        });
    }
    finally {
        ctx.size.sizingTimer = window.setTimeout(() => {
            ctx.size.sizingWindow = false;
        }, 220);
    }
}

function cancelHeightTween() {
    ctx.size.tweenTicket += 1;
    clearTimeout(ctx.size.heightTween);
}

function tweenWindowHeight(target: number) {
    cancelHeightTween();
    const ticket = ctx.size.tweenTicket;
    void logicalHeight().then((from) => {
        if (ticket !== ctx.size.tweenTicket) {
            return;
        }
        if (Math.abs(target - from) <= 2) {
            void setLogicalHeight(target);
            return;
        }
        const began = performance.now();
        const step = () => {
            if (ticket !== ctx.size.tweenTicket) {
                return;
            }
            const t = Math.min(1, (performance.now() - began) / 160);
            const eased = 1 - (1 - t) ** 3;
            void setLogicalHeight(Math.round(from + (target - from) * eased));
            if (t < 1) {
                ctx.size.heightTween = window.setTimeout(step, 16);
            }
        };
        ctx.size.heightTween = window.setTimeout(step, 16);
    });
}

function syncHeaderCompact() {
    for (const header of document.querySelectorAll<HTMLElement>("#card > header, .stack-note > header")) {
        const parent = header.parentElement;
        const isBar = (parent === ctx.deps.card && hostBarOnly()) || Boolean(parent?.classList.contains("is-bar"));
        if (isBar) {
            header.classList.remove("compact-meta", "compact-tools");
            continue;
        }
        const headerW = header.clientWidth || ctx.deps.card.clientWidth || (ctx.dom.frame?.clientWidth ?? window.innerWidth - 48);
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

function paintChrome() {
    const hostOpen = ctx.fold.hostCollapsed && !hostBarOnly();
    document.documentElement.classList.toggle("collapsed", ctx.fold.hostCollapsed);
    document.documentElement.classList.toggle("hover-open", hostOpen);
    const hostFoldBtn = document.querySelector<HTMLButtonElement>("#fold-toggle");
    if (hostFoldBtn) {
        const label = ctx.fold.hostCollapsed ? "Unfold memo" : "Fold memo";
        hostFoldBtn.title = label;
        hostFoldBtn.setAttribute("aria-label", label);
        hostFoldBtn.setAttribute("aria-pressed", String(ctx.fold.hostCollapsed));
    }
    ctx.dom.frame?.classList.toggle("has-stack", hasStack());
    ctx.deps.card.classList.toggle("is-bar", hasStack() && hostBarOnly());
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
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
                ctx.api.paintSectionColor(section, state);
            }
        }
    });
    ctx.deps.editor.syncTitle();
    ctx.deps.look.paintThemeIcon();
    syncActiveNoteHeader();
    syncHeaderCompact();
    applyOpenHeight();
    if (!inTauri() || isPreviewWindow()) {
        return;
    }
    const { opens, bars } = stackCounts();
    const signature = `${opens}:${bars}:${hasStack() ? 1 : 0}`;
    const first = ctx.size.chromeSignature === null;
    if (ctx.size.chromeSignature === signature) {
        return;
    }
    ctx.size.chromeSignature = signature;
    if (first) {
        return;
    }
    tweenWindowHeight(hasStack() ? targetWindowHeight() : hostBarOnly() ? WINDOW_BAR : ctx.size.savedHostHeight);
}

async function setHostCollapsed(collapsed: boolean) {
    if (ctx.fold.hostCollapsed === collapsed) {
        return;
    }
    if (collapsed && !hasStack()) {
        ctx.size.savedHostHeight = await logicalHeight();
        rememberOpenSlice();
    }
    ctx.fold.hostCollapsed = collapsed;
    ctx.fold.hostHover = false;
    ctx.fold.suppressHostHover = collapsed && isElementHovered(ctx.deps.card);
    if (collapsed && ctx.fold.editingHoldSection === "host") {
        ctx.fold.editingHoldSection = null;
    }
    const id = ctx.deps.pinnedNoteId || ctx.deps.session.editingId();
    if (id && inTauri()) {
        await invoke("set_collapsed", { id, collapsed: ctx.fold.hostCollapsed }).catch((error: unknown) => {
            console.error(error);
        });
    }
    paintChrome();
}

function syncCollapsedPeek() {
    let changed = false;
    if (ctx.fold.hostCollapsed) {
        const over = isElementHovered(ctx.deps.card);
        if (!over && ctx.fold.suppressHostHover) {
            ctx.fold.suppressHostHover = false;
        }
        const next = over && !ctx.fold.suppressHostHover;
        if (next && ctx.fold.autoOpenNewSection !== null && ctx.fold.autoOpenNewSection !== "host") {
            dismissAutoOpenNewSection();
            changed = true;
        }
        if (next !== ctx.fold.hostHover) {
            ctx.fold.hostHover = next;
            changed = true;
        }
    }
    else if (ctx.fold.hostHover) {
        ctx.fold.hostHover = false;
        ctx.fold.suppressHostHover = false;
        changed = true;
    }
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
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
        if (next && ctx.fold.autoOpenNewSection !== null && ctx.fold.autoOpenNewSection !== id) {
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
        ctx.api.paintSectionColor(section, state);
        changed = true;
    });
    if (changed) {
        paintChrome();
    }
}

function activeStackSection(): {
    section: HTMLElement;
    state: SectionState;
} | null {
    const active = document.activeElement;
    if (active instanceof Element) {
        const section = active.closest<HTMLElement>(".stack-note");
        const id = section?.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
        if (section && state) {
            return { section, state };
        }
        if (ctx.deps.card.contains(active)) {
            return null;
        }
    }
    if (ctx.fold.lastActiveSection && ctx.fold.lastActiveSection !== "host") {
        const section = ctx.dom.stack?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(ctx.fold.lastActiveSection)}"]`);
        const state = ctx.notes.get(ctx.fold.lastActiveSection);
        if (section && state) {
            return { section, state };
        }
    }
    if (ctx.fold.lastActiveSection === "host") {
        return null;
    }
    const hovered = [...(ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note") ?? [])].find((section) => isElementHovered(section));
    const id = hovered?.dataset.id;
    const state = id ? ctx.notes.get(id) : undefined;
    if (hovered && state) {
        return { section: hovered, state };
    }
    return null;
}

async function toggleSection(id: string) {
    const state = ctx.notes.get(id);
    if (!state) {
        return;
    }
    state.collapsed = !state.collapsed;
    state.hover = false;
    if (state.collapsed && ctx.fold.editingHoldSection === id) {
        ctx.fold.editingHoldSection = null;
    }
    if (state.collapsed && ctx.fold.autoOpenNewSection === id) {
        ctx.fold.autoOpenNewSection = null;
    }
    const section = ctx.dom.stack?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
    state.suppressHover = state.collapsed && isElementHovered(section);
    const isBar = sectionBarOnly(id, state);
    section?.classList.toggle("is-bar", isBar);
    section?.classList.toggle("hover-open", state.collapsed && !isBar);
    paintChrome();
    await invoke("set_collapsed", { id, collapsed: state.collapsed }).catch((error: unknown) => {
        console.error(error);
    });
}

  return { setHostCollapsedFlag, isElementHovered, dismissAutoOpenNewSection, syncActiveNoteHeader, hostBarOnly, sectionBarOnly, holdCollapsed, hasStack, stackCounts, targetWindowHeight, applyOpenHeight, rememberOpenSlice, logicalHeight, setLogicalHeight, cancelHeightTween, syncHeaderCompact, paintChrome, setHostCollapsed, syncCollapsedPeek, activeStackSection, toggleSection };
}
