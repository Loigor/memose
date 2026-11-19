import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { mountAiWhenEnabled } from "./ai/gate";
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
import { createAppContext, type LookHint } from "./app/context";
import { createAppState } from "./app/state";
import { memoUsesCoder, type EditorPrefs } from "./editor/editor-field";
import { noteTitle } from "./editor/markdown-edit";
import { resizeAllBlockTextareas } from "./editor/textarea";
import { bindMediaEditor } from "./media/media-dnd";
import { initLightbox } from "./media/media-elements";
import { isStoredHue, type ThemeName } from "./look/memo-chrome";
import { inTauri, isPreviewWindow } from "./platform";
import type { ShortcutBinds } from "./shortcuts";
import { createStackController, type StackController } from "./stack/index";

const bootScript = globalThis as {
  __memosePin?: unknown;
  __memoseTheme?: unknown;
  __memoseAppTheme?: unknown;
  __memoseLook?: unknown;
};
const pinnedFromScript = bootScript.__memosePin;
const themeName = (value: unknown): ThemeName | null => (value === "dark" || value === "light" ? value : null);
const pinnedThemeHint = themeName(bootScript.__memoseTheme);
const appThemeHint = themeName(bootScript.__memoseAppTheme);
const lookHint = readLookHint(bootScript.__memoseLook);

function readLookHint(value: unknown): LookHint | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as { hueLight?: unknown; hueDark?: unknown; opacity?: unknown };
  const hue = (hue: unknown) => (isStoredHue(hue) ? hue : null);
  const opacity = typeof raw.opacity === "number" ? Math.min(100, Math.max(0, Math.round(raw.opacity))) : 100;
  return { hueLight: hue(raw.hueLight), hueDark: hue(raw.hueDark), opacity };
}
const pinnedNoteId =
  (typeof pinnedFromScript === "string" ? pinnedFromScript : "") ||
  new URLSearchParams(window.location.search).get("pin") ||
  document.documentElement.dataset.noteId ||
  "";
if (pinnedNoteId) {
  document.documentElement.dataset.noteId = pinnedNoteId;
  // Until the memo arrives, the card shows its theme with a loading line.
  document.documentElement.classList.add("pin-window", "memo-loading");
}
const appBackend = createAppBackend();
const appContext = createAppContext(
  {
    kind: isPreviewWindow() ? "preview" : pinnedNoteId ? "pinned" : "composer",
    pinnedNoteId,
    pinnedThemeHint,
    appThemeHint,
    lookHint,
  },
  appBackend,
);
const appState = createAppState();
const recentState = appState.recent;
let lookController!: LookController;
let recentController!: RecentController;
let sessionController!: SessionController;
let inputController!: InputController;
let stack!: StackController;
const { card: cardEl, blocks: blocksEl, lightbox: lightboxEl, lightboxImage: lightboxImageEl } = appContext.dom;

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
    activeSection: () => stack.activeSectionElement(),
    resumeActiveEditor: () => Boolean(pinnedNoteId && stack.resumeEditor()),
    toggleActivePreview: () => stack.toggleActivePreview(),
    insertMedia: (section, name, label) => stack.insertMedia(section, name, label),
    applyEditorChrome: () => stack.applyEditorChrome(),
  },
);

if (!isPreviewWindow()) {
  mountAiWhenEnabled((ai) =>
    ai.mountMemoAi({
      aiAnchor: document.querySelector<HTMLElement>("#ai-anchor"),
      recAnchor: document.querySelector<HTMLElement>("#rec-anchor"),
      llm: {
        host: cardEl,
        noteId: () => sessionController.currentNoteId(),
        ensureNoteId: () => sessionController.ensureNoteId(),
        title: () => noteTitle(editorController.content()),
        text: () => editorController.content(),
        replace: (next) => editorController.replaceContent(next),
        visibility: () => appState.audience.visibility || null,
        selectionRoots: () => [blocksEl, appContext.dom.preview],
        onAvailability: () => stack.syncHeader(),
      },
      tools: {
        noteId: () => sessionController.currentNoteId(),
        roots: () => [blocksEl],
        text: () => editorController.content(),
        replace: (next) => editorController.replaceContent(next),
      },
      dictation: {
        host: cardEl,
        noteId: () => sessionController.currentNoteId(),
        text: () => editorController.content(),
        replace: (next, quiet) => editorController.replaceContent(next, quiet),
        insertAtCursor: (text) => editorController.insertPlainText(text),
        placeCaret: (offset) => editorController.placeCaret(offset),
        fieldRoots: () => [blocksEl, appContext.dom.preview],
        onAvailability: () => stack.syncHeader(),
      },
    }),
  );
}

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
    syncHeader: () => stack.syncHeader(),
    repaintSections: () => stack.repaintAudiences(),
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
  {
    hasGuests: () => stack.hasGuests(),
    repaintColors: () => stack.repaintColors(),
    activeHueTarget: () => stack.activeHueTarget(),
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
    focusNote: (id) => stack.focusNote(id),
    setHostCollapsed: (collapsed) => stack.setHostCollapsedFlag(collapsed),
    load: () => stack.load(),
    paintChrome: () => stack.paintChrome(),
  },
);

const stackInput: StackInput = {
  activeSection: () => stack.activeSectionElement(),
  insertPlainText: (text, section) => stack.insertPlainText(text, section),
  undo: (section) => stack.undo(section),
  redo: (section) => stack.redo(section),
  dragBlocked: (target) => stack.dragBlocked(target),
  startWindowDrag: (event) => stack.startWindowDrag(event),
  syncCollapsedPeek: () => stack.syncPeek(),
  refreshPreviewShortcut: (shortcut) => stack.refreshPreviewShortcut(shortcut),
  stepFont: (section, key) => stack.stepFont(section, key),
};

inputController = createInputController(
  appContext,
  appState.input,
  editorController,
  recentController,
  audienceController,
  lookController,
  stackInput,
);

stack = createStackController({
  card: cardEl,
  pinnedNoteId,
  look: {
    value: () => lookController.value(),
    altHeld: () => inputController.altHeld(),
    theme: () => lookController.currentTheme(),
    paintThemeIcon: () => lookController.paintThemeIcon(),
  },
  audience: {
    spaces: () => audienceController.knownSpaces(),
    defaultVisibility: () => audienceController.defaultVisibility(),
  },
  session: {
    editingId: () => sessionController.editingId(),
  },
  editor: {
    previewShortcut: () => inputController.previewShortcut(),
    openPreview: (name) => {
      void editorController.openPreview(name);
    },
    insertSnippet: (snippet, section) => editorController.insertSnippet(snippet, section),
    attachFiles: (files, section) => editorController.attachFiles(files, section),
    syncTitle: () => editorController.syncTitle(),
  },
});
bindMediaEditor({
  hostContainer: blocksEl,
  host: editorController.mediaHost,
  forSection: (section) => stack.mediaMutator(section),
  openPreview: (name) => {
    void editorController.openPreview(name);
  },
});
stack.wire();

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
      stack.rerenderEditors();
    }
    // Text sizes may have changed; stacked memos refit too.
    resizeAllBlockTextareas();
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
  void sessionController
    .loadPinned(pinnedNoteId)
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => {
      document.documentElement.classList.remove("memo-loading");
    });
  void getCurrentWindow().listen<string>("show-pin", (event) => {
    if (event.payload !== pinnedNoteId) {
      return;
    }
    void sessionController
      .loadPinned(pinnedNoteId)
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
  void listen<string | null>("notes-changed", (event) => {
    // A save names its memo; a window that does not show that memo has nothing to reload.
    const changed = event.payload;
    if (typeof changed === "string" && changed !== pinnedNoteId && !stack.showsNote(changed)) {
      return;
    }
    editorController.rememberPlace();
    void sessionController
      .loadPinned(pinnedNoteId)
      .then(() => editorController.resumePlace())
      .catch((error: unknown) => {
        console.error(error);
      });
  });
  void listen("stack-changed", () => {
    void stack.load().catch((error: unknown) => {
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
