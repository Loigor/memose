import { memoUsesCoder } from "../editor/editor-field";
import { paintSurface, paintThemeButton, paperAt, type ThemeName } from "../look/memo-chrome";
import { hueSwatches, onHueSwatches } from "../look/swatches";
import type { SectionState, StackCtx } from "./context";
import { invoke } from "@tauri-apps/api/core";

export function mountLook(ctx: StackCtx) {
function sectionTheme(state: SectionState): ThemeName {
    return state.theme ?? ctx.deps.look.theme();
}

function sectionHue(state: SectionState): number | null {
    const theme = sectionTheme(state);
    return theme === "dark" ? state.hueDark : state.hueLight;
}

function paintSectionColor(section: HTMLElement, state: SectionState) {
    const theme = sectionTheme(state);
    paintSurface(section, theme, sectionHue(state), ctx.deps.look.value().opacity);
    const button = section.querySelector<HTMLElement>(".theme-toggle");
    const icon = section.querySelector(".theme-icon");
    if (button && icon) {
        paintThemeButton(button, icon, theme, !ctx.deps.look.altHeld());
    }
    paintSectionCoder(section, state);
}

function paintSectionCoder(section: HTMLElement, state: SectionState) {
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

function applyStackEditorChrome() {
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
        if (state) {
            paintSectionCoder(section, state);
        }
    });
}

function repaintStackColors() {
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
        if (state) {
            paintSectionColor(section, state);
        }
    });
}

function saveSectionLook(id: string, state: SectionState) {
    void invoke("save_look", {
        id,
        opacity: ctx.deps.look.value().opacity,
        hueLight: state.hueLight,
        hueDark: state.hueDark,
        swatches: state.swatches,
        theme: state.theme,
        coder: state.coder,
    }).catch((error: unknown) => {
        console.error(error);
    });
}

function setSectionHue(section: HTMLElement, state: SectionState, hue: number) {
    if (sectionTheme(state) === "dark") {
        state.hueDark = hue;
    }
    else {
        state.hueLight = hue;
    }
    paintSectionColor(section, state);
    paintSectionSlots(section, state);
    const id = section.dataset.id;
    if (id) {
        saveSectionLook(id, state);
    }
}

function paintSectionSlots(section: HTMLElement, state: SectionState) {
    const theme = sectionTheme(state);
    const current = sectionHue(state);
    const swatches = hueSwatches();
    const slots = [...section.querySelectorAll<HTMLButtonElement>(".hue-slot")];
    slots.forEach((slot, index) => {
        const hue = swatches[index];
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
        add.disabled = swatches.length >= 6 || swatches.includes(hue);
        slider.style.setProperty("--thumb", paperAt(theme, current ?? hue));
    }
}
onHueSwatches(() => {
    ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
        if (state) {
            paintSectionSlots(section, state);
        }
    });
});
  return { sectionTheme, sectionHue, paintSectionColor, paintSectionCoder, applyStackEditorChrome, repaintStackColors, saveSectionLook, setSectionHue, paintSectionSlots };
}
