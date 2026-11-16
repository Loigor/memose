import { invoke } from "@tauri-apps/api/core";

import type { EditorPrefs } from "../editor/editor-field";
import type { MemoSpace, Note } from "../types";
import type { Look } from "../look/look";
import type { ShortcutBinds } from "../shortcuts";

export type AudienceSettings = {
  baseUrl: string;
  visibility: string;
  space: string;
};

export interface RecentBackend {
  listRecent(limit: number): Promise<Note[]>;
  setPinned(id: string, pinned: boolean, fromComposer: boolean): Promise<void>;
}

export interface AudienceBackend {
  getAudienceSettings(): Promise<AudienceSettings>;
  listMemoSpaces(): Promise<MemoSpace[]>;
  setNoteAudience(id: string, visibility: string, space: string): Promise<void>;
}

export interface LookBackend {
  getTheme(): Promise<string>;
  saveLook(id: string, look: Look): Promise<void>;
  setPinnedOpacity(opacity: number, persist?: boolean): Promise<void>;
}

export interface EditorBackend {
  openMediaPreview(name: string): Promise<void>;
  saveMedia(bytes: Uint8Array, filename: string | null, mime: string | null): Promise<string>;
  saveEditorView(id: string, lineWrap: boolean, folds: number[][], marks: number[][]): Promise<void>;
  getEditorPrefs(): Promise<EditorPrefs>;
}

export interface SessionBackend {
  saveNoteSize(id: string, width: number, height: number): Promise<void>;
  applyComposerSize(width: number | null, height: number | null): Promise<void>;
  slideIntoView(label: string): Promise<void>;
  saveEdit(id: string, content: string): Promise<void>;
  upsertDraft(content: string): Promise<Note | null>;
  commitNote(content: string): Promise<void>;
  getNote(id: string, materialize?: boolean): Promise<Note>;
  loadDraft(): Promise<Note | null>;
  deleteNote(id: string): Promise<void>;
  publishNote(id: string | null, content: string): Promise<Note>;
  hideComposer(): Promise<void>;
  resolveConflict(id: string, choice: "local" | "remote"): Promise<Note>;
  finalizeComposer(generation: number, content: string, noteId: string | null): Promise<void>;
}

export interface InputBackend {
  pasteClipboardMedia(): Promise<string[]>;
  hideMemos(): Promise<void>;
  getShortcuts(): Promise<ShortcutBinds>;
  mouseChord(button: number, alt: boolean, ctrl: boolean, shift: boolean, meta: boolean): Promise<void>;
}

export type AppBackend =
  & RecentBackend
  & AudienceBackend
  & LookBackend
  & EditorBackend
  & SessionBackend
  & InputBackend;

export function createAppBackend(): AppBackend {
  return {
    listRecent(limit) {
      return invoke<Note[]>("list_recent", { limit });
    },
    setPinned(id, pinned, fromComposer) {
      return invoke("set_pinned", { id, pinned, fromComposer });
    },
    getAudienceSettings() {
      return invoke<AudienceSettings>("get_settings");
    },
    listMemoSpaces() {
      return invoke<MemoSpace[]>("list_memo_spaces");
    },
    setNoteAudience(id, visibility, space) {
      return invoke("set_note_audience", { id, visibility, space });
    },
    getTheme() {
      return invoke<string>("get_theme");
    },
    saveLook(id, look) {
      return invoke("save_look", {
        id,
        opacity: look.opacity,
        hueLight: look.hueLight,
        hueDark: look.hueDark,
        swatches: [...look.swatches],
        theme: look.theme,
        coder: look.coder,
      });
    },
    setPinnedOpacity(opacity, persist) {
      return invoke("set_pinned_opacity", persist === undefined ? { opacity } : { opacity, persist });
    },
    openMediaPreview(name) {
      return invoke("open_media_preview", { name });
    },
    saveMedia(bytes, filename, mime) {
      return invoke<string>("save_media", { bytes, filename, mime });
    },
    saveEditorView(id, lineWrap, folds, marks) {
      return invoke("save_editor_view", { id, lineWrap, folds, marks });
    },
    getEditorPrefs() {
      return invoke<EditorPrefs>("get_settings");
    },
    saveNoteSize(id, width, height) {
      return invoke("save_note_size", { id, width, height });
    },
    applyComposerSize(width, height) {
      return invoke("apply_composer_size", { width, height });
    },
    slideIntoView(label) {
      return invoke("slide_into_view", { label });
    },
    saveEdit(id, content) {
      return invoke("save_edit", { id, content });
    },
    upsertDraft(content) {
      return invoke<Note | null>("upsert_draft", { content });
    },
    commitNote(content) {
      return invoke("commit_note", { content });
    },
    getNote(id, materialize) {
      return invoke<Note>("get_note", materialize === undefined ? { id } : { id, materialize });
    },
    loadDraft() {
      return invoke<Note | null>("load_draft");
    },
    deleteNote(id) {
      return invoke("delete_note", { id });
    },
    publishNote(id, content) {
      return invoke<Note>("publish_note", { id, content });
    },
    hideComposer() {
      return invoke("hide_composer");
    },
    resolveConflict(id, choice) {
      return invoke<Note>("resolve_conflict", { id, choice });
    },
    finalizeComposer(generation, content, noteId) {
      return invoke("finalize_composer", { generation, content, noteId });
    },
    pasteClipboardMedia() {
      return invoke<string[]>("paste_clipboard_media");
    },
    hideMemos() {
      return invoke("hide_memos");
    },
    getShortcuts() {
      return invoke<ShortcutBinds>("get_shortcuts");
    },
    mouseChord(button, alt, ctrl, shift, meta) {
      return invoke("mouse_chord", { button, alt, ctrl, shift, meta });
    },
  };
}
