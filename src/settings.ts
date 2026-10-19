import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { paperAt } from "./memo-chrome";
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
  synced: boolean;
  hue: number | null;
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
const spaceHint = document.querySelector<HTMLParagraphElement>("#space-hint");
const newSpace = document.querySelector<HTMLFormElement>("#new-space");
const newSpaceTitle = document.querySelector<HTMLInputElement>("#new-space-title");
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
  !spaceHint ||
  !newSpace ||
  !newSpaceTitle ||
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
const spaceHintEl = spaceHint;
const newSpaceEl = newSpace;
const newSpaceTitleEl = newSpaceTitle;
const shortcutsEl = shortcuts;
const gestureEl = gesture;
const gestureHintEl = gestureHint;
let binds: ShortcutBinds | null = null;
let recording: keyof ShortcutBinds | null = null;
let chosenVisibility = "PRIVATE";
let chosenSpace = "";
let knownSpaces: MemoSpace[] = [];
let hasSyncConfigured = false;
let huePickerSpace: string | null = null;
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
  const showSpaces = hasSyncConfigured || knownSpaces.length > 0;
  memoSpaceFieldEl.hidden = !showSpaces;
  spaceHintEl.hidden = !showSpaces;
  spaceChoicesEl.hidden = !showSpaces;
  newSpaceEl.hidden = !hasSyncConfigured;
  spaceChoicesEl.replaceChildren();
  if (!showSpaces) {
    return;
  }
  spaceChoicesEl.append(unassignedSpaceRow());
  for (const space of knownSpaces) {
    spaceChoicesEl.append(spaceRow(space));
  }
}

function unassignedSpaceRow(): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "space-row";
  row.setAttribute("aria-pressed", String(chosenSpace === ""));
  const swatch = document.createElement("span");
  swatch.className = "space-swatch";
  const select = document.createElement("button");
  select.type = "button";
  select.className = "space-select";
  select.textContent = "Unassigned";
  select.addEventListener("click", () => {
    chosenSpace = "";
    if (chosenVisibility === "SPACE") {
      chosenVisibility = "PRIVATE";
    }
    paintAudienceChoices();
    void saveAudience();
  });
  const status = document.createElement("span");
  status.className = "space-status";
  row.append(swatch, select, status);
  return row;
}

function spaceRow(space: MemoSpace): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "space-row";
  const picking = huePickerSpace === space.name;
  row.classList.toggle("is-picking", picking);
  row.setAttribute("aria-pressed", String(chosenSpace === space.name));
  const hue = space.hue ?? 48;
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "space-swatch";
  swatch.setAttribute("aria-label", `Default color for ${space.title}`);
  swatch.setAttribute("aria-expanded", String(picking));
  if (space.hue != null) {
    swatch.style.background = paperAt("light", hue);
  }
  swatch.addEventListener("click", (event) => {
    event.stopPropagation();
    huePickerSpace = picking ? null : space.name;
    paintAudienceChoices();
  });
  const select = document.createElement("button");
  select.type = "button";
  select.className = "space-select";
  select.textContent = space.title;
  select.addEventListener("click", () => {
    chosenSpace = space.name;
    paintAudienceChoices();
    void saveAudience();
  });
  const status = document.createElement("span");
  status.className = space.synced ? "space-status" : "space-status missing";
  status.textContent = space.synced ? "Synced" : "Missing from server";
  row.append(swatch, select, status);
  if (picking) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "space-hue";
    slider.min = "0";
    slider.max = "359";
    slider.value = String(hue);
    slider.setAttribute("aria-label", `Default color for ${space.title}`);
    slider.style.setProperty("--thumb", paperAt("light", hue));
    slider.addEventListener("input", () => {
      const next = Number(slider.value);
      space.hue = next;
      swatch.style.background = paperAt("light", next);
      slider.style.setProperty("--thumb", paperAt("light", next));
    });
    slider.addEventListener("change", () => {
      const next = Number(slider.value);
      space.hue = next;
      void invoke("set_space_hue", { name: space.name, hue: next })
        .then(() => {
          statusEl.textContent = `Default color saved for ${space.title}.`;
        })
        .catch((error: unknown) => {
          statusEl.textContent = String(error);
        });
    });
    row.append(slider);
  }
  if (!space.synced) {
    const actions = document.createElement("div");
    actions.className = "space-actions";
    const create = document.createElement("button");
    create.type = "button";
    create.textContent = "Create on server";
    create.addEventListener("click", () => {
      void createSpace(space.title, space.name);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Remove locally";
    remove.addEventListener("click", () => {
      void forgetSpace(space);
    });
    actions.append(create, remove);
    row.append(actions);
  }
  return row;
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

async function createSpace(title: string, name?: string) {
  const trimmed = title.trim();
  if (!trimmed) {
    statusEl.textContent = "Name the space first.";
    return;
  }
  try {
    const created = await invoke<MemoSpace>("create_memo_space", {
      title: trimmed,
      name: name ?? null,
    });
    newSpaceTitleEl.value = "";
    if (name) {
      await loadSpaces(chosenSpace);
    } else {
      await loadSpaces(created.name);
      void saveAudience();
    }
    statusEl.textContent = name ? `Created ${created.title} on the server.` : `Created ${created.title}.`;
  } catch (error) {
    statusEl.textContent = String(error);
  }
}

async function forgetSpace(space: MemoSpace) {
  try {
    await invoke("forget_memo_space", { name: space.name });
    await loadSettings();
    statusEl.textContent = `Removed ${space.title} locally. Memos in it are unassigned.`;
  } catch (error) {
    statusEl.textContent = String(error);
  }
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

newSpaceEl.addEventListener("submit", (event) => {
  event.preventDefault();
  void createSpace(newSpaceTitleEl.value);
});

document.addEventListener("pointerdown", (event) => {
  if (!huePickerSpace) {
    return;
  }
  const target = event.target;
  const picker = spaceChoicesEl.querySelector(".space-row.is-picking");
  if (target instanceof Node && picker?.contains(target)) {
    return;
  }
  huePickerSpace = null;
  paintAudienceChoices();
});

void listen("spaces-changed", () => {
  if (!hasSyncConfigured) {
    return;
  }
  void loadSpaces(chosenSpace).catch((error: unknown) => {
    statusEl.textContent = String(error);
  });
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
