import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { requireEl } from "./dom.ts";
import { bindHuePop } from "./look/hue-pop.ts";
import { paintSurface, tabFill, type ThemeName } from "./look/memo-chrome.ts";
import { inTauri } from "./platform.ts";
import type { PinTab, PinTabHit, PinTabs } from "./types.ts";

const HEIGHT = { collapsed: 12, open: 28, menu: 148 };
const TWEEN = { show: 140, hide: 400 };
const COLLAPSE_WAIT = 1000;

const stripEl = requireEl(document.querySelector<HTMLElement>("#strip"), "strip");
const tabsEl = requireEl(document.querySelector<HTMLElement>("#tabs"), "tabs");
const addEl = requireEl(document.querySelector<HTMLButtonElement>("#tab-add"), "tab-add");
const menuEl = requireEl(document.querySelector<HTMLElement>("#tab-menu"), "tab-menu");
const nameEl = requireEl(document.querySelector<HTMLInputElement>("#tab-name"), "tab-name");

let state: PinTabs = { version: 1, activeId: "", tabs: [] };
let theme: ThemeName = "light";
let menuTabId: string | null = null;
let paintHue = () => {};
let collapseTimer: ReturnType<typeof setTimeout> | undefined;
let menuTimer: ReturnType<typeof setTimeout> | undefined;
let heightTween = 0;
let liveHeight = HEIGHT.collapsed;
let lastAim: { id: string; mode: string } | null = null;

function currentTab(): PinTab | undefined {
  return state.tabs.find((tab) => tab.id === (menuTabId ?? state.activeId));
}

function tabLabel(tab: PinTab): string {
  const name = tab.name.trim();
  if (name) {
    return name;
  }
  const index = state.tabs.findIndex((item) => item.id === tab.id);
  return `Tab #${Math.max(0, index) + 1}`;
}

function persist(next: PinTabs) {
  state = next;
  paint();
}

async function load() {
  if (!inTauri()) {
    return;
  }
  const nextTheme = await invoke<string>("get_theme");
  theme = nextTheme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  paintSurface(document.documentElement, theme, null, 100);
  persist(await invoke<PinTabs>("list_pin_tabs"));
}

function paint() {
  const selected = state.activeId;
  tabsEl.replaceChildren(
    ...state.tabs.map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "pin-tab";
      button.dataset.id = tab.id;
      button.textContent = tabLabel(tab);
      button.title = tabLabel(tab);
      button.setAttribute("aria-label", tabLabel(tab));
      button.setAttribute("aria-current", String(tab.id === selected));
      button.style.background = tabFill(theme, tab.hue);
      button.addEventListener("click", () => {
        if (tab.id === state.activeId) {
          return;
        }
        void invoke<PinTabs>("select_pin_tab", { id: tab.id }).then(persist);
      });
      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        openMenu(tab, button);
      });
      return button;
    }),
  );
  const editing = currentTab();
  if (editing && !menuEl.hidden) {
    nameEl.value = editing.name;
    nameEl.placeholder = tabLabel(editing);
    paintHue();
  }
  applyAim();
  reportHits();
}

function applyAim() {
  for (const button of tabsEl.querySelectorAll<HTMLElement>(".pin-tab")) {
    const aim = lastAim;
    const mode = aim !== null && aim.id === button.dataset.id ? aim.mode : "off";
    button.classList.toggle("pin-tab-aim", mode === "hold" || mode === "ready");
    button.classList.toggle("pin-tab-ready", mode === "ready");
  }
}

function reportHits() {
  if (!inTauri()) {
    return;
  }
  const hits: PinTabHit[] = [...tabsEl.querySelectorAll<HTMLElement>(".pin-tab")]
    .map((button) => {
      const box = button.getBoundingClientRect();
      return {
        id: button.dataset.id ?? "",
        x: box.left,
        y: box.top,
        w: box.width,
        h: box.height,
      };
    })
    .filter((hit) => hit.id && hit.w > 0 && hit.h > 0);
  void invoke("set_pin_tab_hits", { hits });
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function openMenu(tab: PinTab, button: HTMLButtonElement) {
  clearTimeout(menuTimer);
  menuTabId = tab.id;
  menuEl.classList.remove("is-closing");
  menuEl.hidden = false;
  document.documentElement.classList.add("is-open", "is-menu");
  document.documentElement.classList.remove("is-hiding");
  nameEl.value = tab.name;
  nameEl.placeholder = tabLabel(tab);
  const left = Math.max(8, Math.min(button.offsetLeft, stripEl.clientWidth - 228));
  menuEl.style.left = `${left}px`;
  paintHue();
  void tweenHeight(HEIGHT.menu, TWEEN.show);
  nameEl.focus();
  nameEl.select();
}

function closeMenu() {
  menuTabId = null;
  document.documentElement.classList.remove("is-menu");
  if (menuEl.hidden) {
    return;
  }
  menuEl.classList.add("is-closing");
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => {
    menuEl.hidden = true;
    menuEl.classList.remove("is-closing");
  }, TWEEN.hide);
}

function tweenHeight(to: number, ms: number): Promise<void> {
  const ticket = ++heightTween;
  if (!inTauri()) {
    liveHeight = to;
    return Promise.resolve();
  }
  return (async () => {
    try {
      const win = getCurrentWindow();
      const size = await win.outerSize();
      const scale = await win.scaleFactor();
      const width = size.width / scale;
      const from = liveHeight;
      if (ticket !== heightTween) {
        return;
      }
      if (from === to || ms <= 0) {
        liveHeight = to;
        await win.setSize(new LogicalSize(width, to));
        return;
      }
      const started = performance.now();
      await new Promise<void>((resolve) => {
        const step = () => {
          if (ticket !== heightTween) {
            resolve();
            return;
          }
          const t = Math.min(1, (performance.now() - started) / ms);
          liveHeight = from + (to - from) * easeOutCubic(t);
          void win.setSize(new LogicalSize(width, liveHeight));
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            liveHeight = to;
            resolve();
          }
        };
        step();
      });
      reportHits();
    } catch {
      liveHeight = to;
    }
  })();
}

function expand() {
  clearTimeout(collapseTimer);
  document.documentElement.classList.add("is-open");
  document.documentElement.classList.remove("is-hiding");
  void tweenHeight(menuEl.hidden ? HEIGHT.open : HEIGHT.menu, TWEEN.show);
}

function scheduleCollapse() {
  if (!menuEl.hidden && !menuEl.classList.contains("is-closing")) {
    return;
  }
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (!menuEl.hidden && !menuEl.classList.contains("is-closing")) {
      return;
    }
    document.documentElement.classList.add("is-hiding");
    document.documentElement.classList.remove("is-open");
    void tweenHeight(HEIGHT.collapsed, TWEEN.hide).then(() => {
      if (liveHeight === HEIGHT.collapsed) {
        document.documentElement.classList.remove("is-hiding");
      }
    });
  }, COLLAPSE_WAIT);
}

addEl.addEventListener("click", () => {
  closeMenu();
  void invoke<PinTabs>("add_pin_tab").then(persist);
});

nameEl.addEventListener("input", () => {
  const id = menuTabId;
  if (!id) {
    return;
  }
  void invoke<PinTabs>("update_pin_tab", { id, name: nameEl.value }).then(persist);
});

nameEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === "Escape") {
    event.preventDefault();
    closeMenu();
    scheduleCollapse();
  }
});

stripEl.addEventListener("mouseenter", expand);
stripEl.addEventListener("mouseleave", scheduleCollapse);

document.addEventListener("mousedown", (event) => {
  if (menuEl.hidden) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (menuEl.contains(target) || (target instanceof HTMLElement && target.closest(".pin-tab"))) {
    return;
  }
  closeMenu();
  scheduleCollapse();
});

paintHue = bindHuePop(menuEl, {
  theme: () => theme,
  hue: () => currentTab()?.hue ?? 48,
  swatches: () => currentTab()?.swatches ?? [],
  setHue(hue) {
    const tab = currentTab();
    if (!tab) {
      return;
    }
    tab.hue = hue;
    paint();
    void invoke<PinTabs>("update_pin_tab", { id: tab.id, hue }).then(persist);
  },
  setSwatches(swatches) {
    const tab = currentTab();
    if (!tab) {
      return;
    }
    tab.swatches = swatches;
    void invoke<PinTabs>("update_pin_tab", { id: tab.id, swatches }).then(persist);
  },
});

void load();
if (inTauri()) {
  void listen("pin-tabs-changed", () => {
    void load();
  });
  void listen<[string, string]>("pin-tab-aim", (event) => {
    const [id, mode] = event.payload ?? [];
    lastAim = id && mode && mode !== "off" ? { id, mode } : null;
    applyAim();
  });
  void getCurrentWindow().listen<[number, number] | null>("window-cursor", (event) => {
    if (event.payload) {
      expand();
    } else {
      scheduleCollapse();
    }
  });
}
