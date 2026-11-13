import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { createAppBackend } from "./app/backend";
import { createAudienceController } from "./app/controllers/audience-controller";
import { createEditorController } from "./app/controllers/editor-controller";
import {
  createInputController,
  type InputController,
  type MouseChordPayload,
  type StackInput,
} from "./app/controllers/input-controller";
import { createLookController, type LookController } from "./app/controllers/look-controller";
import { createRecentController, type RecentController } from "./app/controllers/recent-controller";
import { createSessionController, type SessionController } from "./app/controllers/session-controller";
import { createAppContext } from "./app/context";
import { createAppState } from "./app/state";
import { memoUsesCoder, type EditorPrefs } from "./editor/editor-field";
import { restoreCaret } from "./editor/history";
import { bindMediaEditor } from "./media/media-dnd";
import { initLightbox } from "./media/media-elements";
import type { ThemeName } from "./look/memo-chrome";
import { inTauri, isPreviewWindow } from "./platform";
import type { ShortcutBinds } from "./shortcuts";
import {
  activeStackSection,
  applySectionEdit,
  applyStackEditorChrome,
  bindStack,
  dragBlocked,
  insertSectionMedia,
  loadStack,
  mediaMutatorForSection,
  paintChrome,
  paintSectionAudience,
  redoSection,
  rerenderStackEditors,
  sectionAreaSelection,
  sectionTargetArea,
  syncHeaderCompact,
  setHostCollapsedFlag,
  stackEl,
  stackState,
  startWindowDrag,
  syncCollapsedPeek,
  toggleSectionPreview,
  resumeStackEditor,
  undoSection,
  wireChrome,
} from "./stack";

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
const appBackend = createAppBackend();
const appContext = createAppContext({
  kind: isPreviewWindow() ? "preview" : pinnedNoteId ? "pinned" : "composer",
  pinnedNoteId,
  pinnedThemeHint,
}, appBackend);
const appState = createAppState();
const recentState = appState.recent;
let lookController!: LookController;
let recentController!: RecentController;
let sessionController!: SessionController;
let inputController!: InputController;
const {
  card: cardEl,
  blocks: blocksEl,
  lightbox: lightboxEl,
  lightboxImage: lightboxImageEl,
} = appContext.dom;

const editorController = createEditorController(
  appContext,
  appState.editor,
  {
    currentNoteId: () => sessionController.currentNoteId(),
    placeKey: () => sessionController.placeKey(),
    isNewMemo: () => sessionController.isNewMemo(),
  },
  {
    scheduleDraft: () => sessionController.scheduleDraft(),
  },
  {
    dismissRecent: () => recentController.dismiss(),
  },
  {
    usesCoder: () => memoUsesCoder(lookController.value().coder),
  },
  {
    gestureActive: (event) => inputController.gestureActive(event),
    previewShortcut: () => inputController.previewShortcut(),
  },
  {
    activeSection: () => activeStackSection()?.section ?? null,
    resumeActiveEditor: () => Boolean(pinnedNoteId && resumeStackEditor()),
    toggleActivePreview: () => {
      const target = activeStackSection();
      if (!target) {
        return false;
      }
      toggleSectionPreview(target.section);
      return true;
    },
    insertMedia: insertSectionMedia,
    applyEditorChrome: applyStackEditorChrome,
  },
);

const audienceController = createAudienceController(
  appContext,
  appState.audience,
  {
    currentNoteId: () => sessionController.currentNoteId(),
    isNewMemo: () => sessionController.isNewMemo(),
  },
  {
    hasCustomHue: () => {
      const look = lookController.value();
      return look.hueLight != null || look.hueDark != null;
    },
    applySpaceDefault(hue) {
      lookController.applySpaceDefault(hue);
    },
  },
  {
    syncHeader: syncHeaderCompact,
    repaintSections() {
      stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? stackState.get(id) : undefined;
        if (state) {
          paintSectionAudience(section, state);
        }
      });
    },
  },
);
lookController = createLookController(
  appContext,
  appState.look,
  editorController,
  {
    currentNoteId: () => sessionController.currentNoteId(),
    showingPinned: () => sessionController.showingPinned(),
  },
  {
    altHeld: () => inputController.altHeld(),
  },
);

recentController = createRecentController(
  appContext,
  recentState,
  {
    open: (note) => sessionController.openRecent(note),
    currentId: () => sessionController.currentComposerId(),
    selectedId: () => sessionController.selectedId(),
    isEmptyNewMemo: editorController.isEmptyNewMemo,
    focusEditor: editorController.focus,
  },
  {
    updateFromRecent: (note) => audienceController.updateFromRecent(note),
  },
);

sessionController = createSessionController(
  appContext,
  appState.session,
  editorController,
  audienceController,
  lookController,
  recentController,
  {
    focusNote(id) {
      const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
      const state = stackState.get(id);
      if (!section || !state) {
        return false;
      }
      const blocks = section.querySelector(".stack-blocks");
      if (blocks && state.caret) {
        restoreCaret(blocks, state.caret);
        return true;
      }
      sectionTargetArea(section, state)?.focus();
      return true;
    },
    setHostCollapsed: setHostCollapsedFlag,
    load: loadStack,
    paintChrome,
  },
);

const stackInput: StackInput = {
  activeSection: () => activeStackSection()?.section ?? null,
  insertPlainText(text, section) {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!state) {
      return;
    }
    const area = sectionTargetArea(section, state);
    if (!area) {
      return;
    }
    const { start, end } = sectionAreaSelection(area, state);
    const value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
    const cursor = start + text.length;
    applySectionEdit(section, state, area, { value, start: cursor, end: cursor });
  },
  undo(section) {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    return Boolean(state && undoSection(section, state));
  },
  redo(section) {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    return Boolean(state && redoSection(section, state));
  },
  dragBlocked,
  startWindowDrag,
  syncCollapsedPeek,
  refreshPreviewShortcut(shortcut) {
    stackEl?.querySelectorAll<HTMLButtonElement>(".stack-note .mode-toggle").forEach((btn) => {
      const open = btn.getAttribute("aria-pressed") === "true";
      btn.title = open ? `Edit (${shortcut})` : `Preview (${shortcut})`;
    });
  },
};

inputController = createInputController(
  appContext,
  appState.input,
  editorController,
  sessionController,
  recentController,
  audienceController,
  lookController,
  stackInput,
);

bindStack({
  cardEl,
  pinnedNoteId,
  getLook: lookController.value,
  getAltHeld: inputController.altHeld,
  getKnownSpaces: audienceController.knownSpaces,
  getDefaultVisibility: audienceController.defaultVisibility,
  getEditingId: () => sessionController.editingId(),
  currentTheme: lookController.currentTheme,
  previewShortcut: inputController.previewShortcut,
  openPreview: (name) => {
    void editorController.openPreview(name);
  },
  insertSnippet: editorController.insertSnippet,
  attachFiles: editorController.attachFiles,
  syncNoteTitle: editorController.syncTitle,
  paintThemeIcon: lookController.paintThemeIcon,
});
bindMediaEditor({
  hostContainer: blocksEl,
  host: editorController.mediaHost,
  forSection: mediaMutatorForSection,
  openPreview: (name) => {
    void editorController.openPreview(name);
  },
});
wireChrome();

if (inTauri() && !isPreviewWindow()) {
  void appBackend
    .getShortcuts()
    .then(inputController.applyShortcuts)
    .catch((error: unknown) => {
      console.error(error);
    });
  void listen<ShortcutBinds>("shortcuts-changed", (event) => {
    inputController.applyShortcuts(event.payload);
  });
  void listen<MouseChordPayload>("mouse-chord", (event) => {
    inputController.handleMouseChord(event.payload);
  });
}

lookController.applyPinnedThemeHint();

editorController.renderSurface();

if (inTauri() && !isPreviewWindow()) {
  const applyEditorPrefs = (settings: EditorPrefs) => {
    if (editorController.applyPrefs(settings)) {
      rerenderStackEditors();
    }
  };
  void appBackend
    .getEditorPrefs()
    .then(applyEditorPrefs)
    .catch((error: unknown) => {
      console.error(error);
    });
  void listen<EditorPrefs>("editor-prefs-changed", (event) => {
    applyEditorPrefs(event.payload);
  });
}

if (inTauri() && !isPreviewWindow()) {
  lookController.watchSwatches();
  void listen<number>("pinned-opacity", (event) => {
    lookController.acceptPinnedOpacity(event.payload);
  });
}

if (isPreviewWindow()) {
  void initLightbox(lightboxEl, lightboxImageEl).catch((error: unknown) => {
    console.error(error);
  });
} else if (pinnedNoteId && inTauri()) {
  void audienceController.load().catch((error: unknown) => {
    console.error(error);
  });
  void listen("settings-changed", () => {
    void audienceController.load().catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen("spaces-changed", () => {
    void audienceController.load().catch((error: unknown) => {
      console.error(error);
    });
  });
  void sessionController.loadPinned(pinnedNoteId).catch((error: unknown) => {
    console.error(error);
  });
  void getCurrentWindow().listen<string>("show-pin", (event) => {
    if (event.payload !== pinnedNoteId) {
      return;
    }
    void sessionController.loadPinned(pinnedNoteId)
      .then(() => editorController.resumePlace())
      .catch((error: unknown) => {
        console.error(error);
      });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      editorController.rememberPlace();
    } else {
      editorController.resumePlace();
    }
  });
  void listen("notes-changed", () => {
    editorController.rememberPlace();
    void sessionController.loadPinned(pinnedNoteId)
      .then(() => editorController.resumePlace())
      .catch((error: unknown) => {
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
    void sessionController.focusComposer(event.payload);
  });

  void listen("notes-changed", () => {
    recentController.scheduleRefresh();
  });

  void listen("settings-changed", () => {
    void audienceController.load().catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen("spaces-changed", () => {
    void audienceController.load().catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen<number>("composer-fresh", (event) => {
    void sessionController.startFresh(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });
  window.addEventListener("focus", () => {
    if (editorController.isPreviewing()) {
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      return;
    }
    editorController.focus();
  });

  void listen<number>("composer-cycle", (event) => {
    void sessionController.cycleComposer(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      editorController.rememberPlace();
    }
  });

  void listen<number>("composer-flush", (event) => {
    void sessionController.flushComposer(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });

  void lookController.loadTheme().catch((error: unknown) => {
    console.error(error);
  });
  void audienceController.load().catch((error: unknown) => {
    console.error(error);
  });
}
