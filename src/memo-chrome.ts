export type ThemeName = "light" | "dark";

export type SurfaceLook = {
  opacity: number;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  theme: ThemeName | null;
};

export function paperAt(theme: ThemeName, hue: number): string {
  return theme === "dark" ? `hsl(${hue} 22% 16%)` : `hsl(${hue} 100% 86%)`;
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
  if (theme === "dark") {
    return {
      "--paper": paperAt(theme, hue),
      "--ink": `hsl(${hue} 28% 93%)`,
      "--muted": `hsl(${hue} 14% 70%)`,
      "--button": `hsl(${hue} 30% 93% / 0.12)`,
      "--button-hover": `hsl(${hue} 30% 93% / 0.2)`,
      "--line": `hsl(${hue} 30% 93% / 0.14)`,
      "--rule": `hsl(${hue} 18% 90% / 0.42)`,
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
    "--rule": `hsl(${hue} 40% 24% / 0.38)`,
    "--shadow": `hsl(${hue} 70% 14% / 0.34)`,
    "--field": "hsl(0 0% 100% / 0.65)",
    "--pin-on": `hsl(${hue} 18% 14%)`,
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

export function colorGlyph(chip: string): string {
  return `<circle cx="8" cy="8" r="5" fill="${chip}" stroke="currentColor" stroke-width="1.2"/>`;
}

export function paintThemeButton(button: HTMLElement, icon: Element, theme: ThemeName, colorMode: boolean, chip: string) {
  if (colorMode) {
    icon.innerHTML = colorGlyph(chip);
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
          <span class="visibility-label" hidden></span>
          <span class="edited-sep" hidden>|</span>
          <span class="edited-at" hidden></span>
        </span>
      </div>
      <div class="header-actions">
        <div class="markdown-anchor">
          <button class="markdown-toggle" type="button" aria-label="Markdown" aria-expanded="false">M</button>
          <div class="markdown-pop" hidden>
            <button type="button" data-markdown="bold" aria-label="Bold">B</button>
            <button type="button" data-markdown="italic" aria-label="Italic">I</button>
            <button type="button" data-markdown="title" aria-label="Title">T</button>
            <button type="button" data-markdown="task" aria-label="Task list">[ ]</button>
            <button type="button" data-markdown="code" aria-label="Code">&lt;&gt;</button>
          </div>
        </div>
        <button class="mode-toggle" type="button" aria-label="Preview" aria-pressed="false">Preview</button>
        <div class="theme-anchor">
          <button class="theme-toggle icon-button" type="button" aria-label="Dark theme">
            <svg class="theme-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"></svg>
          </button>
          <div class="color-pop" hidden>
            <div class="hue-track">
              <input class="hue-slider" type="range" min="0" max="359" value="48" aria-label="Hue" />
            </div>
            <div class="hue-slots">
              <button type="button" class="hue-slot" aria-label="Saved color 1"></button>
              <button type="button" class="hue-slot" aria-label="Saved color 2"></button>
              <button type="button" class="hue-slot" aria-label="Saved color 3"></button>
              <button type="button" class="hue-slot" aria-label="Saved color 4"></button>
              <button type="button" class="hue-slot" aria-label="Saved color 5"></button>
              <button type="button" class="hue-slot" aria-label="Saved color 6"></button>
              <button class="hue-add" type="button" aria-label="Save hue">+</button>
            </div>
          </div>
        </div>
        <button class="pin-toggle icon-button" type="button" aria-label="Pin" aria-pressed="true">
          <span class="pin-glyph" aria-hidden="true"></span>
        </button>
      </div>
    </header>
  `;
}
