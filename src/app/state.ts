import { BlockHistory, type Caret, type EditorPlace } from "../editor/history";
import type { Block } from "../editor/markdown-edit";
import type { Look } from "../look/look";
import type { ThemeName } from "../look/memo-chrome";
import { defaultBinds, type ShortcutBinds } from "../shortcuts";
import type { MemoSpace } from "../types";

export type SessionState = {
  openGeneration: number;
  editingId: string | null;
  draftId: string | null;
  loadedContent: string;
  draftTimer: ReturnType<typeof setTimeout> | undefined;
  applyingComposerSize: boolean;
  sizeTimer: number | undefined;
  conflictId: string | null;
  pinnedLoadGeneration: number;
};

export type EditorState = {
  content: string;
  blocks: Block[];
  caret: Caret | null;
  places: Map<string, EditorPlace>;
  history: BlockHistory;
  showingPreview: boolean;
  previewGeneration: number;
  previewClick: { at: number; x: number; y: number } | null;
  viewWrite: Promise<void>;
  coderWrap: boolean;
  folds: number[][];
  marks: number[][];
  viewBlocks: Block[];
  viewTimer: ReturnType<typeof setTimeout> | undefined;
  viewUnsaved: boolean;
  skipCapture: boolean;
};

export type RecentState = {
  expanded: boolean;
  hidden: boolean;
  query: string;
  flight: Promise<void> | null;
  again: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type AudienceState = {
  syncEnabled: boolean;
  defaultVisibility: string;
  defaultSpace: string;
  knownSpaces: MemoSpace[];
  dirty: boolean;
  painted: boolean;
  visibility: string;
  space: string;
  syncState: string;
  syncError: string | null;
};

export type LookState = {
  value: Look;
  appTheme: ThemeName;
  timer: ReturnType<typeof setTimeout> | undefined;
  write: Promise<void>;
  unsaved: boolean;
  opacityCarry: number;
  pinnedOpacityTimer: ReturnType<typeof setTimeout> | undefined;
  pinnedOpacityFrame: number;
  pinnedOpacityLive: number;
};

export type InputState = {
  binds: ShortcutBinds;
  altHeld: boolean;
  gestureHeld: boolean;
  tagCursorFrame: number;
  tagPress: { tag: string; x: number; y: number } | null;
  tagClickHandled: boolean;
  lastPasteHandledAt: number;
};

export type AppState = {
  session: SessionState;
  editor: EditorState;
  recent: RecentState;
  audience: AudienceState;
  look: LookState;
  input: InputState;
};

export function createAppState(): AppState {
  return {
    session: {
      openGeneration: 0,
      editingId: null,
      draftId: null,
      loadedContent: "",
      draftTimer: undefined,
      applyingComposerSize: false,
      sizeTimer: undefined,
      conflictId: null,
      pinnedLoadGeneration: 0,
    },
    editor: {
      content: "",
      blocks: [{ kind: "text", text: "" }],
      caret: null,
      places: new Map(),
      history: new BlockHistory(),
      showingPreview: false,
      previewGeneration: 0,
      previewClick: null,
      viewWrite: Promise.resolve(),
      coderWrap: false,
      folds: [],
      marks: [],
      viewBlocks: [],
      viewTimer: undefined,
      viewUnsaved: false,
      skipCapture: false,
    },
    recent: {
      expanded: false,
      hidden: false,
      query: "",
      flight: null,
      again: false,
      timer: undefined,
    },
    audience: {
      syncEnabled: false,
      defaultVisibility: "PRIVATE",
      defaultSpace: "",
      knownSpaces: [],
      dirty: false,
      painted: false,
      visibility: "PRIVATE",
      space: "",
      syncState: "local",
      syncError: null,
    },
    look: {
      value: { opacity: 100, hueLight: null, hueDark: null, swatches: [], theme: null, coder: null },
      appTheme: "light",
      timer: undefined,
      write: Promise.resolve(),
      unsaved: false,
      opacityCarry: 100,
      pinnedOpacityTimer: undefined,
      pinnedOpacityFrame: 0,
      pinnedOpacityLive: 0,
    },
    input: {
      binds: defaultBinds(),
      altHeld: false,
      gestureHeld: false,
      tagCursorFrame: 0,
      tagPress: null,
      tagClickHandled: false,
      lastPasteHandledAt: 0,
    },
  };
}
