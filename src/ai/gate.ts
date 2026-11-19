/**
 * Loads the AI and recording code only once model prompts or recording are turned on.
 * With both off, a memo window pays for one settings read and two event listeners.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type MemoAi = typeof import("./mount");

let loaded: MemoAi | null = null;
let loading = false;
let watching = false;
const waiting = new Set<(ai: MemoAi) => void>();

function load() {
  if (loading) {
    return;
  }
  loading = true;
  import("./mount").then(
    (ai) => {
      loaded = ai;
      for (const run of waiting) {
        run(ai);
      }
      waiting.clear();
    },
    (error: unknown) => {
      loading = false;
      console.error(error);
    },
  );
}

async function check() {
  if (loading) {
    return;
  }
  try {
    const settings = await invoke<{ llmEnabled?: boolean; speechEnabled?: boolean }>("get_settings");
    if (settings.llmEnabled || settings.speechEnabled) {
      load();
    }
  } catch {
    // Settings that cannot be read leave the features off.
  }
}

/** Runs `mount` once either feature is on. The returned function undoes it, or cancels the wait. */
export function mountAiWhenEnabled(mount: (ai: MemoAi) => () => void): () => void {
  if (loaded) {
    return mount(loaded);
  }
  let destroy: (() => void) | null = null;
  const run = (ai: MemoAi) => {
    destroy = mount(ai);
  };
  waiting.add(run);
  if (!watching) {
    watching = true;
    void listen("ai-settings-changed", () => void check());
    void listen("speech-settings-changed", () => void check());
    void check();
  }
  return () => {
    waiting.delete(run);
    destroy?.();
  };
}
