/** Recording from the window's side: settings, the running recording, and its events. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type SpeechPurpose = "memo" | "prompt";
export type SpeechSource = "local" | "server" | "off";

export type SpeechRecording = {
  recording: boolean;
  sessionId: string;
  noteId: string | null;
  purpose: SpeechPurpose;
};

export type SpeechEngineStatus = {
  supported: boolean;
  installed: boolean;
  downloadBytes: number;
  diskBytes: number;
};

export type SpeechSettings = {
  enabled: boolean;
  source: SpeechSource;
  baseUrl: string;
  serverUrl: string;
  serverHost: string;
  serverLocal: boolean;
  hasKey: boolean;
  model: string;
  language: string;
  device: string;
  keepAudio: boolean;
  polish: boolean;
  polishReady: boolean;
  engine: SpeechEngineStatus;
  recording: SpeechRecording | null;
};

export type SpeechDone = {
  sessionId: string;
  noteId: string | null;
  purpose: SpeechPurpose;
  /** Markdown line of the saved recording, when sound was kept. */
  audio: string | null;
  error: string | null;
};

export type SpeechHandlers = {
  onChunk?(text: string, seq: number): void;
  onLevel?(level: number): void;
  onDone?(done: SpeechDone): void;
};

let settings: SpeechSettings | null = null;
let running: SpeechRecording | null = null;
let flight: Promise<void> | null = null;
let listening = false;
const watchers = new Set<() => void>();
const sessions = new Map<string, SpeechHandlers>();

function notify() {
  for (const watcher of watchers) {
    watcher();
  }
}

async function load() {
  try {
    settings = await invoke<SpeechSettings>("get_speech_settings");
    running = settings.recording;
  } catch {
    settings = null;
  }
  notify();
}

function ensureListening() {
  if (listening) {
    return;
  }
  listening = true;
  void listen("speech-settings-changed", () => {
    flight = load();
  });
  void listen<SpeechRecording>("speech-state", (event) => {
    running = event.payload.recording ? event.payload : null;
    notify();
  });
  void listen<{ sessionId: string; seq: number; text: string }>("speech-chunk", (event) => {
    sessions.get(event.payload.sessionId)?.onChunk?.(event.payload.text, event.payload.seq);
  });
  void listen<{ sessionId: string; level: number }>("speech-level", (event) => {
    sessions.get(event.payload.sessionId)?.onLevel?.(event.payload.level);
  });
  void listen<SpeechDone>("speech-done", (event) => {
    const handlers = sessions.get(event.payload.sessionId);
    sessions.delete(event.payload.sessionId);
    handlers?.onDone?.(event.payload);
  });
  flight = load();
}

/** Calls `watcher` now and whenever the settings or the running recording change. */
export function watchSpeech(watcher: () => void): () => void {
  watchers.add(watcher);
  ensureListening();
  if (settings) {
    watcher();
  }
  return () => watchers.delete(watcher);
}

export function speechSettings(): SpeechSettings | null {
  return settings;
}

/** The recording that runs now, started from any window. */
export function speechRunning(): SpeechRecording | null {
  return running;
}

/** True when a record button can do something useful for `purpose`. */
export function speechAvailable(purpose: SpeechPurpose): boolean {
  if (!settings?.enabled) {
    return false;
  }
  if (settings.source === "off") {
    return purpose === "memo" && settings.keepAudio;
  }
  return true;
}

/** Starts a recording. Its text and its end arrive through `handlers`. */
export async function startSpeech(
  purpose: SpeechPurpose,
  noteId: string | null,
  handlers: SpeechHandlers,
): Promise<string> {
  ensureListening();
  const sessionId = await invoke<string>("speech_start", { purpose, noteId });
  sessions.set(sessionId, handlers);
  return sessionId;
}

export function stopSpeech() {
  void invoke("speech_stop");
}

/** Lets the chat model tidy dictated text. `before` and `after` are the note around it. */
export function polishSpeech(before: string, after: string, dictated: string): Promise<string> {
  return invoke<string>("speech_polish", { before, after, dictated });
}

export function reloadSpeech(): Promise<void> {
  ensureListening();
  flight = load();
  return flight;
}

export function megabytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}
