import { getCurrentWindow } from "@tauri-apps/api/window";

export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** macOS uses Cmd for app shortcuts; Windows and Linux use Ctrl. */
export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function isPreviewWindow(): boolean {
  return inTauri() && getCurrentWindow().label === "media-preview";
}
