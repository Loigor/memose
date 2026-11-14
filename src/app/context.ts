import { requireEl } from "../dom";
import type { ThemeName } from "../look/memo-chrome";
import type { AppBackend } from "./backend";

export type AppMode = {
  kind: "composer" | "pinned" | "preview";
  pinnedNoteId: string;
  pinnedThemeHint: ThemeName | null;
};

export type AppDom = {
  card: HTMLElement;
  blocks: HTMLDivElement;
  preview: HTMLDivElement;
  notePane: HTMLElement;
  notesRoot: HTMLElement;
  lightbox: HTMLDivElement;
  lightboxImage: HTMLImageElement;
  markdownToggle: HTMLButtonElement;
  markdownToolbar: HTMLDivElement;
  editorMenuToggle: HTMLButtonElement;
  editorTools: HTMLDivElement;
  coderToggle: HTMLButtonElement;
  formatToggle: HTMLButtonElement;
  formatPop: HTMLDivElement;
  modeToggle: HTMLButtonElement;
  themeToggle: HTMLButtonElement;
  themeIcon: SVGElement;
  colorPop: HTMLDivElement;
  hueSlider: HTMLInputElement;
  hueAdd: HTMLButtonElement;
  hueSlots: HTMLButtonElement[];
  pinToggle: HTMLButtonElement;
  visibilityLabel: HTMLButtonElement;
  noteSync: HTMLElement;
  audiencePop: HTMLDivElement;
  visibilityChoices: HTMLDivElement;
  spaceBlock: HTMLDivElement;
  spaceChoices: HTMLDivElement;
  editedSep: HTMLElement;
  deleteConfirm: HTMLDivElement;
  deleteNote: HTMLButtonElement;
  deleteYes: HTMLButtonElement;
  deleteNo: HTMLButtonElement;
  editedAt: HTMLElement;
  memoList: HTMLElement;
  recent: HTMLUListElement;
  recentSearch: HTMLInputElement;
  recentMore: HTMLButtonElement;
  conflict: HTMLElement;
  conflictLocal: HTMLButtonElement;
  conflictRemote: HTMLButtonElement;
};

export type AppContext = {
  mode: AppMode;
  dom: AppDom;
  backend: AppBackend;
};

function required<T extends Element>(selector: string, name: string): T {
  return requireEl(document.querySelector<T>(selector), name);
}

export function createAppContext(mode: AppMode, backend: AppBackend): AppContext {
  const card = required<HTMLElement>("#card", "card");
  return {
    mode,
    backend,
    dom: {
      card,
      blocks: required<HTMLDivElement>("#blocks", "blocks"),
      preview: required<HTMLDivElement>("#preview", "preview"),
      notePane: required<HTMLElement>("#note-pane", "note pane"),
      notesRoot: document.querySelector<HTMLElement>("#notes") ?? card,
      lightbox: required<HTMLDivElement>("#lightbox", "lightbox"),
      lightboxImage: required<HTMLImageElement>("#lightbox-image", "lightbox image"),
      markdownToggle: required<HTMLButtonElement>("#markdown-toggle", "markdown toggle"),
      markdownToolbar: required<HTMLDivElement>("#md-toolbar", "markdown toolbar"),
      editorMenuToggle: required<HTMLButtonElement>("#editor-menu-toggle", "editor menu toggle"),
      editorTools: required<HTMLDivElement>("#editor-tools", "editor tools"),
      coderToggle: required<HTMLButtonElement>("#coder-toggle", "coder toggle"),
      formatToggle: required<HTMLButtonElement>("#format-toggle", "format toggle"),
      formatPop: required<HTMLDivElement>("#format-pop", "format menu"),
      modeToggle: required<HTMLButtonElement>("#mode-toggle", "mode toggle"),
      themeToggle: required<HTMLButtonElement>("#theme-toggle", "theme toggle"),
      themeIcon: required<SVGElement>("#theme-icon", "theme icon"),
      colorPop: required<HTMLDivElement>("#color-pop", "color pop"),
      hueSlider: required<HTMLInputElement>("#hue-slider", "hue slider"),
      hueAdd: required<HTMLButtonElement>("#hue-add", "save hue"),
      hueSlots: [...document.querySelectorAll<HTMLButtonElement>(".hue-slot")],
      pinToggle: required<HTMLButtonElement>("#pin-toggle", "pin toggle"),
      visibilityLabel: required<HTMLButtonElement>("#visibility-label", "visibility label"),
      noteSync: required<HTMLElement>("#note-sync", "note sync"),
      audiencePop: required<HTMLDivElement>("#audience-pop", "audience pop"),
      visibilityChoices: required<HTMLDivElement>("#visibility-choices", "visibility choices"),
      spaceBlock: required<HTMLDivElement>("#space-block", "space block"),
      spaceChoices: required<HTMLDivElement>("#space-choices", "space choices"),
      editedSep: required<HTMLElement>("#edited-sep", "edited separator"),
      deleteConfirm: required<HTMLDivElement>("#delete-confirm", "delete confirm"),
      deleteNote: required<HTMLButtonElement>("#delete-note", "delete note"),
      deleteYes: required<HTMLButtonElement>("#delete-yes", "delete yes"),
      deleteNo: required<HTMLButtonElement>("#delete-no", "delete no"),
      editedAt: required<HTMLElement>("#edited-at", "edited at"),
      memoList: required<HTMLElement>("#memo-list", "memo list"),
      recent: required<HTMLUListElement>("#recent", "recent"),
      recentSearch: required<HTMLInputElement>("#recent-search", "recent search"),
      recentMore: required<HTMLButtonElement>("#recent-more", "recent more"),
      conflict: required<HTMLElement>("#conflict", "conflict"),
      conflictLocal: required<HTMLButtonElement>("#conflict-local", "keep local"),
      conflictRemote: required<HTMLButtonElement>("#conflict-remote", "use server"),
    },
  };
}
