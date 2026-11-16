import { audienceChoice, revealPressedChoice } from "../../look/audience-ui";
import { syncIcon } from "../../look/sync-status";
import { isOfflinePrivate, visibilityOptions, visibilityShort } from "../../look/visibility";
import type { Note } from "../../types";
import type { AppContext } from "../context";
import type { AudienceState } from "../state";

export interface AudienceSession {
  currentNoteId(): string | null;
  isNewMemo(): boolean;
}

export interface AudienceLook {
  hasCustomHue(): boolean;
  applySpaceDefault(hue: number | null): void;
}

export interface AudienceStack {
  syncHeader(): void;
  repaintSections(): void;
}

export interface AudienceController {
  isDirty(): boolean;
  selectedSpace(): string;
  knownSpaces(): AudienceState["knownSpaces"];
  defaultVisibility(): string;
  paint(note: Note | null): void;
  load(): Promise<void>;
  save(id: string): Promise<void>;
  applySpaceDefault(space: string): void;
  updateFromRecent(note: Note): void;
  refreshMeta(): void;
  closePopover(): void;
  resetDeleteConfirm(): void;
}

export function createAudienceController(
  context: AppContext,
  state: AudienceState,
  session: AudienceSession,
  look: AudienceLook,
  stack: AudienceStack,
): AudienceController {
  const {
    visibilityLabel,
    noteSync,
    audiencePop,
    visibilityChoices,
    spaceBlock,
    spaceChoices,
    editedSep,
    editedAt,
    deleteConfirm,
    deleteNote,
    deleteYes,
  } = context.dom;

  function paintNoteSync() {
    const icon = syncIcon(state.syncState, state.visibility);
    noteSync.hidden = visibilityLabel.hidden;
    noteSync.innerHTML = icon.svg;
    noteSync.title = state.syncError ?? icon.label;
  }

  function refreshMeta() {
    editedSep.hidden = visibilityLabel.hidden || editedAt.hidden;
    paintNoteSync();
    stack.syncHeader();
  }

  function paintMenu() {
    visibilityChoices.replaceChildren();
    for (const option of visibilityOptions) {
      if (option.value === "SPACE" && state.knownSpaces.length === 0) {
        continue;
      }
      visibilityChoices.append(
        audienceChoice(option.label, option.hint, state.visibility === option.value, () => {
          chooseVisibility(option.value);
        }),
      );
    }
    spaceChoices.replaceChildren();
    spaceBlock.hidden = state.knownSpaces.length === 0 || isOfflinePrivate(state.visibility);
    if (spaceBlock.hidden) {
      return;
    }
    spaceChoices.append(
      audienceChoice("Unassigned", "", state.space === "", () => {
        chooseSpace("");
      }),
    );
    for (const space of state.knownSpaces) {
      spaceChoices.append(
        audienceChoice(
          space.title,
          space.synced === false ? "Not on server" : "",
          state.space === space.name,
          () => {
            chooseSpace(space.name);
          },
        ),
      );
    }
    if (!audiencePop.hidden) {
      revealPressedChoice(spaceChoices);
    }
  }

  function applySpaceDefault(space: string) {
    if (!session.isNewMemo()) {
      return;
    }
    const savedHue = state.knownSpaces.find((item) => item.name === space)?.hue;
    look.applySpaceDefault(typeof savedHue === "number" ? savedHue : null);
  }

  function paint(note: Note | null) {
    state.painted = true;
    let visibility = note?.visibility || state.defaultVisibility || "PRIVATE";
    if (!visibilityOptions.some((option) => option.value === visibility)) {
      visibility = "PRIVATE";
    }
    if (visibility === "SPACE" && state.knownSpaces.length === 0 && !note?.visibility) {
      visibility = "PRIVATE";
    }
    state.visibility = visibility;
    state.space = isOfflinePrivate(visibility)
      ? ""
      : (note?.space ?? (note?.visibility ? "" : state.defaultSpace));
    state.syncState = note?.syncState || "local";
    state.syncError = note?.lastError ?? null;
    visibilityLabel.hidden = false;
    visibilityLabel.textContent = visibilityShort(state.visibility, state.space, state.knownSpaces);
    paintMenu();
    refreshMeta();
    state.dirty = false;
    if (!note && !look.hasCustomHue()) {
      applySpaceDefault(state.space);
    }
  }

  function chooseVisibility(value: string) {
    state.visibility = value;
    if (isOfflinePrivate(value)) {
      state.space = "";
      state.syncState = "local";
      state.syncError = null;
    } else if (value === "SPACE" && state.space === "" && state.knownSpaces[0]) {
      state.space = state.knownSpaces[0].name;
    }
    if (!isOfflinePrivate(value) && state.syncState === "local" && state.syncEnabled) {
      state.syncState = "pending";
    }
    visibilityLabel.textContent = visibilityShort(state.visibility, state.space, state.knownSpaces);
    paintMenu();
    paintNoteSync();
    persist();
    applySpaceDefault(state.space);
  }

  function chooseSpace(value: string) {
    state.space = value;
    if (isOfflinePrivate(state.visibility)) {
      state.visibility = "PRIVATE";
    } else if (value === "" && state.visibility === "SPACE") {
      state.visibility = "PRIVATE";
    }
    visibilityLabel.textContent = visibilityShort(state.visibility, state.space, state.knownSpaces);
    paintMenu();
    paintNoteSync();
    persist();
    applySpaceDefault(state.space);
  }

  function persist() {
    state.dirty = true;
    const id = session.currentNoteId();
    if (!id) {
      return;
    }
    void save(id).catch((error: unknown) => {
      console.error(error);
    });
  }

  async function load() {
    try {
      const settings = await context.backend.getAudienceSettings();
      state.syncEnabled = settings.baseUrl.trim() !== "";
      state.defaultVisibility = settings.visibility || "PRIVATE";
      state.defaultSpace = settings.space || "";
      state.knownSpaces = state.syncEnabled ? await context.backend.listMemoSpaces() : [];
    } catch (error) {
      console.error(error);
      state.syncEnabled = false;
      state.knownSpaces = [];
    }
    if (!state.painted || (context.mode.kind === "composer" && session.isNewMemo() && !state.dirty)) {
      paint(null);
      return;
    }
    visibilityLabel.hidden = false;
    visibilityLabel.textContent = visibilityShort(state.visibility, state.space, state.knownSpaces);
    paintMenu();
    refreshMeta();
    stack.repaintSections();
  }

  async function save(id: string) {
    state.dirty = false;
    await context.backend.setNoteAudience(id, state.visibility, state.space);
  }

  function updateFromRecent(note: Note) {
    state.syncState = note.syncState;
    state.syncError = note.lastError ?? null;
    if (note.visibility) {
      state.visibility = note.visibility;
    }
    paintNoteSync();
  }

  function resetDeleteConfirm() {
    deleteNote.hidden = false;
    deleteConfirm.hidden = true;
    deleteYes.textContent = "Delete";
  }

  function closePopover() {
    audiencePop.hidden = true;
    visibilityLabel.setAttribute("aria-expanded", "false");
    resetDeleteConfirm();
  }

  visibilityLabel.addEventListener("click", () => {
    if (audiencePop.hidden) {
      resetDeleteConfirm();
      audiencePop.hidden = false;
      visibilityLabel.setAttribute("aria-expanded", "true");
      revealPressedChoice(spaceChoices);
      return;
    }
    closePopover();
  });

  return {
    isDirty: () => state.dirty,
    selectedSpace: () => state.space,
    knownSpaces: () => state.knownSpaces,
    defaultVisibility: () => state.defaultVisibility,
    paint,
    load,
    save,
    applySpaceDefault,
    updateFromRecent,
    refreshMeta,
    closePopover,
    resetDeleteConfirm,
  };
}
