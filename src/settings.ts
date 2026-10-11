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
  visibility: string;
  space: string;
};

type MemoSpace = {
  name: string;
  title: string;
};

const baseUrl = document.querySelector<HTMLInputElement>("#base-url");
const token = document.querySelector<HTMLInputElement>("#token");
const tokenHint = document.querySelector<HTMLParagraphElement>("#token-hint");
const status = document.querySelector<HTMLParagraphElement>("#settings-status");
const autostart = document.querySelector<HTMLInputElement>("#autostart");
const audience = document.querySelector<HTMLDivElement>("#memos-audience");
const visibilityChoices = document.querySelector<HTMLDivElement>("#visibility-choices");
const spaceChoices = document.querySelector<HTMLDivElement>("#space-choices");
const memoSpaceField = document.querySelector<HTMLParagraphElement>("#memo-space-field");
const shortcuts = document.querySelector<HTMLDivElement>("#shortcuts");
const gesture = document.querySelector<HTMLDivElement>("#gesture");
const gestureHint = document.querySelector<HTMLParagraphElement>("#gesture-hint");

if (
  !baseUrl ||
  !token ||
  !tokenHint ||
  !status ||
  !autostart ||
  !shortcuts ||
  !gesture ||
  !gestureHint ||
  !audience ||
  !visibilityChoices ||
  !spaceChoices ||
  !memoSpaceField
) {
  throw new Error("settings form is incomplete");
}

const baseUrlEl = baseUrl;
const tokenEl = token;
const tokenHintEl = tokenHint;
const statusEl = status;
const autostartEl = autostart;
const audienceEl = audience;
const visibilityChoicesEl = visibilityChoices;
const spaceChoicesEl = spaceChoices;
const memoSpaceFieldEl = memoSpaceField;
const shortcutsEl = shortcuts;
const gestureEl = gesture;
const gestureHintEl = gestureHint;
let binds: ShortcutBinds | null = null;
let recording: keyof ShortcutBinds | null = null;
let chosenVisibility = "PRIVATE";
let chosenSpace = "";
let knownSpaces: MemoSpace[] = [];

const visibilityOptions = [
  { value: "PRIVATE", label: "Private" },
  { value: "PROTECTED", label: "Signed-in users" },
  { value: "PUBLIC", label: "Public" },
  { value: "SPACE", label: "Space members" },
];

function paintGesture() {
  const current = binds?.gesture ?? "Alt";
  gestureEl.replaceChildren();
  for (const choice of modifierChoices()) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice.label;
    button.setAttribute("aria-pressed", String(choice.value === current));
    button.addEventListener("click", () => {
      void invoke<ShortcutBinds>("save_shortcut", { id: "gesture", binding: choice.value })
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
    gestureEl.append(button);
  }
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

function thisComputer(): string {
  const platform = navigator.platform;
  if (/Win/i.test(platform)) {
    return "this PC";
  }
  if (/Mac/i.test(platform)) {
    return "this Mac";
  }
  return "this computer";
}

async function loadSettings() {
  const settings = await invoke<Settings>("get_settings");
  baseUrlEl.value = settings.baseUrl;
  tokenEl.value = "";
  tokenHintEl.textContent = settings.hasToken
    ? `A token is saved on ${thisComputer()}.`
    : "No token saved.";
  autostartEl.checked = settings.launchAtLogin;
  chosenVisibility = settings.visibility || "PRIVATE";
  chosenSpace = settings.space || "";
  audienceEl.hidden = settings.baseUrl.trim() === "";
  await loadSpaces(chosenSpace);
  statusEl.textContent = "";
}

function paintAudienceChoices() {
  visibilityChoicesEl.replaceChildren();
  for (const option of visibilityOptions) {
    if (option.value === "SPACE" && knownSpaces.length === 0) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.setAttribute("aria-pressed", String(chosenVisibility === option.value));
    button.addEventListener("click", () => {
      chosenVisibility = option.value;
      if (option.value === "SPACE" && chosenSpace === "" && knownSpaces[0]) {
        chosenSpace = knownSpaces[0].name;
      }
      paintAudienceChoices();
      void saveAudience();
    });
    visibilityChoicesEl.append(button);
  }
  spaceChoicesEl.replaceChildren();
  memoSpaceFieldEl.hidden = knownSpaces.length === 0;
  spaceChoicesEl.hidden = knownSpaces.length === 0;
  const unassigned = document.createElement("button");
  unassigned.type = "button";
  unassigned.textContent = "Unassigned";
  unassigned.setAttribute("aria-pressed", String(chosenSpace === ""));
  unassigned.addEventListener("click", () => {
    chosenSpace = "";
    paintAudienceChoices();
    void saveAudience();
  });
  spaceChoicesEl.append(unassigned);
  for (const space of knownSpaces) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = space.title;
    button.setAttribute("aria-pressed", String(chosenSpace === space.name));
    button.addEventListener("click", () => {
      chosenSpace = space.name;
      paintAudienceChoices();
      void saveAudience();
    });
    spaceChoicesEl.append(button);
  }
}

async function loadSpaces(selected: string) {
  knownSpaces = [];
  if (!audienceEl.hidden) {
    try {
      knownSpaces = await invoke<MemoSpace[]>("list_memo_spaces");
    } catch (error) {
      console.error(error);
    }
  }
  chosenSpace = knownSpaces.some((space) => space.name === selected) ? selected : "";
  if (knownSpaces.length === 0 && chosenVisibility === "SPACE") {
    chosenVisibility = "PRIVATE";
  }
  paintAudienceChoices();
}

async function saveAudience() {
  if (chosenVisibility === "SPACE" && chosenSpace === "") {
    statusEl.textContent = "Choose a space for space members.";
    return;
  }
  try {
    await invoke("save_settings", {
      baseUrl: baseUrlEl.value.trim(),
      token: null,
      visibility: chosenVisibility,
      space: chosenSpace,
    });
    statusEl.textContent = "Audience saved.";
  } catch (error) {
    statusEl.textContent = String(error);
  }
}

document.querySelector("#save-settings")?.addEventListener("click", () => {
  void (async () => {
    statusEl.textContent = "";
    try {
      const typed = tokenEl.value.trim();
      await invoke("save_settings", {
        baseUrl: baseUrlEl.value.trim(),
        token: typed === "" ? null : typed,
        visibility: chosenVisibility,
        space: chosenSpace,
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
          visibility: chosenVisibility,
          space: chosenSpace,
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
