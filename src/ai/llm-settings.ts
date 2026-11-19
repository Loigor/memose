/** Model prompt settings and chat types, shared by every AI bubble in a window. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AiMode = "auto" | "ask" | "edit";

export type AiPreset = {
  name: string;
  instruction: string;
  mode: AiMode;
};

export type AiSettings = {
  llmEnabled: boolean;
  llmBaseUrl: string;
  hasLlmKey: boolean;
  llmModel: string;
  llmHost: string;
  llmLocal: boolean;
  privateOkHost: string;
  presets: AiPreset[];
  defaultPresets: AiPreset[];
};

export type ChatEntry = {
  id: string;
  noteId: string;
  title: string;
  instruction: string;
  mode: AiMode;
  status: "running" | "answer" | "edit" | "applied" | "dismissed" | "error" | "cancelled";
  text: string;
  source: string;
  lineStart: number | null;
  lineEnd: number | null;
  selection: boolean;
  startedAt: number;
  finishedAt: number | null;
  /** Ids of the changes taken from a proposed edit, once it is applied. */
  accepted?: number[];
};

export const modeNames: Record<AiMode, string> = { auto: "Auto", ask: "Ask", edit: "Edit" };

let settings: AiSettings | null = null;
let settingsFlight: Promise<AiSettings | null> | null = null;
let limit = 0;
const settingsWatchers = new Set<() => void>();
const chatWatchers = new Set<(noteId: string) => void>();
let listening = false;

async function loadSettings(): Promise<AiSettings | null> {
  try {
    settings = await invoke<AiSettings>("get_ai_settings");
    await loadContentLimit();
  } catch {
    settings = null;
  }
  for (const paint of settingsWatchers) {
    paint();
  }
  return settings;
}

/** The server limit can change while the app runs, so it is read again when a bubble opens. */
export async function loadContentLimit() {
  try {
    const general = await invoke<{ memoContentLimit?: number }>("get_settings");
    limit = general.memoContentLimit ?? 0;
  } catch {
    // The last known limit stays.
  }
}

/** Starts following settings and chat changes once per window. Resolves when the settings were read. */
export function ensureListening(): Promise<unknown> | null {
  if (!listening) {
    listening = true;
    void listen("ai-settings-changed", () => {
      settingsFlight = loadSettings();
    });
    void listen<string>("llm-changed", (event) => {
      for (const watcher of chatWatchers) {
        watcher(event.payload);
      }
    });
    settingsFlight = loadSettings();
  }
  return settingsFlight;
}

export function aiSettings(): AiSettings | null {
  return settings;
}

/** The memo size this server accepts, in bytes. 0 is no limit. */
export function contentLimit(): number {
  return limit;
}

/** Calls `watcher` whenever the settings were read again. The returned function stops it. */
export function watchAiSettings(watcher: () => void): () => void {
  settingsWatchers.add(watcher);
  return () => settingsWatchers.delete(watcher);
}

/** Calls `watcher` with the memo id whenever a chat changes. The returned function stops it. */
export function watchChats(watcher: (noteId: string) => void): () => void {
  chatWatchers.add(watcher);
  return () => chatWatchers.delete(watcher);
}

export function seconds(from: number, to: number): string {
  const total = Math.max(0, Math.round((to - from) / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
}

export function scopeLabel(start: number | null, end: number | null, code = false): string {
  if (start == null || end == null) {
    return code ? "Code block" : "Selected text";
  }
  const lines = start === end ? `Line ${start}` : `Lines ${start}–${end}`;
  return code ? `Code block, ${lines.toLowerCase()}` : lines;
}
