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

export type SpeechModelId = "parakeet" | "canary";

/** One built-in speech model, as the settings show it. */
export type SpeechModelStatus = {
  id: SpeechModelId;
  name: string;
  summary: string;
  installed: boolean;
  /** What a download fetches now, the runtime included when it is missing. */
  downloadBytes: number;
  diskBytes: number;
  memoryMb: number;
  /** Times faster than real time. */
  speed: number;
  loadSecs: number;
  needsLanguage: boolean;
};

export type SpeechEngineStatus = {
  supported: boolean;
  /** The model in use is downloaded. */
  installed: boolean;
  model: SpeechModelId;
  downloadBytes: number;
  diskBytes: number;
  models: SpeechModelStatus[];
};

/** Languages the built-in models know, by code. */
export const speechLanguages: [string, string][] = [
  ["bg", "Bulgarian"],
  ["cs", "Czech"],
  ["da", "Danish"],
  ["de", "German"],
  ["el", "Greek"],
  ["en", "English"],
  ["es", "Spanish"],
  ["et", "Estonian"],
  ["fi", "Finnish"],
  ["fr", "French"],
  ["hr", "Croatian"],
  ["hu", "Hungarian"],
  ["it", "Italian"],
  ["lt", "Lithuanian"],
  ["lv", "Latvian"],
  ["mt", "Maltese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
  ["ro", "Romanian"],
  ["ru", "Russian"],
  ["sk", "Slovak"],
  ["sl", "Slovenian"],
  ["sv", "Swedish"],
  ["uk", "Ukrainian"],
];

export type MicrophoneAccess = "unknown" | "granted" | "denied" | "notNeeded";

export type MicrophonePermission = {
  access: MicrophoneAccess;
  /** Memose runs from a terminal, so the system decides for the app that started it. */
  borrowed: boolean;
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
  /** How much the chat model improves dictated text, 1 to 4. */
  polishLevel: number;
  polishReady: boolean;
  engine: SpeechEngineStatus;
  microphone: MicrophonePermission;
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
  /** A piece of heard text, its number, and the silence before it in ms. */
  onChunk?(text: string, seq: number, pauseMs: number): void;
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
  void listen<{ sessionId: string; seq: number; text: string; pauseMs?: number }>("speech-chunk", (event) => {
    const { sessionId, text, seq, pauseMs } = event.payload;
    sessions.get(sessionId)?.onChunk?.(text, seq, pauseMs ?? 0);
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
export function polishSpeech(before: string, after: string, dictated: string, level: number): Promise<string> {
  return invoke<string>("speech_polish", { before, after, dictated, level });
}

/** Improvement levels, from as heard to proof-read with the memo as context. */
export const improvementLevels = [
  { level: 1, name: "Basic", hint: "As the recognizer heard it" },
  { level: 2, name: "Improved", hint: "Punctuation, capitals, and clear mistakes. Dialect stays." },
  { level: 3, name: "Proof-read", hint: "Improved, then spelling and grammar into standard written language" },
  {
    level: 4,
    name: "Proof-read with context",
    hint: "Proof-read, using the memo around the words for names and terms",
  },
] as const;

export const DEFAULT_LEVEL = 2;

/** The highest level that can run: without the chat model only Basic. */
export function topLevel(): number {
  return speechSettings()?.polishReady ? 4 : 1;
}

/** Saves the level for live dictation. Recording that runs now uses it from the next piece. */
export function saveImprovementLevel(level: number): Promise<void> {
  if (settings) {
    settings.polishLevel = level;
  }
  return invoke("save_speech_settings", { polishLevel: level });
}

/**
 * A minimal four-step slider: a thin track with a dot per level and the level's name beside it.
 * Click a dot, drag along the track, or use the arrow keys. `onChange` gets the new level.
 * Clicks on it never reach the memo or the recording.
 */
export function levelSlider(value: number, onChange: (level: number) => void): HTMLElement {
  const top = topLevel();
  let current = Math.min(Math.max(1, value), top);
  const box = document.createElement("div");
  box.className = "level-slider";
  const track = document.createElement("div");
  track.className = "level-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "Text improvement");
  track.setAttribute("aria-valuemin", "1");
  track.setAttribute("aria-valuemax", String(top));
  track.tabIndex = -1;
  const fill = document.createElement("span");
  fill.className = "level-fill";
  track.append(fill);
  const steps: HTMLElement[] = [];
  for (const item of improvementLevels.filter((entry) => entry.level <= top)) {
    const step = document.createElement("span");
    step.className = "level-step";
    step.dataset.level = String(item.level);
    step.title = `${item.name}: ${item.hint}`;
    steps.push(step);
    track.append(step);
  }
  const label = document.createElement("span");
  label.className = "level-name";

  const paint = () => {
    const found = improvementLevels.find((item) => item.level === current) ?? improvementLevels[1];
    label.textContent = found.name;
    box.title = `${found.name}: ${found.hint}`;
    track.setAttribute("aria-valuenow", String(current));
    track.setAttribute("aria-valuetext", found.name);
    box.style.setProperty("--level-at", String(top > 1 ? (current - 1) / (top - 1) : 0));
    for (const step of steps) {
      step.classList.toggle("is-on", Number(step.dataset.level) <= current);
      step.classList.toggle("is-current", Number(step.dataset.level) === current);
    }
  };
  const set = (next: number) => {
    const level = Math.min(Math.max(1, next), top);
    if (level === current) {
      return;
    }
    current = level;
    paint();
    onChange(level);
  };
  const atPointer = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const share = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return 1 + Math.round(Math.min(Math.max(share, 0), 1) * (top - 1));
  };

  track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    track.setPointerCapture?.(event.pointerId);
    set(atPointer(event.clientX));
  });
  track.addEventListener("pointermove", (event) => {
    if (track.hasPointerCapture?.(event.pointerId)) {
      set(atPointer(event.clientX));
    }
  });
  track.addEventListener("pointerup", (event) => {
    track.releasePointerCapture?.(event.pointerId);
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  track.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      set(current - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      set(current + 1);
    }
  });
  for (const type of ["mousedown", "pointerdown", "click", "dragstart"] as const) {
    box.addEventListener(type, (event) => {
      event.stopPropagation();
    });
  }
  box.append(track, label);
  paint();
  box.hidden = top === 1;
  return box;
}

export function reloadSpeech(): Promise<void> {
  ensureListening();
  flight = load();
  return flight;
}

export function megabytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

/** A recording made in this app, with the words it put into a memo. */
export type RecordingInfo = {
  name: string;
  heard: string;
  text: string;
};

export function recordingsInfo(names: string[]): Promise<RecordingInfo[]> {
  return invoke<RecordingInfo[]>("recordings_info", { names });
}

export function saveRecordingText(name: string, text: string): Promise<void> {
  return invoke("recording_set_text", { name, text });
}

/** Turns the whole saved recording into text again. */
export function transcribeRecording(name: string): Promise<string> {
  return invoke<string>("recording_transcribe", { name });
}
