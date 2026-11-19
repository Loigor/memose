export type ThemeName = "light" | "dark";

export type SurfaceLook = {
  opacity: number;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  theme: ThemeName | null;
  coder: boolean | null;
};

// A memo hue is stored as an angle on the sRGB hue wheel (the HSL hue), so a saved
// red stays red. That wheel is uneven to the eye: about a sixth of it is one green,
// and dark tints of it are near grey. Colours are drawn in OKLCH at the matching
// perceptual hue, and the slider and Alt+Enter move evenly through that hue.

/** OKLCH hue of the pure sRGB colour at each whole HSL hue 0–360, unwrapped so it only rises. */
const OK_HUES: number[] = (() => {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const out: number[] = [];
  for (let h = 0; h <= 360; h += 1) {
    const k = (n: number) => (n + h / 30) % 12;
    const channel = (n: number) => linear(0.5 - 0.5 * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
    const [r, g, b] = [channel(0), channel(8), channel(4)];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    let angle = (Math.atan2(bb, a) * 180) / Math.PI;
    const previous = out[out.length - 1];
    if (previous !== undefined) {
      // Unwrap a full turn; near pure blue the hue dips a fraction, which stays flat.
      while (angle < previous - 180) {
        angle += 360;
      }
      angle = Math.max(angle, previous);
    }
    out.push(angle);
  }
  return out;
})();

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

/** The OKLCH hue that looks like this stored hue. */
export function okHue(hue: number): number {
  const h = wrapHue(hue);
  const i = Math.floor(h);
  const from = OK_HUES[i];
  const to = OK_HUES[i + 1];
  return wrapHue(from + (to - from) * (h - i));
}

/** Where a stored hue sits on an even, perceptual 0–360 wheel (slider position). */
export function huePosition(hue: number): number {
  const h = wrapHue(hue);
  const i = Math.floor(h);
  const ok = OK_HUES[i] + (OK_HUES[i + 1] - OK_HUES[i]) * (h - i);
  return wrapHue(ok - OK_HUES[0]);
}

/** The stored hue (whole degree) at a position on the perceptual wheel. */
export function hueAtPosition(position: number): number {
  const target = wrapHue(position) + OK_HUES[0];
  let low = 0;
  let high = OK_HUES.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (OK_HUES[mid] <= target) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const span = OK_HUES[high] - OK_HUES[low];
  const h = low + (span > 0 ? (target - OK_HUES[low]) / span : 0);
  return Math.round(h) % 360;
}

// Past the colour wheel a memo can take a grey. Stored values 360–363 are greys;
// no value (null) is the theme's default paper. On the slider they follow the wheel:
// four grey bands that step toward the default, and the default last.
export const GREY_BASE = 360;
export const GREYS = 4;
/** Largest stored hue value (the last grey). Rust keeps the same bound (notes::MAX_HUE). */
export const MAX_HUE = GREY_BASE + GREYS - 1;
const GREY_BAND = 14;
/** Slider `max` for a memo (greys, then the default) and for a tab (greys only; a tab always has a colour). */
export const HUE_SLIDER_MAX = GREY_BASE + (GREYS + 1) * GREY_BAND - 1;
export const TAB_HUE_SLIDER_MAX = GREY_BASE + GREYS * GREY_BAND - 1;

// Lighter to darker toward the dark default (#25282c), and darker to lighter in light.
const DARK_GREYS = [0.44, 0.39, 0.35, 0.31];
const LIGHT_GREYS = [0.8, 0.85, 0.9, 0.95];
const DARK_TAB_GREYS = [0.56, 0.5, 0.44, 0.38];
const LIGHT_TAB_GREYS = [0.92, 0.87, 0.82, 0.77];

/** Which grey (0–3) a stored value is, or null for a colour. */
export function greyIndex(hue: number): number | null {
  return hue >= GREY_BASE && hue <= MAX_HUE ? hue - GREY_BASE : null;
}

/** A stored hue value: a colour 0–359 or a grey. */
export function isStoredHue(hue: unknown): hue is number {
  return typeof hue === "number" && Number.isInteger(hue) && hue >= 0 && hue <= MAX_HUE;
}

/** A hue slider runs on the perceptual wheel, then greys; these keep the stored value on the outside. */
export function readHueSlider(slider: HTMLInputElement): number | null {
  const position = Number(slider.value);
  if (position < GREY_BASE) {
    return hueAtPosition(position);
  }
  const band = Math.floor((position - GREY_BASE) / GREY_BAND);
  return band < GREYS ? GREY_BASE + band : null;
}

export function writeHueSlider(slider: HTMLInputElement, hue: number | null) {
  const grey = hue == null ? GREYS : greyIndex(hue);
  if (grey == null) {
    slider.value = String(Math.round(huePosition(hue ?? 0)) % 360);
    return;
  }
  const max = Number(slider.max) || HUE_SLIDER_MAX;
  slider.value = String(Math.min(max, GREY_BASE + grey * GREY_BAND + Math.floor(GREY_BAND / 2)));
}

/** Alt+Enter: a hue clearly unlike this one. A golden-angle step on the even wheel, a little jitter. */
export function nextRandomHue(current: number): number {
  if (greyIndex(current) != null) {
    return hueAtPosition(Math.random() * 360);
  }
  const jitter = Math.random() * 30 - 15;
  return hueAtPosition(huePosition(current) + 137.5 + jitter);
}

const TRACK_STEPS = 24;

/**
 * Paint the track under a hue slider with the colour each position gives, from the same
 * function that colours the memo (or tab), so the slider shows what will be applied:
 * the colour wheel, then flat grey bands, then the default. Stops are inset by half the
 * thumb so each colour sits under the thumb's centre.
 */
export function paintHueTrack(slider: HTMLInputElement, color: (hue: number | null) => string, thumb = 14) {
  const max = Number(slider.max) || HUE_SLIDER_MAX;
  const half = thumb / 2;
  const stop = (value: string, position: number) => {
    const at = Math.min(1, Math.max(0, position / max)).toFixed(4);
    return `${value} calc(${half}px + (100% - ${thumb}px) * ${at})`;
  };
  const stops: string[] = [];
  for (let i = 0; i <= TRACK_STEPS; i += 1) {
    const position = (i / TRACK_STEPS) * (GREY_BASE - 1);
    stops.push(stop(color(hueAtPosition(position)), position));
  }
  for (let band = 0; band <= GREYS; band += 1) {
    const from = GREY_BASE + band * GREY_BAND - 0.5;
    if (from >= max) {
      break;
    }
    const value = color(band < GREYS ? GREY_BASE + band : null);
    stops.push(stop(value, from), stop(value, from + GREY_BAND));
  }
  const track = `linear-gradient(90deg, ${stops.join(", ")})`;
  if (slider.dataset.track !== track) {
    slider.dataset.track = track;
    slider.style.setProperty("--track", track);
  }
}

/** The memo paper for a stored hue; null is the theme's default paper. */
export function paperAt(theme: ThemeName, hue: number | null): string {
  if (hue == null) {
    return baseColors(theme)["--paper"];
  }
  const grey = greyIndex(hue);
  if (grey != null) {
    return theme === "dark" ? `oklch(${DARK_GREYS[grey]} 0.006 255)` : `oklch(${LIGHT_GREYS[grey]} 0.004 255)`;
  }
  return theme === "dark" ? `oklch(0.31 0.06 ${okHue(hue).toFixed(1)})` : `hsl(${hue} 100% 86%)`;
}

/** Tab colour: deep in dark (white text), soft in light (dark text). */
export function tabFill(theme: ThemeName, hue: number): string {
  const grey = greyIndex(hue);
  if (grey != null) {
    return theme === "dark" ? `oklch(${DARK_TAB_GREYS[grey]} 0.006 255)` : `oklch(${LIGHT_TAB_GREYS[grey]} 0.004 255)`;
  }
  const ok = okHue(hue).toFixed(1);
  return theme === "dark" ? `oklch(0.46 0.11 ${ok})` : `oklch(0.84 0.09 ${ok})`;
}

export function baseColors(theme: ThemeName): Record<string, string> {
  if (theme === "dark") {
    return {
      "--paper": "#25282c",
      "--ink": "#dbdee2",
      "--muted": "#a2a5a9",
      "--button": "#32363b",
      "--button-hover": "#3e464f",
      "--line": "#3f4348",
      "--rule": "#3f4348",
      "--shadow": "rgba(0, 0, 0, 0.5)",
      "--field": "#1d1f23",
      "--pin-on": "#dbdee2",
    };
  }
  return {
    "--paper": "#fff4b8",
    "--ink": "#3d3420",
    "--muted": "#7a6840",
    "--button": "rgba(80, 58, 16, 0.08)",
    "--button-hover": "rgba(80, 58, 16, 0.16)",
    "--line": "rgba(80, 58, 16, 0.12)",
    "--rule": "rgba(80, 58, 16, 0.38)",
    "--shadow": "rgba(60, 42, 8, 0.34)",
    "--field": "rgba(255, 255, 255, 0.65)",
    "--pin-on": "#2c261c",
  };
}

export function palette(theme: ThemeName, hue: number): Record<string, string> {
  if (greyIndex(hue) != null) {
    return greyPalette(theme, hue);
  }
  if (theme === "dark") {
    return {
      "--paper": paperAt(theme, hue),
      "--ink": `hsl(${hue} 28% 93%)`,
      "--muted": `hsl(${hue} 14% 70%)`,
      "--button": `hsl(${hue} 30% 93% / 0.12)`,
      "--button-hover": `hsl(${hue} 30% 93% / 0.2)`,
      "--line": `hsl(${hue} 30% 93% / 0.14)`,
      "--rule": "#3f4348",
      "--shadow": "hsl(0 0% 0% / 0.55)",
      "--field": "hsl(0 0% 100% / 0.06)",
      "--pin-on": `hsl(${hue} 40% 96%)`,
    };
  }
  return {
    "--paper": paperAt(theme, hue),
    "--ink": `hsl(${hue} 34% 18%)`,
    "--muted": `hsl(${hue} 32% 36%)`,
    "--button": `hsl(${hue} 50% 18% / 0.08)`,
    "--button-hover": `hsl(${hue} 50% 18% / 0.16)`,
    "--line": `hsl(${hue} 50% 18% / 0.12)`,
    "--rule": "rgba(80, 58, 16, 0.38)",
    "--shadow": `hsl(${hue} 70% 14% / 0.34)`,
    "--field": "hsl(0 0% 100% / 0.65)",
    "--pin-on": `hsl(${hue} 18% 14%)`,
  };
}

/** A grey paper takes neutral ink: the dark defaults, or a neutral take on the light ones. */
function greyPalette(theme: ThemeName, hue: number): Record<string, string> {
  if (theme === "dark") {
    return { ...baseColors("dark"), "--paper": paperAt(theme, hue) };
  }
  return {
    "--paper": paperAt(theme, hue),
    "--ink": "#26282b",
    "--muted": "#5f6368",
    "--button": "rgba(0, 0, 0, 0.07)",
    "--button-hover": "rgba(0, 0, 0, 0.14)",
    "--line": "rgba(0, 0, 0, 0.11)",
    "--rule": "rgba(0, 0, 0, 0.3)",
    "--shadow": "rgba(0, 0, 0, 0.28)",
    "--field": "rgba(255, 255, 255, 0.65)",
    "--pin-on": "#1f2124",
  };
}

export function paintSurface(el: HTMLElement, theme: ThemeName, hue: number | null, opacity: number) {
  const colors = hue == null ? baseColors(theme) : palette(theme, hue);
  for (const [name, value] of Object.entries(colors)) {
    el.style.setProperty(name, value);
  }
  el.style.setProperty("--paper-alpha", `${opacity}%`);
  el.style.colorScheme = theme;
}

export function themeGlyph(dark: boolean): string {
  return dark
    ? `<circle cx="8" cy="8" r="2.4" fill="currentColor"/><path stroke="currentColor" stroke-width="1.3" d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3"/>`
    : `<path fill="currentColor" d="M8 1.6a6.2 6.2 0 1 0 5.6 8.7A4.7 4.7 0 0 1 8 1.6z"/>`;
}

export function huePopInnerHtml(): string {
  return `
    <div class="hue-track">
      <input class="hue-slider" type="range" min="0" max="${HUE_SLIDER_MAX}" value="48" aria-label="Hue" />
    </div>
    <div class="hue-slots">
      <button type="button" class="hue-slot" aria-label="Saved color 1"></button>
      <button type="button" class="hue-slot" aria-label="Saved color 2"></button>
      <button type="button" class="hue-slot" aria-label="Saved color 3"></button>
      <button type="button" class="hue-slot" aria-label="Saved color 4"></button>
      <button type="button" class="hue-slot" aria-label="Saved color 5"></button>
      <button type="button" class="hue-slot" aria-label="Saved color 6"></button>
      <button class="hue-add" type="button" aria-label="Save hue">+</button>
    </div>`;
}

export function huePopHtml(): string {
  return `<div class="color-pop" hidden>${huePopInnerHtml()}</div>`;
}

export function markdownToolbarHtml(): string {
  return `<div class="md-toolbar" hidden>${markdownButtonsHtml()}</div>`;
}

function markdownButtonsHtml(): string {
  return `
    <button type="button" data-markdown="bold" aria-label="Bold">Bold</button>
    <button type="button" data-markdown="italic" aria-label="Italic">Italic</button>
    <button type="button" data-markdown="title" aria-label="Title">Title</button>
    <button type="button" data-markdown="list" aria-label="Bullet list">List</button>
    <button type="button" data-markdown="ordered" aria-label="Numbered list">Numbered</button>
    <button type="button" data-markdown="task" aria-label="Task list">Task</button>
    <button type="button" data-markdown="quote" aria-label="Quote">Quote</button>
    <button type="button" data-markdown="code" aria-label="Code block">Code block</button>`;
}

/** The record button of a memo header. Hidden until recording is turned on. */
export function recAnchorHtml(): string {
  return `<div class="rec-anchor" hidden>
    <button class="rec-toggle icon-button" type="button" aria-label="Record" aria-pressed="false" title="Record">
      <span class="rec-glyph" aria-hidden="true"></span>
    </button>
  </div>`;
}

/** The AI button of a memo header. Hidden until model prompts are turned on. */
export function aiAnchorHtml(): string {
  return `<div class="ai-anchor" hidden>
    <button class="ai-toggle icon-button" type="button" aria-label="AI prompt" aria-expanded="false" title="AI prompt">AI</button>
  </div>`;
}

export function formatMenuHtml(): string {
  return `<div class="format-anchor">
    <button class="format-toggle icon-button" type="button" aria-label="Format" aria-expanded="false" title="Format">Format</button>
    <div class="format-pop" hidden>
      <button type="button" data-format="document">Format document</button>
      <button type="button" data-format="wrap" aria-pressed="false"><span class="format-check" aria-hidden="true"></span>Line wrap</button>
    </div>
  </div>`;
}

export function paintThemeButton(button: HTMLElement, icon: Element, theme: ThemeName, colorMode: boolean) {
  button.classList.toggle("color-mode", colorMode);
  if (colorMode) {
    icon.innerHTML = "";
    button.setAttribute("aria-label", "Memo color");
    button.title = "Memo color";
    return;
  }
  const dark = theme === "dark";
  button.setAttribute("aria-label", dark ? "Light theme" : "Dark theme");
  button.title = dark ? "Light theme" : "Dark theme";
  icon.innerHTML = themeGlyph(dark);
}

/** Same header controls as the main memo window, without ids so several can sit in one stack. */
export function stackHeaderHtml(): string {
  return `
    <header>
      <div class="brand">
        <span class="brand-name">Memose</span>
        <span class="note-title"></span>
        <span class="note-meta">
          <span class="note-audience-row">
            <span class="audience-anchor">
              <button class="visibility-label" type="button" hidden>Private</button>
              <div class="audience-pop" hidden>
                <p class="pop-label">Who can see this</p>
                <div class="visibility-choices"></div>
                <div class="space-block" hidden>
                  <p class="pop-label">Space</p>
                  <div class="space-choices"></div>
                </div>
                <div class="audience-foot">
                  <button class="delete-note" type="button">Delete memo</button>
                  <div class="delete-confirm" hidden>
                    <span>Delete this memo?</span>
                    <span class="audience-confirm-actions">
                      <button class="delete-no" type="button">Cancel</button>
                      <button class="delete-yes" type="button">Delete</button>
                    </span>
                  </div>
                </div>
              </div>
            </span>
            <span class="note-sync sync" hidden></span>
          </span>
          <span class="edited-sep" hidden>|</span>
          <span class="edited-at" hidden></span>
        </span>
      </div>
      <div class="header-actions">
        ${recAnchorHtml()}
        ${aiAnchorHtml()}
        <div class="editor-tools-anchor">
          <button class="editor-menu-toggle icon-button" type="button" aria-label="Editor options" aria-expanded="false" title="Editor options">
            <span class="menu-glyph" aria-hidden="true"></span>
          </button>
          <div class="editor-tools">
            <button class="markdown-toggle icon-button" type="button" aria-label="Markdown toolbar" aria-pressed="false" title="Markdown toolbar">
              <span class="markdown-glyph" aria-hidden="true"></span>
            </button>
            <button class="coder-toggle icon-button" type="button" aria-label="Coder editor" aria-pressed="false" title="Coder editor">
              { }
            </button>
            ${formatMenuHtml()}
            <button class="mode-toggle icon-button" type="button" aria-label="Preview" aria-pressed="false" title="Preview">
              <span class="preview-glyph" aria-hidden="true"></span>
            </button>
            <div class="theme-anchor">
              <button class="theme-toggle icon-button" type="button" aria-label="Dark theme">
                <svg class="theme-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"></svg>
              </button>
              ${huePopHtml()}
            </div>
          </div>
        </div>
      </div>
      <button class="fold-toggle icon-button" type="button" aria-label="Fold memo" title="Fold memo">
        <span class="collapsed-chevron" aria-hidden="true"></span>
      </button>
      <button class="pin-toggle icon-button" type="button" aria-label="Pin" aria-pressed="true">
        <span class="pin-glyph" aria-hidden="true"></span>
      </button>
    </header>
  `;
}
