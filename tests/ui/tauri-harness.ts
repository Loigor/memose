import type { Page } from "@playwright/test";

export type NoteSeed = {
  id?: string;
  content?: string;
  createdAt?: number;
  updatedAt?: number;
  syncState?: string;
  remoteName?: string | null;
  lastError?: string | null;
  pinned?: boolean;
  opacity?: number;
  hueLight?: number | null;
  hueDark?: number | null;
  swatches?: number[];
  visibility?: string | null;
  space?: string | null;
  collapsed?: boolean;
  stackHost?: string | null;
  theme?: string | null;
  serverContent?: string | null;
};

export type HarnessSettings = {
  baseUrl?: string;
  hasToken?: boolean;
  launchAtLogin?: boolean;
  visibility?: string;
  space?: string;
  snapMemos?: boolean;
};

export type HarnessSeed = {
  windowLabel?: string;
  notes?: NoteSeed[];
  noteCount?: number;
  notePrefix?: string;
  listRecentLimit?: number;
  draft?: NoteSeed | null;
  settings?: HarnessSettings;
  shortcuts?: Record<string, string>;
  spaces?: { name: string; title: string }[];
  theme?: string;
  previewName?: string | null;
};

export type Invocation = { cmd: string; args: unknown };

export type MemoseHarnessApi = {
  emit: (event: string, payload?: unknown) => number;
  hasListeners: (event: string) => boolean;
  seedNotes: (notes: NoteSeed[]) => void;
  getNotes: () => NoteSeed[];
  getInvocations: () => Invocation[];
  getSettings: () => Record<string, unknown>;
  setListRecentLimit: (limit: number) => void;
  resetInvocations: () => void;
};

declare global {
  interface Window {
    __memoseHarness?: MemoseHarnessApi;
  }
}

type BrowserSeed = HarnessSeed;

function installBrowserHarness(seed: BrowserSeed) {
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const command = apple ? "Super" : "Control";
  const nowMs = () => Date.now();
  const uuid = () => crypto.randomUUID();

  function makeNote(partial) {
    const now = nowMs();
    return {
      id: partial.id || uuid(),
      content: partial.content ?? "",
      createdAt: partial.createdAt ?? now,
      updatedAt: partial.updatedAt ?? now,
      syncState: partial.syncState ?? "local",
      remoteName: partial.remoteName ?? null,
      lastError: partial.lastError ?? null,
      pinned: Boolean(partial.pinned),
      opacity: partial.opacity ?? 100,
      hueLight: partial.hueLight ?? null,
      hueDark: partial.hueDark ?? null,
      swatches: Array.isArray(partial.swatches) ? partial.swatches.slice() : [],
      visibility: partial.visibility === undefined ? "PRIVATE" : partial.visibility,
      space: partial.space ?? "",
      collapsed: Boolean(partial.collapsed),
      stackHost: partial.stackHost ?? null,
      theme: partial.theme ?? null,
      serverContent: partial.serverContent ?? null,
    };
  }

  const notes = [];
  if (Array.isArray(seed.notes)) {
    for (const item of seed.notes) {
      notes.push(makeNote(item));
    }
  }
  if (seed.noteCount) {
    const now = nowMs();
    const prefix = seed.notePrefix || "Memo";
    for (let i = 0; i < seed.noteCount; i += 1) {
      notes.push(
        makeNote({
          content: `${prefix} ${String(i).padStart(5, "0")} unique-${i}`,
          createdAt: now - i,
          updatedAt: now - i,
        }),
      );
    }
  }
  if (seed.draft) {
    notes.push(makeNote({ ...seed.draft, syncState: "draft" }));
  }

  const settings = {
    baseUrl: seed.settings?.baseUrl ?? "",
    hasToken: Boolean(seed.settings?.hasToken),
    launchAtLogin: Boolean(seed.settings?.launchAtLogin),
    visibility: seed.settings?.visibility ?? "PRIVATE",
    space: seed.settings?.space ?? "",
    snapMemos: Boolean(seed.settings?.snapMemos),
  };
  const shortcuts = {
    newMemo: `${command}+Alt+N`,
    togglePinned: `${command}+Alt+P`,
    preview: `${command}+Enter`,
    hide: "Escape",
    randomHue: "Alt+Enter",
    gesture: "Alt",
    ...(seed.shortcuts || {}),
  };
  const state = {
    notes,
    settings,
    shortcuts,
    spaces: Array.isArray(seed.spaces) ? seed.spaces.slice() : [],
    theme: seed.theme === "dark" ? "dark" : "light",
    previewName: seed.previewName ?? null,
    listRecentLimit: seed.listRecentLimit ?? 200,
    invocations: [],
    token: seed.settings?.hasToken ? "saved-token" : "",
  };

  const callbacks = new Map();
  const listeners = new Map();

  function registerCallback(callback, once) {
    const identifier = window.crypto.getRandomValues(new Uint32Array(1))[0];
    callbacks.set(identifier, (data) => {
      if (once) {
        callbacks.delete(identifier);
      }
      if (callback) {
        callback(data);
      }
    });
    return identifier;
  }

  function runCallback(id, data) {
    const callback = callbacks.get(id);
    if (callback) {
      callback(data);
    }
  }

  function emit(event, payload) {
    const ids = listeners.get(event) || [];
    for (const handler of ids) {
      runCallback(handler, { event, id: handler, payload });
    }
    return ids.length;
  }

  function cloneNote(note) {
    return { ...note, swatches: note.swatches.slice() };
  }

  function listRecent(limit) {
    const requested = Number(limit) || 200;
    const cap = state.listRecentLimit > 200
      ? state.listRecentLimit
      : Math.max(1, Math.min(200, requested));
    return state.notes
      .filter((note) => note.syncState !== "draft")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, cap)
      .map(cloneNote);
  }

  function noteById(id) {
    return state.notes.find((note) => note.id === id);
  }

  function guestOf(hostId) {
    return state.notes.find((note) => note.stackHost === hostId);
  }

  function chainAfter(hostId) {
    const chain = [];
    let current = hostId;
    for (let i = 0; i < 8; i += 1) {
      const guest = guestOf(current);
      if (!guest) {
        break;
      }
      if (guest.id === hostId || chain.some((note) => note.id === guest.id)) {
        break;
      }
      current = guest.id;
      chain.push(cloneNote(guest));
    }
    return chain;
  }

  function commitState() {
    return state.settings.baseUrl ? "pending" : "local";
  }

  function handleEventPlugin(cmd, args) {
    if (cmd === "plugin:event|listen") {
      const event = args.event;
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") {
      const ids = listeners.get(args.event);
      if (ids) {
        const index = ids.indexOf(args.eventId ?? args.id);
        if (index !== -1) {
          ids.splice(index, 1);
        }
      }
      return null;
    }
    if (cmd === "plugin:event|emit") {
      emit(args.event, args.payload);
      return null;
    }
    return null;
  }

  function handleWindowPlugin(cmd) {
    const factor = window.devicePixelRatio || 1;
    if (cmd === "plugin:window|scale_factor") {
      return factor;
    }
    if (cmd === "plugin:window|inner_size" || cmd === "plugin:window|outer_size") {
      return { width: Math.round(window.innerWidth * factor), height: Math.round(window.innerHeight * factor) };
    }
    if (cmd === "plugin:window|inner_position" || cmd === "plugin:window|outer_position") {
      return { x: 40, y: 40 };
    }
    if (cmd.startsWith("plugin:window|is_")) {
      return cmd === "plugin:window|is_visible" || cmd === "plugin:window|is_always_on_top";
    }
    if (cmd === "plugin:window|title") {
      return "Memose";
    }
    if (cmd === "plugin:window|theme") {
      return state.theme;
    }
    return null;
  }

  async function handleCommand(cmd, args) {
    const a = args || {};
    switch (cmd) {
      case "upsert_draft": {
        const trimmed = String(a.content ?? "").trim();
        const existing = state.notes.find((note) => note.syncState === "draft");
        if (!trimmed) {
          state.notes = state.notes.filter((note) => note.syncState !== "draft");
          return null;
        }
        if (existing) {
          existing.content = trimmed;
          existing.updatedAt = nowMs();
          return cloneNote(existing);
        }
        const created = makeNote({ content: trimmed, syncState: "draft" });
        state.notes.push(created);
        return cloneNote(created);
      }
      case "load_draft": {
        const draft = state.notes.find((note) => note.syncState === "draft");
        return draft ? cloneNote(draft) : null;
      }
      case "finalize_composer":
      case "commit_note": {
        const trimmed = String(a.content ?? "").trim();
        const draft = state.notes.find((note) => note.syncState === "draft");
        if (!trimmed) {
          state.notes = state.notes.filter((note) => note.syncState !== "draft");
          emit("notes-changed");
          return null;
        }
        if (draft) {
          draft.content = trimmed;
          draft.syncState = commitState();
          draft.updatedAt = nowMs();
        } else {
          state.notes.push(makeNote({ content: trimmed, syncState: commitState() }));
        }
        emit("notes-changed");
        return null;
      }
      case "save_edit": {
        const note = noteById(a.id);
        const trimmed = String(a.content ?? "").trim();
        if (!note || !trimmed) {
          return null;
        }
        note.content = trimmed;
        note.updatedAt = nowMs();
        if (note.syncState === "synced") {
          note.syncState = "pending";
        }
        emit("notes-changed");
        return null;
      }
      case "list_recent":
        return listRecent(a.limit);
      case "get_settings":
        return { ...state.settings, hasToken: Boolean(state.token) };
      case "save_settings": {
        if (typeof a.baseUrl === "string") {
          state.settings.baseUrl = a.baseUrl;
        }
        if (a.token === "") {
          state.token = "";
        } else if (typeof a.token === "string") {
          state.token = a.token;
        }
        if (typeof a.visibility === "string") {
          state.settings.visibility = a.visibility;
          state.settings.space = typeof a.space === "string" ? a.space : "";
        }
        state.settings.hasToken = Boolean(state.token);
        emit("settings-changed");
        return null;
      }
      case "list_memo_spaces":
        return state.settings.baseUrl && state.token ? state.spaces.slice() : [];
      case "set_note_audience": {
        const note = noteById(a.id);
        if (note) {
          note.visibility = a.visibility;
          note.space = a.space;
          emit("notes-changed");
        }
        return null;
      }
      case "delete_note": {
        state.notes = state.notes.filter((note) => note.id !== a.id);
        emit("notes-changed");
        emit("stack-changed");
        return null;
      }
      case "get_shortcuts":
        return { ...state.shortcuts };
      case "save_shortcut": {
        state.shortcuts[a.id] = a.binding;
        emit("shortcuts-changed", { ...state.shortcuts });
        return { ...state.shortcuts };
      }
      case "mouse_chord":
        emit("mouse-chord", a);
        return null;
      case "clear_memos":
        state.settings.baseUrl = "";
        state.token = "";
        state.settings.hasToken = false;
        emit("settings-changed");
        return null;
      case "test_memos": {
        if (!state.settings.baseUrl) {
          throw new Error("server URL is not set");
        }
        if (!state.token) {
          throw new Error("access token is not set");
        }
        return "latest";
      }
      case "get_theme":
        return state.theme;
      case "save_look": {
        const note = noteById(a.id);
        if (note) {
          note.opacity = a.opacity ?? note.opacity;
          note.hueLight = a.hueLight ?? null;
          note.hueDark = a.hueDark ?? null;
          note.swatches = Array.isArray(a.swatches) ? a.swatches.slice() : [];
          note.theme = a.theme ?? null;
        }
        return null;
      }
      case "set_pinned_opacity":
        emit("pinned-opacity", a.opacity);
        return null;
      case "publish_note": {
        const trimmed = String(a.content ?? "");
        if (a.id) {
          const note = noteById(a.id);
          if (note) {
            note.content = trimmed;
            note.updatedAt = nowMs();
            if (note.syncState === "draft") {
              note.syncState = commitState();
            }
            return cloneNote(note);
          }
        }
        const draft = state.notes.find((note) => note.syncState === "draft");
        if (draft) {
          draft.content = trimmed;
          draft.syncState = commitState();
          draft.updatedAt = nowMs();
          return cloneNote(draft);
        }
        const created = makeNote({ content: trimmed, syncState: commitState() });
        state.notes.push(created);
        return cloneNote(created);
      }
      case "get_note": {
        const note = noteById(a.id);
        if (!note) {
          throw new Error("note not found");
        }
        if (note.syncState === "remote" && a.materialize !== false) {
          note.syncState = commitState();
        }
        return cloneNote(note);
      }
      case "resolve_conflict": {
        const note = noteById(a.id);
        if (!note) {
          throw new Error("note not found");
        }
        if (a.choice === "remote" && note.serverContent != null) {
          note.content = note.serverContent;
        }
        note.syncState = "synced";
        note.lastError = null;
        emit("notes-changed");
        return cloneNote(note);
      }
      case "set_pinned": {
        const note = noteById(a.id);
        if (note) {
          note.pinned = Boolean(a.pinned);
        }
        emit("notes-changed");
        return null;
      }
      case "hide_memos":
      case "hide_composer":
        return null;
      case "set_autostart":
        state.settings.launchAtLogin = Boolean(a.enabled);
        return a.enabled;
      case "set_snap_memos":
        state.settings.snapMemos = Boolean(a.enabled);
        emit("snap-changed", a.enabled);
        return null;
      case "set_collapsed": {
        const note = noteById(a.id);
        if (note) {
          note.collapsed = Boolean(a.collapsed);
        }
        return null;
      }
      case "stack_chain":
        return chainAfter(a.hostId);
      case "set_window_height":
      case "begin_memo_drag":
      case "end_memo_drag":
      case "slide_into_view":
      case "slide_back":
      case "begin_corner_resize":
        return null;
      case "detach_stack": {
        const note = noteById(a.guestId);
        if (note) {
          note.stackHost = null;
          note.pinned = true;
        }
        emit("stack-changed");
        emit("notes-changed");
        return null;
      }
      case "save_media":
        return `![${a.filename || "file.png"}](memose-media/12345678-${a.filename || "file.png"})`;
      case "save_media_file":
        return "![dropped.png](memose-media/12345678-dropped.png)";
      case "paste_clipboard_media":
        return [];
      case "reveal_media":
      case "open_media_file":
        return null;
      case "media_path":
        return `/tmp/memose-media/${a.name}`;
      case "current_media_preview":
        return state.previewName;
      case "open_media_preview":
        state.previewName = a.name;
        emit("show-media", a.name);
        return null;
      case "close_media_preview":
        state.previewName = null;
        return null;
      default:
        throw new Error(`unmocked tauri command: ${cmd}`);
    }
  }

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: seed.windowLabel || "main" },
      currentWebview: { windowLabel: seed.windowLabel || "main", label: seed.windowLabel || "main" },
    },
    convertFileSrc(path) {
      return `asset://localhost/${encodeURIComponent(String(path))}`;
    },
    transformCallback: registerCallback,
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    runCallback,
    callbacks,
    invoke: async (cmd, args) => {
      state.invocations.push({ cmd, args: args ?? null });
      if (String(cmd).startsWith("plugin:event|")) {
        return handleEventPlugin(cmd, args || {});
      }
      if (String(cmd).startsWith("plugin:window|")) {
        return handleWindowPlugin(cmd);
      }
      return handleCommand(cmd, args || {});
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      callbacks.delete(id);
      const ids = listeners.get(event);
      if (!ids) {
        return;
      }
      const index = ids.indexOf(id);
      if (index !== -1) {
        ids.splice(index, 1);
      }
    },
  };

  window.__memoseHarness = {
    emit,
    hasListeners(event) {
      return (listeners.get(event) || []).length > 0;
    },
    seedNotes(next) {
      state.notes = next.map((item) => makeNote(item));
    },
    getNotes() {
      return state.notes.map(cloneNote);
    },
    getInvocations() {
      return state.invocations.slice();
    },
    getSettings() {
      return { ...state.settings, hasToken: Boolean(state.token) };
    },
    setListRecentLimit(limit) {
      state.listRecentLimit = limit;
    },
    resetInvocations() {
      state.invocations = [];
    },
  };
}

export async function installHarness(page: Page, seed: HarnessSeed = {}): Promise<void> {
  await page.addInitScript(installBrowserHarness, seed);
}

export async function emitEvent(page: Page, event: string, payload?: unknown): Promise<number> {
  return page.evaluate(([name, data]) => window.__memoseHarness?.emit(name, data) ?? 0, [event, payload] as const);
}

export async function waitForListener(page: Page, event: string): Promise<void> {
  await page.waitForFunction((name) => Boolean(window.__memoseHarness?.hasListeners(name)), event);
}

export async function getInvocations(page: Page): Promise<Invocation[]> {
  return page.evaluate(() => window.__memoseHarness?.getInvocations() ?? []);
}

export async function getNotes(page: Page): Promise<NoteSeed[]> {
  return page.evaluate(() => window.__memoseHarness?.getNotes() ?? []);
}

export async function harnessSeedNotes(page: Page, notes: NoteSeed[]): Promise<void> {
  await page.evaluate((items) => window.__memoseHarness?.seedNotes(items), notes);
}

export async function setListRecentLimit(page: Page, limit: number): Promise<void> {
  await page.evaluate((value) => window.__memoseHarness?.setListRecentLimit(value), limit);
}

export function sampleNotes(count: number, prefix = "Memo"): NoteSeed[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `note-${String(i).padStart(4, "0")}`,
    content: `${prefix} ${String(i).padStart(5, "0")} unique-${i}`,
    createdAt: now - i * 1_000,
    updatedAt: now - i * 1_000,
    syncState: "local",
  }));
}
