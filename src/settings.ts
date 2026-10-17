import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  eventToBind,
  eventToMouse,
  formatBind,
  gestureSnippet,
  modifierChoices,
  mouseChordToBind,
  shortcutFields,
  splitBinds,
  type ShortcutBinds,
} from "./shortcuts";

type Settings = {
  baseUrl: string;
  hasToken: boolean;
  launchAtLogin: boolean;
  visibility: string;
  space: string;
  snapMemos: boolean;
};

type MemoSpace = {
  name: string;
  title: string;
};

type TabId = "visibility" | "shortcuts" | "sync";

const baseUrl = document.querySelector<HTMLInputElement>("#base-url");
const token = document.querySelector<HTMLInputElement>("#token");
const tokenHint = document.querySelector<HTMLParagraphElement>("#token-hint");
const status = document.querySelector<HTMLParagraphElement>("#settings-status");
const autostart = document.querySelector<HTMLInputElement>("#autostart");
const snapMemos = document.querySelector<HTMLInputElement>("#snap-memos");
const audience = document.querySelector<HTMLDivElement>("#memos-audience");
const visibilityChoices = document.querySelector<HTMLDivElement>("#visibility-choices");
const spaceChoices = document.querySelector<HTMLDivElement>("#space-choices");
const memoSpaceField = document.querySelector<HTMLParagraphElement>("#memo-space-field");
const shortcuts = document.querySelector<HTMLDivElement>("#shortcuts");
const gesture = document.querySelector<HTMLDivElement>("#gesture");
const gestureHint = document.querySelector<HTMLParagraphElement>("#gesture-hint");
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-panel]"));

if (
  !baseUrl ||
  !token ||
  !tokenHint ||
  !status ||
  !autostart ||
  !snapMemos ||
  !shortcuts ||
  !gesture ||
  !gestureHint ||
  !audience ||
  !visibilityChoices ||
  !spaceChoices ||
  !memoSpaceField ||
  tabButtons.length === 0 ||
  tabPanels.length === 0
) {
  throw new Error("settings form is incomplete");
}

const baseUrlEl = baseUrl;
const tokenEl = token;
const tokenHintEl = tokenHint;
const statusEl = status;
const autostartEl = autostart;
const snapMemosEl = snapMemos;
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
let hasSyncConfigured = false;
const heldMods = {
  alt: false,
  ctrl: false,
  shift: false,
  meta: false,
};

const visibilityOptions = [
  { value: "PRIVATE", label: "Private" },
  { value: "PROTECTED", label: "Signed-in users" },
  { value: "PUBLIC", label: "Public" },
  { value: "SPACE", label: "Space members" },
];

function selectTab(nextTab: TabId) {
  if (recording) {
    recording = null;
    paintShortcuts();
  }
  for (const button of tabButtons) {
    const active = button.dataset.tab === nextTab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.panel !== nextTab;
  }
}

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab as TabId | undefined;
    if (tab) {
      selectTab(tab);
    }
  });
  button.addEventListener("keydown", (event) => {
    if (recording) {
      return;
    }
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const index = tabButtons.indexOf(button);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const target = tabButtons[(index + delta + tabButtons.length) % tabButtons.length];
    const tab = target?.dataset.tab as TabId | undefined;
    if (target && tab) {
      selectTab(tab);
      target.focus();
    }
  });
}

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

function saveBind(id: keyof ShortcutBinds, binding: string) {
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
    const list = document.createElement("div");
    list.className = "shortcut-binds";
    splitBinds(current[field.id]).forEach((binding, index) => {
      const chip = document.createElement("span");
      chip.className = "bind-chip";
      const label = document.createElement("span");
      label.textContent = formatBind(binding);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${formatBind(binding)}`);
      remove.addEventListener("click", () => {
        const next = splitBinds(current[field.id]).filter((_, item) => item !== index);
        if (next.length === 0) {
          statusEl.textContent = "Keep at least one shortcut.";
          return;
        }
        saveBind(field.id, next.join(", "));
      });
      chip.append(label, remove);
      list.append(chip);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "add";
    add.textContent = recording === field.id ? "Press shortcut" : "+";
    add.classList.toggle("recording", recording === field.id);
    add.addEventListener("click", () => {
      recording = recording === field.id ? null : field.id;
      paintShortcuts();
    });
    list.append(add);
    row.append(name, list);
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
  snapMemosEl.checked = settings.snapMemos;
  chosenVisibility = settings.visibility || "PRIVATE";
  chosenSpace = settings.space || "";
  hasSyncConfigured = settings.baseUrl.trim() !== "" && settings.hasToken;
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
  if (hasSyncConfigured) {
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
      baseUrl: null,
      token: null,
      visibility: chosenVisibility,
      space: chosenSpace,
    });
    statusEl.textContent = "Default memo visibility saved.";
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
      await loadSettings();
      statusEl.textContent = `Connected (${flavor}).`;
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

snapMemosEl.addEventListener("change", () => {
  const enabled = snapMemosEl.checked;
  void invoke("set_snap_memos", { enabled })
    .then(() => {
      statusEl.textContent = enabled ? "Window snap enabled." : "Window snap disabled.";
    })
    .catch((error: unknown) => {
      statusEl.textContent = String(error);
      snapMemosEl.checked = !enabled;
    });
});

autostartEl.addEventListener("change", () => {
  void (async () => {
    const enabled = autostartEl.checked;
    try {
      await invoke("set_autostart", { enabled });
      statusEl.textContent = enabled ? "Launch at login enabled." : "Launch at login disabled.";
    } catch (error) {
      statusEl.textContent = String(error);
      autostartEl.checked = !enabled;
    }
  })();
});

function syncHeldMods(event: KeyboardEvent) {
  heldMods.alt = event.altKey;
  heldMods.ctrl = event.ctrlKey;
  heldMods.shift = event.shiftKey;
  heldMods.meta = event.metaKey;
}

window.addEventListener("keyup", syncHeldMods, true);
window.addEventListener("blur", () => {
  heldMods.alt = false;
  heldMods.ctrl = false;
  heldMods.shift = false;
  heldMods.meta = false;
});

window.addEventListener(
  "keydown",
  (event) => {
    syncHeldMods(event);
    if (!recording || !binds) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) {
      return;
    }
    if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
      recording = null;
      paintShortcuts();
      return;
    }
    const binding = eventToBind(event);
    if (!binding || !binds) {
      return;
    }
    const id = recording;
    saveBind(id, [...splitBinds(binds[id]), binding].join(", "));
  },
  true,
);

function handleDomMouseRecord(event: MouseEvent) {
  if (event.button >= 3) {
    event.preventDefault();
  }
  if (!recording || !binds) {
    return;
  }
  const mouse = eventToMouse(event, heldMods);
  if (mouse) {
    event.preventDefault();
    event.stopPropagation();
    const id = recording;
    saveBind(id, [...splitBinds(binds[id]), mouse].join(", "));
    return;
  }
  if (event.type !== "mousedown" || event.button !== 0) {
    return;
  }
  const target = event.target;
  if (target instanceof Node && shortcutsEl.contains(target)) {
    return;
  }
  recording = null;
  paintShortcuts();
}

document.addEventListener("pointerdown", handleDomMouseRecord, true);
document.addEventListener("mousedown", handleDomMouseRecord, true);
document.addEventListener(
  "auxclick",
  (event) => {
    if (recording || event.button >= 3) {
      event.preventDefault();
    }
  },
  true,
);

void listen<{
  button: number;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}>("mouse-chord", (event) => {
  if (!recording || !binds) {
    return;
  }
  const payload = event.payload;
  const mouse = mouseChordToBind(
    payload.button,
    payload.alt || heldMods.alt,
    payload.ctrl || heldMods.ctrl,
    payload.shift || heldMods.shift,
    payload.meta || heldMods.meta,
  );
  if (!mouse) {
    return;
  }
  const id = recording;
  saveBind(id, [...splitBinds(binds[id]), mouse].join(", "));
});

selectTab("visibility");

void loadSettings().catch((error: unknown) => {
  statusEl.textContent = String(error);
});

paintGesture();

void loadShortcuts().catch((error: unknown) => {
  statusEl.textContent = String(error);
});
