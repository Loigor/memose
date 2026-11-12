import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import { requireEl } from "./dom.ts";
import { bindHuePop } from "./look/hue-pop.ts";
import { paintSurface, tabFill, type ThemeName } from "./look/memo-chrome.ts";
import { loadHueSwatches, watchHueSwatches } from "./look/swatches.ts";
import { inTauri } from "./platform.ts";
import type { PinTab, PinTabHit, PinTabs } from "./types.ts";

const HEIGHT = { collapsed: 12, open: 28, menu: 148 };
const SIDE_MENU = 256;
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
let stripEdge: "top" | "bottom" | "left" | "right" = "top";
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
  await loadHueSwatches();
  paintHue();
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
  placeMenu(button);
  paintHue();
  void tweenHeight(goalThickness(), TWEEN.show);
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

function sideStrip(): boolean {
  return stripEdge === "left" || stripEdge === "right";
}

function goalThickness(): number {
  const menuOpen = !menuEl.hidden && !menuEl.classList.contains("is-closing");
  if (menuOpen) {
    return sideStrip() ? SIDE_MENU : HEIGHT.menu;
  }
  if (document.documentElement.classList.contains("is-open")) {
    return HEIGHT.open;
  }
  return HEIGHT.collapsed;
}

function placeMenu(button: HTMLButtonElement) {
  if (sideStrip()) {
    const top = Math.max(8, Math.min(button.offsetTop, Math.max(8, stripEl.clientHeight - 160)));
    menuEl.style.top = `${top}px`;
    menuEl.style.left = "";
    menuEl.style.right = "";
    menuEl.style.bottom = "";
    return;
  }
  const left = Math.max(8, Math.min(button.offsetLeft, Math.max(8, stripEl.clientWidth - 228)));
  menuEl.style.left = `${left}px`;
  menuEl.style.top = "";
  menuEl.style.right = "";
  menuEl.style.bottom = "";
}

function applyEdge(value: string) {
  const next = value === "bottom" || value === "left" || value === "right" ? value : "top";
  if (next === stripEdge) {
    document.documentElement.dataset.edge = stripEdge;
    return;
  }
  stripEdge = next;
  document.documentElement.dataset.edge = stripEdge;
  liveHeight = HEIGHT.collapsed;
  heightTween += 1;
  document.documentElement.classList.remove("is-open", "is-menu", "is-hiding");
  menuEl.hidden = true;
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
      const pos = await win.outerPosition();
      const scale = await win.scaleFactor();
      if (ticket !== heightTween) {
        return;
      }
      const factor = scale || 1;
      const vertical = sideStrip();
      const long = (vertical ? size.height : size.width) / factor;
      const originX = pos.x / factor;
      const originY = pos.y / factor;
      const fixedRight = (pos.x + size.width) / factor;
      const fixedBottom = (pos.y + size.height) / factor;
      const paint = (thickness: number) => {
        const x = stripEdge === "right" ? fixedRight - thickness : originX;
        const y = stripEdge === "bottom" ? fixedBottom - thickness : originY;
        const width = vertical ? thickness : long;
        const height = vertical ? long : thickness;
        if (stripEdge === "bottom" || stripEdge === "right") {
          void win.setPosition(new LogicalPosition(x, y));
        }
        void win.setSize(new LogicalSize(width, height));
      };
      const from = liveHeight;
      if (from === to || ms <= 0) {
        liveHeight = to;
        paint(to);
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
          paint(liveHeight);
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
  void tweenHeight(goalThickness(), TWEEN.show);
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
  chip: tabFill,
  setHue(hue) {
    const tab = currentTab();
    if (!tab) {
      return;
    }
    tab.hue = hue;
    paint();
    void invoke<PinTabs>("update_pin_tab", { id: tab.id, hue }).then(persist);
  },
});

void load();
if (inTauri()) {
  watchHueSwatches();
  void listen("pin-tabs-changed", () => {
    void load();
  });
  void listen<string>("pin-strip-edge", (event) => {
    applyEdge(event.payload);
  });
  void invoke<string>("pin_strip_edge").then(applyEdge).catch(() => applyEdge("top"));
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
