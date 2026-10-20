import { getCurrentWindow } from "@tauri-apps/api/window";

export function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function isPreviewWindow(): boolean {
  return inTauri() && getCurrentWindow().label === "media-preview";
}
