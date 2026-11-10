import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { inTauri } from "../platform.ts";

type Listener = () => void;

let cached: number[] = [];
let watching = false;
const listeners = new Set<Listener>();

export function clampHueSwatches(swatches: number[]): number[] {
  const out: number[] = [];
  for (const raw of swatches) {
    const hue = Math.round(Number(raw));
    if (!Number.isFinite(hue) || hue < 0 || hue > 359 || out.includes(hue)) {
      continue;
    }
    out.push(hue);
    if (out.length >= 6) {
      break;
    }
  }
  return out;
}

export function hueSwatches(): number[] {
  return cached;
}

export function onHueSwatches(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  for (const fn of listeners) {
    fn();
  }
}

export async function loadHueSwatches(): Promise<number[]> {
  if (inTauri()) {
    cached = clampHueSwatches(await invoke<number[]>("list_hue_swatches"));
  }
  notify();
  return cached;
}

export async function saveHueSwatches(swatches: number[]): Promise<number[]> {
  cached = clampHueSwatches(swatches);
  if (inTauri()) {
    cached = clampHueSwatches(await invoke<number[]>("save_hue_swatches", { swatches: cached }));
  }
  notify();
  return cached;
}

export function watchHueSwatches() {
  if (watching || !inTauri()) {
    return;
  }
  watching = true;
  void listen<number[]>("hue-swatches-changed", (event) => {
    cached = clampHueSwatches(event.payload ?? []);
    notify();
  });
}
