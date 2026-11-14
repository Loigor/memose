import { audienceChoice, revealPressedChoice } from "../look/audience-ui";
import { syncIcon } from "../look/sync-status";
import { isOfflinePrivate, visibilityOptions, visibilityShort } from "../look/visibility";
import type { SectionState, StackCtx } from "./context";
import { invoke } from "@tauri-apps/api/core";

export function mountAudience(ctx: StackCtx) {
function paintSectionAudience(section: HTMLElement, state: SectionState) {
    const id = section.dataset.id;
    if (!id) {
        return;
    }
    let visibility = state.visibility || ctx.deps.audience.defaultVisibility() || "PRIVATE";
    if (!visibilityOptions.some((option) => option.value === visibility)) {
        visibility = "PRIVATE";
    }
    const space = isOfflinePrivate(visibility) ? "" : state.space || "";
    state.visibility = visibility;
    state.space = space;
    const label = section.querySelector<HTMLButtonElement>(".visibility-label");
    if (label) {
        label.hidden = false;
        label.textContent = visibilityShort(visibility, space, ctx.deps.audience.spaces());
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
        if (option.value === "SPACE" && ctx.deps.audience.spaces().length === 0) {
            continue;
        }
        visChoices.append(audienceChoice(option.label, option.hint, state.visibility === option.value, () => {
            state.visibility = option.value;
            if (isOfflinePrivate(option.value)) {
                state.space = "";
                state.syncState = "local";
                state.lastError = null;
            }
            else if (option.value === "SPACE" && state.space === "" && ctx.deps.audience.spaces()[0]) {
                state.space = ctx.deps.audience.spaces()[0].name;
            }
            paintSectionAudience(section, state);
            void invoke("set_note_audience", {
                id,
                visibility: state.visibility,
                space: state.space,
            }).catch((error: unknown) => {
                console.error(error);
            });
        }));
    }
    spaceChoices.replaceChildren();
    spaceBlock.hidden = ctx.deps.audience.spaces().length === 0 || isOfflinePrivate(state.visibility);
    if (spaceBlock.hidden) {
        return;
    }
    spaceChoices.append(audienceChoice("Unassigned", "", state.space === "", () => {
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
    }));
    for (const item of ctx.deps.audience.spaces()) {
        spaceChoices.append(audienceChoice(item.title, item.synced === false ? "Not on server" : "", state.space === item.name, () => {
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
        }));
    }
    if (pop && !pop.hidden) {
        revealPressedChoice(spaceChoices);
    }
    ctx.api.syncHeaderCompact();
}

  return { paintSectionAudience };
}
