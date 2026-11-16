import { getCurrentWindow } from "@tauri-apps/api/window";

import { memoUsesCoder } from "../../editor/editor-field";
import { defaultLook, lookFromNote } from "../../look/look";
import { inTauri } from "../../platform";
import { exactStamp, relativeTime } from "../../time";
import type { Note } from "../../types";
import type { AppContext } from "../context";
import type { SessionState } from "../state";
import type { AudienceController } from "./audience-controller";
import type { EditorController } from "./editor-controller";
import type { LookController } from "./look-controller";
import type { RecentController } from "./recent-controller";

export interface StackSession {
  focusNote(id: string): boolean;
  setHostCollapsed(collapsed: boolean): void;
  load(): Promise<void>;
  paintChrome(): void;
}

export interface SessionController {
  currentNoteId(): string | null;
  currentComposerId(): string | null;
  selectedId(): string | null;
  editingId(): string | null;
  placeKey(): string;
  isNewMemo(): boolean;
  showingPinned(): boolean;
  scheduleDraft(): void;
  openRecent(note: Note): Promise<void>;
  focusComposer(generation: number): Promise<void>;
  startFresh(generation: number): Promise<void>;
  cycleComposer(generation: number): Promise<void>;
  flushComposer(generation: number): Promise<void>;
  loadPinned(id: string): Promise<void>;
}

const emptyEditorView = { lineWrap: false, folds: [] as number[][], marks: [] as number[][] };

export function createSessionController(
  context: AppContext,
  state: SessionState,
  editor: EditorController,
  audience: AudienceController,
  look: LookController,
  recent: RecentController,
  stack: StackSession,
): SessionController {
  const {
    pinToggle,
    deleteConfirm,
    deleteNote,
    deleteYes,
    deleteNo,
    editedAt,
    conflict,
    conflictLocal,
    conflictRemote,
  } = context.dom;
  const pinnedNoteId = context.mode.pinnedNoteId;

  function currentNoteId(): string | null {
    return pinnedNoteId || state.editingId || state.draftId;
  }

  function currentComposerId(): string | null {
    return state.editingId || state.draftId;
  }

  function setConflict(id: string | null) {
    state.conflictId = id;
    conflict.hidden = id === null;
  }

  function setPinPressed(on: boolean) {
    pinToggle.setAttribute("aria-pressed", String(on));
  }

  function setEditedAt(ms: number | null) {
    if (ms == null || ms <= 0) {
      editedAt.hidden = true;
      editedAt.textContent = "";
      editedAt.removeAttribute("title");
      audience.refreshMeta();
      return;
    }
    editedAt.hidden = false;
    editedAt.textContent = relativeTime(ms);
    editedAt.title = exactStamp(ms);
    audience.refreshMeta();
  }

  async function rememberMemoSize() {
    if (!inTauri() || pinnedNoteId || state.applyingComposerSize) {
      return;
    }
    const id = state.editingId ?? state.draftId;
    if (!id) {
      return;
    }
    const size = await getCurrentWindow().outerSize();
    if (size.width < 80 || size.height < 80) {
      return;
    }
    await context.backend.saveNoteSize(id, Math.round(size.width), Math.round(size.height));
  }

  function scheduleMemoSize() {
    if (pinnedNoteId) {
      return;
    }
    clearTimeout(state.sizeTimer);
    state.sizeTimer = window.setTimeout(() => {
      void rememberMemoSize().catch((error: unknown) => {
        console.error(error);
      });
    }, 200);
  }

  async function applyMemoSize(width?: number | null, height?: number | null) {
    if (!inTauri() || pinnedNoteId) {
      return;
    }
    state.applyingComposerSize = true;
    try {
      const nextWidth = width && width > 0 ? Math.round(width) : null;
      const nextHeight = height && height > 0 ? Math.round(height) : null;
      await context.backend.applyComposerSize(nextWidth, nextHeight);
      if (nextWidth && nextHeight) {
        await context.backend.slideIntoView(getCurrentWindow().label);
      }
    } finally {
      window.setTimeout(() => {
        state.applyingComposerSize = false;
      }, 200);
    }
  }

  function scheduleDraft() {
    if (!inTauri()) {
      return;
    }
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(() => {
      void persistDraft().catch((error: unknown) => {
        console.error(error);
      });
    }, 300);
  }

  async function persistDraft() {
    const content = editor.content();
    const noteId = state.editingId || pinnedNoteId || null;
    if (noteId) {
      await context.backend.saveEdit(noteId, content);
      setEditedAt(Date.now());
      await editor.saveView(noteId);
      if (look.hasPending()) {
        await look.flush();
      }
      return;
    }
    const saved = await context.backend.upsertDraft(content);
    if (!saved) {
      state.draftId = null;
      setEditedAt(null);
      return;
    }
    setEditedAt(saved.updatedAt);
    if (audience.isDirty()) {
      await audience.save(saved.id);
    }
    const idChanged = state.draftId !== saved.id;
    state.draftId = saved.id;
    if (idChanged || look.hasPending()) {
      await look.saveImmediately(saved.id);
    }
    await editor.saveView(saved.id);
  }

  async function attachPendingLook() {
    const content = editor.content();
    if (!pinnedNoteId && !state.editingId && look.hasPending() && !state.draftId && content.trim()) {
      const saved = await context.backend.upsertDraft(content);
      if (saved) {
        state.draftId = saved.id;
      }
    }
    await look.flush();
  }

  async function openRecent(item: Note) {
    if (pinnedNoteId) {
      recent.dismiss();
      if (item.id === pinnedNoteId) {
        editor.resumePlace();
        return;
      }
      if (stack.focusNote(item.id)) {
        return;
      }
      if (inTauri()) {
        await context.backend.setPinned(item.id, true, false);
      }
      return;
    }
    if (state.editingId === item.id) {
      editor.rememberPlace();
      await returnToNewMemo(state.openGeneration);
      return;
    }
    editor.rememberPlace();
    await rememberMemoSize();
    clearTimeout(state.draftTimer);
    const typed = editor.content();
    const savingNewMemo = state.editingId === null && typed.trim().length > 0;
    if (inTauri() && savingNewMemo) {
      if (audience.isDirty() || editor.viewUnsaved()) {
        await persistDraft();
      }
      await attachPendingLook();
      await editor.flushView();
      await context.backend.commitNote(typed);
    } else {
      if (inTauri() && state.editingId !== null && typed.trim().length > 0) {
        await context.backend.saveEdit(state.editingId, typed);
      }
      await look.flush();
      await editor.flushView();
    }
    let opened = item;
    if (inTauri() && (item.syncState === "remote" || item.syncState === "conflict")) {
      try {
        opened = await context.backend.getNote(item.id);
      } catch (error) {
        console.error(error);
        return;
      }
    }
    state.editingId = opened.id;
    state.draftId = null;
    editor.showStored(opened.content);
    look.adopt(lookFromNote(opened), opened);
    setConflict(opened.syncState === "conflict" ? opened.id : null);
    setPinPressed(opened.pinned);
    setEditedAt(opened.updatedAt);
    audience.paint(opened);
    recent.markSelected();
    editor.resumePlace();
    await applyMemoSize(opened.winW, opened.winH);
    if (savingNewMemo || opened.syncState !== item.syncState) {
      await recent.refresh();
    }
  }

  async function loadDraft() {
    await look.flush();
    const draft = await context.backend.loadDraft();
    state.draftId = draft?.id ?? null;
    editor.showStored(draft?.content ?? "");
    state.editingId = null;
    setEditedAt(draft?.updatedAt ?? null);
    audience.paint(draft);
    look.adopt(draft ? lookFromNote(draft) : defaultLook(), draft ?? emptyEditorView);
    if (!draft || (draft.hueLight == null && draft.hueDark == null)) {
      audience.applySpaceDefault(draft?.space || audience.selectedSpace());
    }
  }

  async function focusComposer(generation: number) {
    state.openGeneration = generation;
    setConflict(null);
    recent.reveal();
    await loadDraft();
    setPinPressed(false);
    await recent.refresh();
    editor.resumePlace();
  }

  async function openLastModified() {
    clearTimeout(state.draftTimer);
    const notes = await context.backend.listRecent(1);
    const latest = notes.find((note) => note.id !== state.draftId);
    if (!latest) {
      editor.focus();
      return;
    }
    const typed = editor.content();
    if (state.editingId === null && typed.trim().length > 0) {
      if (audience.isDirty()) {
        await persistDraft();
      }
      await attachPendingLook();
      await context.backend.commitNote(typed);
    }
    await openRecent(latest);
  }

  async function returnToNewMemo(generation: number) {
    editor.rememberPlace();
    await rememberMemoSize();
    state.openGeneration = generation;
    setConflict(null);
    recent.resetForComposer();
    clearTimeout(state.draftTimer);
    const noteId = state.editingId;
    const content = editor.content();
    if (noteId && content.trim().length > 0) {
      await context.backend.saveEdit(noteId, content);
    }
    await look.flush();
    await editor.flushView();
    state.editingId = null;
    state.draftId = null;
    editor.showStored("");
    look.adopt(defaultLook(), emptyEditorView);
    setPinPressed(false);
    setEditedAt(null);
    audience.paint(null);
    editor.focusEditing();
    await recent.refresh();
    await applyMemoSize();
    editor.focusEditing();
  }

  async function startFresh(generation: number) {
    editor.rememberPlace();
    await rememberMemoSize();
    state.openGeneration = generation;
    setConflict(null);
    recent.resetForComposer();
    clearTimeout(state.draftTimer);
    const noteId = state.editingId;
    const content = editor.content();
    if (noteId) {
      if (content.trim().length > 0) {
        await context.backend.saveEdit(noteId, content);
      }
      await look.flush();
      await editor.flushView();
    } else if (content.trim().length > 0 && !pinnedNoteId) {
      if (audience.isDirty() || editor.viewUnsaved()) {
        await persistDraft();
      }
      await attachPendingLook();
      await editor.flushView();
      await context.backend.commitNote(content);
    } else {
      await look.flush();
      await editor.flushView();
    }
    state.editingId = null;
    state.draftId = null;
    editor.showStored("");
    look.adopt(defaultLook(), emptyEditorView);
    setPinPressed(false);
    setEditedAt(null);
    audience.paint(null);
    editor.focusEditing();
    await recent.refresh();
    await applyMemoSize();
    editor.focusEditing();
  }

  async function cycleComposer(generation: number) {
    state.openGeneration = generation;
    editor.rememberPlace();
    if (state.editingId === null) {
      await openLastModified();
      return;
    }
    await returnToNewMemo(generation);
  }

  async function flushComposer(generation: number) {
    editor.rememberPlace();
    const content = editor.content();
    const noteId = state.editingId;
    recent.collapseForFlush();
    await rememberMemoSize().catch((error: unknown) => {
      console.error(error);
    });
    clearTimeout(state.draftTimer);
    await editor.flushView();
    if (generation === state.openGeneration) {
      editor.resetView();
      editor.showStored("");
      editor.paintCoder(memoUsesCoder(look.value().coder));
      state.editingId = null;
      state.draftId = null;
      setPinPressed(false);
      setEditedAt(null);
      audience.paint(null);
    }
    await context.backend.finalizeComposer(generation, content, noteId);
    await recent.refresh();
  }

  function applyPinned(note: Note) {
    const dirty = state.loadedContent.length > 0 && editor.content() !== state.loadedContent;
    let reloaded = false;
    if (!dirty && (state.editingId !== note.id || state.loadedContent !== note.content)) {
      state.editingId = note.id;
      editor.showStored(note.content);
      state.loadedContent = note.content;
      editor.resumePlace();
      reloaded = true;
    }
    setConflict(note.syncState === "conflict" ? note.id : null);
    setPinPressed(note.pinned);
    setEditedAt(note.updatedAt);
    stack.setHostCollapsed(Boolean(note.collapsed));
    audience.paint(note);
    if (!look.hasScheduledWrite()) {
      look.adopt(lookFromNote(note), reloaded ? note : undefined);
    }
  }

  async function loadPinned(id: string) {
    if (id !== pinnedNoteId) {
      return;
    }
    const ticket = ++state.pinnedLoadGeneration;
    const stored = await context.backend.getNote(pinnedNoteId, false);
    if (ticket !== state.pinnedLoadGeneration || stored.id !== pinnedNoteId) {
      return;
    }
    applyPinned(stored);
    await stack.load();
    stack.paintChrome();
    await look.loadTheme();
    if (stored.syncState !== "remote") {
      return;
    }
    const note = await context.backend.getNote(pinnedNoteId);
    if (ticket !== state.pinnedLoadGeneration || note.id !== pinnedNoteId) {
      return;
    }
    applyPinned(note);
    stack.paintChrome();
  }

  async function resolveConflict(id: string, choice: "local" | "remote") {
    try {
      const note = await context.backend.resolveConflict(id, choice);
      if (state.editingId === note.id || pinnedNoteId === note.id) {
        state.editingId = note.id;
        editor.showStored(note.content);
        setConflict(null);
        setPinPressed(note.pinned);
        setEditedAt(note.updatedAt);
      }
      await recent.refresh();
    } catch (error) {
      console.error(error);
    }
  }

  deleteNote.addEventListener("click", () => {
    if (!currentNoteId() && editor.isEmpty()) {
      return;
    }
    deleteNote.hidden = true;
    deleteConfirm.hidden = false;
  });

  deleteNo.addEventListener("click", () => {
    audience.resetDeleteConfirm();
  });

  deleteYes.addEventListener("click", () => {
    void (async () => {
      const id = currentNoteId();
      if (!id && editor.isEmpty()) {
        audience.closePopover();
        return;
      }
      clearTimeout(state.draftTimer);
      deleteYes.textContent = "Deleting…";
      if (id && inTauri()) {
        await context.backend.deleteNote(id);
      }
      audience.closePopover();
      if (pinnedNoteId) {
        return;
      }
      state.editingId = null;
      state.draftId = null;
      editor.resetView();
      editor.showStored("");
      editor.paintCoder(memoUsesCoder(look.value().coder));
      setPinPressed(false);
      setEditedAt(null);
      audience.paint(null);
      await recent.refresh();
    })().catch((error: unknown) => {
      deleteYes.textContent = "Could not delete";
      console.error(error);
    });
  });

  pinToggle.addEventListener("click", () => {
    void (async () => {
      const pressed = pinToggle.getAttribute("aria-pressed") === "true";
      const id = pinnedNoteId || state.editingId;
      if (pressed) {
        if (!id) {
          return;
        }
        await context.backend.setPinned(id, false, false);
        setPinPressed(false);
        await recent.refresh();
        return;
      }
      if (!state.editingId && audience.isDirty() && state.draftId) {
        await audience.save(state.draftId);
      }
      const note = await context.backend.publishNote(state.editingId || state.draftId || null, editor.content());
      if (!state.editingId && audience.isDirty()) {
        await audience.save(note.id);
      }
      await look.saveImmediately(note.id);
      await context.backend.setPinned(note.id, true, !pinnedNoteId);
      if (!pinnedNoteId) {
        state.editingId = null;
        state.draftId = null;
        editor.showStored("");
        setPinPressed(false);
        setEditedAt(null);
        audience.paint(null);
        await context.backend.hideComposer();
      } else {
        setPinPressed(true);
        setEditedAt(note.updatedAt);
      }
      await recent.refresh();
    })().catch((error: unknown) => {
      console.error(error);
    });
  });

  conflictLocal.addEventListener("click", () => {
    if (state.conflictId) {
      void resolveConflict(state.conflictId, "local");
    }
  });

  conflictRemote.addEventListener("click", () => {
    if (state.conflictId) {
      void resolveConflict(state.conflictId, "remote");
    }
  });

  if (inTauri() && context.mode.kind !== "preview") {
    window.addEventListener("resize", () => {
      editor.resize();
      scheduleMemoSize();
    });
  }

  return {
    currentNoteId,
    currentComposerId,
    selectedId: () => state.editingId,
    editingId: () => state.editingId,
    placeKey: () => pinnedNoteId || state.editingId || "new",
    isNewMemo: () => !pinnedNoteId && state.editingId === null,
    showingPinned: () => pinnedNoteId !== "" || pinToggle.getAttribute("aria-pressed") === "true",
    scheduleDraft,
    openRecent,
    focusComposer,
    startFresh,
    cycleComposer,
    flushComposer,
    loadPinned,
  };
}
