import { invoke } from "@tauri-apps/api/core";

import {
  eventToBind,
  formatBind,
  gestureSnippet,
  modifierChoices,
  shortcutFields,
  type ShortcutBinds,
} from "./shortcuts";

type Settings = {
  baseUrl: string;
  hasToken: boolean;
  launchAtLogin: boolean;
};

const baseUrl = document.querySelector<HTMLInputElement>("#base-url");
const token = document.querySelector<HTMLInputElement>("#token");
const tokenHint = document.querySelector<HTMLParagraphElement>("#token-hint");
const status = document.querySelector<HTMLParagraphElement>("#settings-status");
const autostart = document.querySelector<HTMLInputElement>("#autostart");
const shortcuts = document.querySelector<HTMLDivElement>("#shortcuts");
const gesture = document.querySelector<HTMLSelectElement>("#gesture");
const gestureHint = document.querySelector<HTMLParagraphElement>("#gesture-hint");

if (!baseUrl || !token || !tokenHint || !status || !autostart || !shortcuts || !gesture || !gestureHint) {
  throw new Error("settings form is incomplete");
}

const baseUrlEl = baseUrl;
const tokenEl = token;
const tokenHintEl = tokenHint;
const statusEl = status;
const autostartEl = autostart;
const shortcutsEl = shortcuts;
const gestureEl = gesture;
const gestureHintEl = gestureHint;
let binds: ShortcutBinds | null = null;
let recording: keyof ShortcutBinds | null = null;

for (const choice of modifierChoices()) {
  const option = document.createElement("option");
  option.value = choice.value;
  option.textContent = choice.label;
  gestureEl.append(option);
}

function paintGesture() {
  const current = binds?.gesture ?? "Alt";
  gestureEl.value = current;
  gestureHintEl.textContent = gestureSnippet(current);
}

function paintShortcuts() {
  shortcutsEl.replaceChildren();
  if (!binds) {
    return;
  }
  const current = binds;
  for (const field of shortcutFields) {
    const row = document.createElement("div");
    row.className = "shortcut";
    const name = document.createElement("span");
    name.textContent = field.label;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = recording === field.id ? "Press shortcut" : formatBind(current[field.id]);
    button.classList.toggle("recording", recording === field.id);
    button.addEventListener("click", () => {
      recording = recording === field.id ? null : field.id;
      paintShortcuts();
    });
    row.append(name, button);
    shortcutsEl.append(row);
  }
}

async function loadShortcuts() {
  binds = await invoke<ShortcutBinds>("get_shortcuts");
  paintGesture();
  paintShortcuts();
}

gestureEl.addEventListener("change", () => {
  const binding = gestureEl.value;
  void invoke<ShortcutBinds>("save_shortcut", { id: "gesture", binding })
    .then((next) => {
      binds = next;
      paintGesture();
      statusEl.textContent = "Modifier saved.";
    })
    .catch((error: unknown) => {
      paintGesture();
      statusEl.textContent = String(error);
    });
});

async function loadSettings() {
  const settings = await invoke<Settings>("get_settings");
  baseUrlEl.value = settings.baseUrl;
  tokenEl.value = "";
  tokenHintEl.textContent = settings.hasToken
    ? "A token is saved on this Mac."
    : "No token saved.";
  autostartEl.checked = settings.launchAtLogin;
  statusEl.textContent = "";
}

document.querySelector("#save-settings")?.addEventListener("click", () => {
  void (async () => {
    statusEl.textContent = "";
    try {
      const typed = tokenEl.value.trim();
      await invoke("save_settings", {
        baseUrl: baseUrlEl.value.trim(),
        token: typed === "" ? null : typed,
      });
      tokenEl.value = "";
      await loadSettings();
      statusEl.textContent = "Saved.";
    } catch (error) {
      statusEl.textContent = String(error);
    }
  })();
});

document.querySelector("#test-connection")?.addEventListener("click", () => {
  void (async () => {
    statusEl.textContent = "Testing…";
    try {
      const typed = tokenEl.value.trim();
      if (baseUrlEl.value.trim() !== "" || typed !== "") {
        await invoke("save_settings", {
          baseUrl: baseUrlEl.value.trim(),
          token: typed === "" ? null : typed,
        });
      }
      const flavor = await invoke<string>("test_memos");
      statusEl.textContent = `Connected (${flavor}).`;
      await loadSettings();
    } catch (error) {
      statusEl.textContent = String(error);
    }
  })();
});

document.querySelector("#clear-memos")?.addEventListener("click", () => {
  void (async () => {
    try {
      await invoke("clear_memos");
      await loadSettings();
      statusEl.textContent = "Disconnected.";
    } catch (error) {
      statusEl.textContent = String(error);
    }
  })();
});

autostartEl.addEventListener("change", () => {
  void (async () => {
    try {
      await invoke("set_autostart", { enabled: autostartEl.checked });
    } catch (error) {
      statusEl.textContent = String(error);
      autostartEl.checked = !autostartEl.checked;
    }
  })();
});

window.addEventListener(
  "keydown",
  (event) => {
    if (!recording || !binds) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) {
      return;
    }
    const binding = eventToBind(event);
    if (!binding) {
      return;
    }
    const id = recording;
    recording = null;
    void invoke<ShortcutBinds>("save_shortcut", { id, binding })
      .then((next) => {
        binds = next;
        paintShortcuts();
        statusEl.textContent = "Shortcut saved.";
      })
      .catch((error: unknown) => {
        paintShortcuts();
        statusEl.textContent = String(error);
      });
  },
  true,
);

document.addEventListener("mousedown", (event) => {
  if (!recording) {
    return;
  }
  const target = event.target;
  if (target instanceof Node && shortcutsEl.contains(target)) {
    return;
  }
  recording = null;
  paintShortcuts();
});

void loadSettings().catch((error: unknown) => {
  statusEl.textContent = String(error);
});

paintGesture();

void loadShortcuts().catch((error: unknown) => {
  statusEl.textContent = String(error);
});
