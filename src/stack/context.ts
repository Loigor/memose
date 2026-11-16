import type { Block } from "../editor/markdown-edit";
import type { BlockHistory, Caret } from "../editor/history";
import type { Look } from "../look/look";
import type { ThemeName } from "../look/memo-chrome";
import type { MemoSpace } from "../types";
import type { StackApi } from "./api";

export const NOTE_BAR = 52;
export const WINDOW_BAR = 108;
export const SECTION_OPEN = 420;

export type SectionState = {
  collapsed: boolean;
  hover: boolean;
  suppressHover: boolean;
  loaded: string;
  content: string;
  blocks: Block[];
  caret: Caret | null;
  history: BlockHistory;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  opacity: number;
  theme: ThemeName | null;
  coder: boolean | null;
  wrap: boolean;
  folds: number[][];
  marks: number[][];
  mdBar: boolean;
  visibility: string;
  space: string;
  syncState: string;
  lastError: string | null;
};

export type SectionLift = {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  started: boolean;
};

export type StackDeps = {
  card: HTMLElement;
  pinnedNoteId: string;
  look: {
    value(): Look;
    altHeld(): boolean;
    theme(): ThemeName;
    paintThemeIcon(): void;
  };
  audience: {
    spaces(): MemoSpace[];
    defaultVisibility(): string;
  };
  session: {
    editingId(): string | null;
  };
  editor: {
    previewShortcut(): string;
    openPreview(name: string): void;
    insertSnippet(snippet: string, targetSection?: HTMLElement | null): void;
    attachFiles(files: File[], targetSection?: HTMLElement | null): Promise<void>;
    syncTitle(): void;
  };
};

export type StackCtx = {
  deps: StackDeps;
  dom: {
    frame: HTMLElement | null;
    stack: HTMLElement | null;
  };
  notes: Map<string, SectionState>;
  saveTimers: Map<string, ReturnType<typeof setTimeout>>;
  renderedViews: WeakMap<SectionState, Block[]>;
  fold: {
    hostCollapsed: boolean;
    hostHover: boolean;
    suppressHostHover: boolean;
    editingHoldSection: string | null;
    autoOpenNewSection: string | null;
    lastActiveSection: string;
  };
  size: {
    openNoteHeight: number;
    savedHostHeight: number;
    heightTween: number;
    tweenTicket: number;
    sizingWindow: boolean;
    sizingTimer: ReturnType<typeof setTimeout> | undefined;
    initialSizeSynced: boolean;
    chromeSignature: string | null;
  };
  pointer: {
    cursorPoint: { x: number; y: number } | null;
    cursorKnown: boolean;
    pressTravel: number;
    pressAt: { x: number; y: number } | null;
    resizing: boolean;
    resizingVertical: boolean;
    sectionLift: SectionLift | null;
  };
  api: StackApi;
};

export function createStackContext(deps: StackDeps): StackCtx {
  return {
    deps,
    dom: {
      frame: document.querySelector<HTMLElement>("#frame"),
      stack: document.querySelector<HTMLElement>("#stack"),
    },
    notes: new Map(),
    saveTimers: new Map(),
    renderedViews: new WeakMap(),
    fold: {
      hostCollapsed: false,
      hostHover: false,
      suppressHostHover: false,
      editingHoldSection: null,
      autoOpenNewSection: null,
      lastActiveSection: "host",
    },
    size: {
      openNoteHeight: SECTION_OPEN,
      savedHostHeight: 476,
      heightTween: 0,
      tweenTicket: 0,
      sizingWindow: false,
      sizingTimer: undefined,
      initialSizeSynced: false,
      chromeSignature: null,
    },
    pointer: {
      cursorPoint: null,
      cursorKnown: false,
      pressTravel: 0,
      pressAt: null,
      resizing: false,
      resizingVertical: false,
      sectionLift: null,
    },
    api: undefined!,
  };
}
