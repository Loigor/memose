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

/** The lowest effort that also removes a first try the speaker said again. */
export const CORRECTIONS_LEVEL = 3;

/**
 * Lets the chat model tidy dictated text. `before` and `after` are the note around it.
 * With `corrections`, a first try said again is removed; `later` is what was said right after,
 * and an empty reply means all of `dictated` was said again there.
 */
export function polishSpeech(
  before: string,
  after: string,
  dictated: string,
  level: number,
  corrections = false,
  later = "",
): Promise<string> {
  return invoke<string>("speech_polish", { before, after, dictated, level, corrections, later });
}

/** Effort levels for dictated text, from as heard to proof-read with the memo as context. */
export const effortLevels = [
  { level: 1, name: "Low", hint: "As heard. No chat model." },
  { level: 2, name: "Medium", hint: "Punctuation, capitals, and clear mistakes. Dialect stays." },
  {
    level: 3,
    name: "High",
    hint: "Medium, then spelling and grammar into standard written language. A sentence you say again replaces the first try.",
  },
  { level: 4, name: "Max", hint: "High, using the memo around the words for names and terms." },
] as const;

export const DEFAULT_LEVEL = 2;

/** The name of an effort level, such as "High". */
export function effortName(level: number): string {
  return effortLevels.find((item) => item.level === level)?.name ?? "";
}

/** The highest level that can run: without the chat model only Low. */
export function topLevel(): number {
  return speechSettings()?.polishReady ? 4 : 1;
}

/** Saves the effort for live dictation. Recording that runs now uses it from the next piece. */
export function saveEffort(level: number): Promise<void> {
  if (settings) {
    settings.polishLevel = level;
  }
  return invoke("save_speech_settings", { polishLevel: level });
}

/** Places the tip right of `anchor`, centred on it; under it when there is no room on the right. */
function placeTip(tip: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  if (rect.right + 8 + width <= window.innerWidth - 8) {
    const top = rect.top + rect.height / 2 - height / 2;
    tip.style.left = `${rect.right + 8}px`;
    tip.style.top = `${Math.max(4, Math.min(top, window.innerHeight - height - 4))}px`;
    return;
  }
  const below = rect.bottom + 6;
  tip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  tip.style.top = `${below + height <= window.innerHeight - 4 ? below : Math.max(4, rect.top - height - 6)}px`;
}

/**
 * The effort slider: "Effort (High)" and a pill with a dot per level and a knob on the current one.
 * Click a dot, drag along the pill, or use the arrow keys. Hovering shows what the level does.
 * `onChange` gets the new level. Clicks on it never reach the memo or the recording.
 */
export function effortSlider(value: number, onChange: (level: number) => void): HTMLElement {
  const top = topLevel();
  let current = Math.min(Math.max(1, value), top);
  const box = document.createElement("div");
  box.className = "effort-slider";
  const label = document.createElement("span");
  label.className = "effort-label";
  const name = document.createElement("span");
  name.className = "effort-name";
  label.append("Effort ", name);
  const track = document.createElement("div");
  track.className = "effort-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "Effort");
  track.setAttribute("aria-valuemin", "1");
  track.setAttribute("aria-valuemax", String(top));
  track.tabIndex = -1;
  const steps: HTMLElement[] = [];
  for (const item of effortLevels.filter((entry) => entry.level <= top)) {
    const dot = document.createElement("span");
    dot.className = "effort-dot";
    dot.dataset.level = String(item.level);
    steps.push(dot);
    track.append(dot);
  }
  const knob = document.createElement("span");
  knob.className = "effort-knob";
  track.append(knob);
  const tip = document.createElement("div");
  tip.className = "effort-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  let hovering = false;
  let dragging = false;

  const showTip = () => {
    const shown = (hovering || dragging || document.activeElement === track) && box.isConnected;
    if (!shown) {
      tip.hidden = true;
      tip.remove();
      return;
    }
    if (!tip.isConnected) {
      document.body.append(tip);
    }
    tip.hidden = false;
    placeTip(tip, box);
  };
  const paint = () => {
    const found = effortLevels.find((item) => item.level === current) ?? effortLevels[1];
    name.textContent = `(${found.name})`;
    tip.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = found.name;
    tip.append(strong, ` · ${found.hint}`);
    track.setAttribute("aria-valuenow", String(current));
    track.setAttribute("aria-valuetext", `${found.name}: ${found.hint}`);
    box.style.setProperty("--effort-at", String(top > 1 ? (current - 1) / (top - 1) : 0));
    if (!tip.hidden) {
      placeTip(tip, box);
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
  /** The level whose dot is nearest the pointer. The dots run between the track's side paddings. */
  const atPointer = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const style = getComputedStyle(track);
    const dot = steps[0]?.offsetWidth ?? 0;
    const first = rect.left + (parseFloat(style.paddingLeft) || 0) + dot / 2;
    const last = rect.right - (parseFloat(style.paddingRight) || 0) - dot / 2;
    const share = last > first ? (clientX - first) / (last - first) : 0;
    return 1 + Math.round(Math.min(Math.max(share, 0), 1) * (top - 1));
  };

  track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    track.setPointerCapture?.(event.pointerId);
    dragging = true;
    box.classList.add("is-dragging");
    set(atPointer(event.clientX));
    showTip();
  });
  track.addEventListener("pointermove", (event) => {
    if (track.hasPointerCapture?.(event.pointerId)) {
      set(atPointer(event.clientX));
    }
  });
  const endDrag = (event: PointerEvent) => {
    track.releasePointerCapture?.(event.pointerId);
    if (!dragging) {
      return;
    }
    dragging = false;
    box.classList.remove("is-dragging");
    showTip();
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  box.addEventListener("pointerenter", () => {
    hovering = true;
    showTip();
  });
  box.addEventListener("pointerleave", () => {
    hovering = false;
    showTip();
  });
  track.addEventListener("focus", showTip);
  track.addEventListener("blur", showTip);
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
  // The tip lives on <body> so scrolling boxes cannot clip it; it leaves with the slider.
  let attached = false;
  new MutationObserver((_, observer) => {
    attached ||= box.isConnected;
    if (attached && !box.isConnected) {
      tip.remove();
      observer.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
  box.append(label, track);
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
