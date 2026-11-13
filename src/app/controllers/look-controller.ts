import { memoUsesCoder } from "../../editor/editor-field";
import { darkHue, lightHue, tinted, type Look } from "../../look/look";
import { paintSurface, paintThemeButton, palette, paperAt, type ThemeName } from "../../look/memo-chrome";
import { hueSwatches, loadHueSwatches, onHueSwatches, saveHueSwatches, watchHueSwatches } from "../../look/swatches";
import {
  activeStackSection,
  hasStack,
  repaintStackColors,
  sectionHue,
  sectionTheme,
  setSectionHue,
} from "../../stack";
import type { AppContext } from "../context";
import type { LookState } from "../state";

export type EditorView = {
  lineWrap?: boolean;
  folds?: number[][];
  marks?: number[][];
};

export interface LookEditor {
  adoptView(view: EditorView, restore: boolean): void;
  paintCoder(on: boolean): void;
  renderAfterCoderChange(): void;
  isPreviewing(): boolean;
  closeMenu(): void;
}

export interface LookSession {
  currentNoteId(): string | null;
  showingPinned(): boolean;
}

export interface LookInput {
  altHeld(): boolean;
}

export interface LookController {
  value(): Look;
  currentTheme(): ThemeName;
  paint(): void;
  paintThemeIcon(): void;
  adopt(next: Look, view?: EditorView): void;
  schedule(): void;
  flush(): Promise<void>;
  hasPending(): boolean;
  hasScheduledWrite(): boolean;
  saveImmediately(id: string): Promise<void>;
  discardPending(): void;
  randomHue(): void;
  loadTheme(): Promise<void>;
  applyPinnedThemeHint(): void;
  applySpaceDefault(hue: number | null): void;
  adjustOpacity(pixels: number, allPinned: boolean): void;
  acceptPinnedOpacity(opacity: number): void;
  watchSwatches(): void;
}

export function createLookController(
  context: AppContext,
  state: LookState,
  editor: LookEditor,
  session: LookSession,
  input: LookInput,
): LookController {
  const {
    card,
    themeToggle,
    themeIcon,
    colorPop,
    hueSlider,
    hueAdd,
    hueSlots,
    coderToggle,
  } = context.dom;

  function currentTheme(): ThemeName {
    return state.value.theme ?? context.mode.pinnedThemeHint ?? state.appTheme;
  }

  function themeHue(): number | null {
    return currentTheme() === "dark" ? state.value.hueDark : state.value.hueLight;
  }

  function activeHue(): number {
    return themeHue() ?? (currentTheme() === "dark" ? darkHue : lightHue);
  }

  function paintThemeIcon() {
    const alt = input.altHeld();
    const hostColorMode = hasStack() ? !alt : alt;
    paintThemeButton(themeToggle, themeIcon, currentTheme(), hostColorMode);
    repaintStackColors();
  }

  function paint() {
    const theme = currentTheme();
    const hue = theme === "dark" ? state.value.hueDark : state.value.hueLight;
    paintSurface(card, theme, hue, state.value.opacity);
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    root.style.setProperty("--paper-alpha", `${state.value.opacity}%`);
    const colors = hue == null ? null : palette(theme, hue);
    for (const name of tinted) {
      if (colors) {
        root.style.setProperty(name, colors[name]);
      } else {
        root.style.removeProperty(name);
      }
    }
    if (input.altHeld()) {
      paintThemeIcon();
    }
    editor.paintCoder(memoUsesCoder(state.value.coder));
    repaintStackColors();
  }

  function paintSlots() {
    const theme = currentTheme();
    const current = themeHue();
    const swatches = hueSwatches();
    hueSlots.forEach((slot, index) => {
      const hue = swatches[index];
      if (hue == null) {
        slot.style.background = "";
        delete slot.dataset.hue;
        slot.setAttribute("aria-pressed", "false");
        return;
      }
      slot.dataset.hue = String(hue);
      slot.style.background = paperAt(theme, hue);
      slot.setAttribute("aria-pressed", String(hue === current));
    });
    const hue = Number(hueSlider.value);
    hueAdd.disabled = swatches.length >= 6 || swatches.includes(hue);
  }

  function syncSlider() {
    const hue = activeHue();
    hueSlider.value = String(hue);
    hueSlider.style.setProperty("--thumb", paperAt(currentTheme(), hue));
    paintSlots();
  }

  function applyTheme(theme: ThemeName) {
    state.appTheme = theme;
    paintThemeIcon();
    paint();
    syncSlider();
  }

  function adopt(next: Look, view?: EditorView) {
    const before = memoUsesCoder(state.value.coder);
    state.value = {
      opacity: next.opacity,
      hueLight: next.hueLight,
      hueDark: next.hueDark,
      swatches: [...next.swatches],
      theme: next.theme,
      coder: next.coder ?? null,
    };
    state.opacityCarry = state.value.opacity;
    state.unsaved = false;
    if (view) {
      editor.adoptView(view, false);
    }
    const after = memoUsesCoder(state.value.coder);
    paint();
    if (before !== after && !editor.isPreviewing()) {
      editor.renderAfterCoderChange();
    }
    if (view) {
      editor.adoptView(view, true);
    }
    syncSlider();
  }

  function enqueue(id: string): Promise<void> {
    const saved = {
      ...state.value,
      swatches: [...state.value.swatches],
    };
    state.write = state.write
      .then(() => context.backend.saveLook(id, saved))
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error(error);
      });
    return state.write;
  }

  function schedule() {
    clearTimeout(state.timer);
    const id = session.currentNoteId();
    if (!id || !("__TAURI_INTERNALS__" in window)) {
      state.unsaved = true;
      return;
    }
    state.unsaved = false;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void enqueue(id);
    }, 80);
  }

  function flush(): Promise<void> {
    const pending = state.timer !== undefined || state.unsaved;
    clearTimeout(state.timer);
    state.timer = undefined;
    const id = session.currentNoteId();
    if (!pending || !id || !("__TAURI_INTERNALS__" in window)) {
      return Promise.resolve();
    }
    state.unsaved = false;
    return enqueue(id);
  }

  function discardPending() {
    clearTimeout(state.timer);
    state.timer = undefined;
    state.unsaved = false;
  }

  function saveImmediately(id: string): Promise<void> {
    discardPending();
    return enqueue(id);
  }

  function setThemeHue(hue: number) {
    if (currentTheme() === "dark") {
      state.value.hueDark = hue;
    } else {
      state.value.hueLight = hue;
    }
    paint();
    syncSlider();
    schedule();
  }

  function randomHue() {
    const target = activeStackSection();
    const current = target
      ? (sectionHue(target.state) ?? (sectionTheme(target.state) === "dark" ? darkHue : lightHue))
      : activeHue();
    const jitter = Math.random() * 36 - 18;
    const hue = Math.floor((current + 222.5 + jitter + 360) % 360);
    if (target) {
      const slider = target.section.querySelector<HTMLInputElement>(".hue-slider");
      if (slider) {
        slider.value = String(hue);
      }
      setSectionHue(target.section, target.state, hue);
      return;
    }
    setThemeHue(hue);
  }

  async function loadTheme() {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }
    const theme = await context.backend.getTheme();
    applyTheme(theme === "dark" ? "dark" : "light");
  }

  function applyPinnedThemeHint() {
    if (!context.mode.pinnedThemeHint) {
      return;
    }
    state.value.theme = context.mode.pinnedThemeHint;
    paint();
  }

  function applySpaceDefault(hue: number | null) {
    state.value.hueLight = hue;
    state.value.hueDark = hue;
    paint();
    syncSlider();
    schedule();
  }

  function schedulePinnedOpacity(opacity: number) {
    state.pinnedOpacityLive = opacity;
    if (state.pinnedOpacityFrame === 0) {
      state.pinnedOpacityFrame = requestAnimationFrame(() => {
        state.pinnedOpacityFrame = 0;
        void context.backend
          .setPinnedOpacity(state.pinnedOpacityLive, false)
          .catch((error: unknown) => {
            console.error(error);
          });
      });
    }
    clearTimeout(state.pinnedOpacityTimer);
    state.pinnedOpacityTimer = setTimeout(() => {
      state.pinnedOpacityTimer = undefined;
      void context.backend.setPinnedOpacity(state.pinnedOpacityLive).catch((error: unknown) => {
        console.error(error);
      });
    }, 160);
  }

  function adjustOpacity(pixels: number, allPinned: boolean) {
    state.opacityCarry = Math.min(100, Math.max(0, state.opacityCarry - pixels * 0.1));
    const next = Math.round(state.opacityCarry);
    if (next === state.value.opacity) {
      return;
    }
    state.value.opacity = next;
    paint();
    if (allPinned) {
      schedulePinnedOpacity(next);
      if (!session.showingPinned()) {
        schedule();
      }
      return;
    }
    schedule();
  }

  function acceptPinnedOpacity(opacity: number) {
    if (state.pinnedOpacityTimer !== undefined || !session.showingPinned()) {
      return;
    }
    const next = Math.min(100, Math.max(0, Math.round(opacity)));
    if (next === state.value.opacity) {
      return;
    }
    state.value.opacity = next;
    state.opacityCarry = next;
    paint();
  }

  function saveHue() {
    const hue = Number(hueSlider.value);
    const swatches = hueSwatches();
    if (swatches.includes(hue) || swatches.length >= 6) {
      return;
    }
    void saveHueSwatches([...swatches, hue]).then(() => {
      setThemeHue(hue);
    });
  }

  function watchSwatches() {
    watchHueSwatches();
    onHueSwatches(paintSlots);
    void loadHueSwatches();
  }

  coderToggle.addEventListener("click", () => {
    state.value.coder = !memoUsesCoder(state.value.coder);
    editor.paintCoder(memoUsesCoder(state.value.coder));
    if (!editor.isPreviewing()) {
      editor.renderAfterCoderChange();
    }
    schedule();
    editor.closeMenu();
  });

  themeToggle.addEventListener("click", (event) => {
    const alt = event.altKey || input.altHeld();
    const colorMode = hasStack() ? !alt : alt;
    if (colorMode) {
      colorPop.hidden = !colorPop.hidden;
      if (!colorPop.hidden) {
        syncSlider();
      }
      return;
    }
    colorPop.hidden = true;
    state.value.theme = currentTheme() === "dark" ? "light" : "dark";
    paintThemeIcon();
    paint();
    syncSlider();
    schedule();
  });

  hueSlider.addEventListener("input", () => {
    setThemeHue(Number(hueSlider.value));
  });

  for (const slot of hueSlots) {
    slot.addEventListener("click", () => {
      const raw = slot.dataset.hue;
      if (raw != null && raw !== "") {
        setThemeHue(Number(raw));
      }
    });
  }

  colorPop.addEventListener(
    "mousedown",
    (event) => {
      const slot = hueSlots.find((item) => {
        const rect = item.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      const addRect = hueAdd.getBoundingClientRect();
      const overAdd = event.clientX >= addRect.left && event.clientX <= addRect.right &&
        event.clientY >= addRect.top && event.clientY <= addRect.bottom;
      if (!slot && !overAdd) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (slot) {
        const raw = slot.dataset.hue;
        if (raw != null && raw !== "") {
          setThemeHue(Number(raw));
        }
        return;
      }
      saveHue();
    },
    true,
  );

  hueAdd.addEventListener("click", saveHue);

  document.addEventListener("mousedown", (event) => {
    if (colorPop.hidden) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && !colorPop.contains(target) && !themeToggle.contains(target)) {
      colorPop.hidden = true;
    }
  });

  return {
    value: () => state.value,
    currentTheme,
    paint,
    paintThemeIcon,
    adopt,
    schedule,
    flush,
    hasPending: () => state.timer !== undefined || state.unsaved,
    hasScheduledWrite: () => state.timer !== undefined,
    saveImmediately,
    discardPending,
    randomHue,
    loadTheme,
    applyPinnedThemeHint,
    applySpaceDefault,
    adjustOpacity,
    acceptPinnedOpacity,
    watchSwatches,
  };
}
