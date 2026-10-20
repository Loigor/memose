import { type SurfaceLook, type ThemeName } from "./memo-chrome.ts";
import type { Note } from "./types.ts";

export type Look = SurfaceLook;

export const lightHue = 48;
export const darkHue = 32;
export const tinted = [
  "--paper",
  "--ink",
  "--muted",
  "--button",
  "--button-hover",
  "--line",
  "--rule",
  "--shadow",
  "--field",
  "--pin-on",
];

export function namedTheme(value: string | null | undefined): ThemeName | null {
  if (value === "dark" || value === "light") {
    return value;
  }
  return null;
}

export function defaultLook(): Look {
  return { opacity: 100, hueLight: null, hueDark: null, swatches: [], theme: null };
}

export function lookFromNote(note: Note): Look {
  const swatches = Array.isArray(note.swatches) ? note.swatches : [];
  return {
    opacity: Math.min(100, Math.max(0, Math.round(note.opacity ?? 100))),
    hueLight: note.hueLight ?? null,
    hueDark: note.hueDark ?? null,
    swatches: swatches.filter((hue) => hue >= 0 && hue <= 359).slice(0, 6),
    theme: namedTheme(note.theme),
  };
}
