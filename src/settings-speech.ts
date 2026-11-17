/** The Recording tab: the microphone, where speech becomes text, and the built-in model download. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { megabytes, type MicrophonePermission, type SpeechSettings, type SpeechSource } from "./ai/speech";

type Progress = {
  received: number;
  total: number;
  stage: "runtime" | "model" | "unpacking" | "done" | "error";
  error: string | null;
};

function required<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`settings form is incomplete: ${selector}`);
  }
  return found;
}

export function initSpeechSettings(status: HTMLElement) {
  const enabled = required<HTMLInputElement>("#speech-enabled");
  const device = required<HTMLSelectElement>("#speech-device");
  const keepAudio = required<HTMLInputElement>("#speech-keep-audio");
  const sourceEl = required<HTMLElement>("#speech-source");
  const localPanel = required<HTMLElement>("#speech-local");
  const serverPanel = required<HTMLElement>("#speech-server");
  const engineStatus = required<HTMLElement>("#speech-engine-status");
  const progress = required<HTMLProgressElement>("#speech-progress");
  const download = required<HTMLButtonElement>("#speech-download");
  const remove = required<HTMLButtonElement>("#speech-remove");
  const baseUrl = required<HTMLInputElement>("#speech-base-url");
  const where = required<HTMLElement>("#speech-where");
  const key = required<HTMLInputElement>("#speech-key");
  const keyHint = required<HTMLElement>("#speech-key-hint");
  const keyRemove = required<HTMLButtonElement>("#speech-key-remove");
  const model = required<HTMLInputElement>("#speech-model");
  const language = required<HTMLInputElement>("#speech-language");
  const polish = required<HTMLSelectElement>("#speech-polish");
  const polishHint = required<HTMLElement>("#speech-polish-hint");
  const permissionRow = required<HTMLElement>("#speech-permission");
  const permissionText = required<HTMLElement>("#speech-permission-text");
  const permissionAsk = required<HTMLButtonElement>("#speech-permission-ask");
  const permissionOpen = required<HTMLButtonElement>("#speech-permission-open");
  let downloading = false;

  const paintPermission = (microphone: MicrophonePermission) => {
    const { access, borrowed } = microphone;
    permissionRow.hidden = access === "notNeeded";
    permissionRow.dataset.access = access;
    permissionAsk.hidden = access !== "unknown";
    permissionOpen.hidden = access === "granted" || access === "unknown";
    if (borrowed) {
      // A dev run: the system's answer belongs to the terminal or editor that started Memose.
      permissionText.textContent =
        access === "granted"
          ? "Microphone allowed for the app that started Memose (Memose runs from a terminal)."
          : "Memose runs from a terminal, so macOS asks for and lists the app that started it, such as Cursor or Terminal, not Memose. Allow that app under Microphone and start it again.";
      permissionOpen.hidden = access === "granted";
      return;
    }
    permissionText.textContent =
      access === "granted"
        ? "Microphone allowed."
        : access === "denied"
          ? "macOS does not let Memose use the microphone. Allow Memose under Privacy & Security › Microphone."
          : "macOS has not asked yet. It asks the first time you record, or now with the button.";
  };

  const paintEngine = (settings: SpeechSettings) => {
    const { engine } = settings;
    remove.hidden = !engine.installed || downloading;
    download.hidden = engine.installed || !engine.supported;
    download.disabled = downloading;
    if (!engine.supported) {
      engineStatus.textContent =
        "The built-in recognizer is not available for this computer. Use a speech server instead.";
    } else if (engine.installed) {
      engineStatus.textContent = `Ready. The download uses ${megabytes(engine.diskBytes)} on this computer.`;
    } else if (!downloading) {
      engineStatus.textContent = `Needs a one-time download of ${megabytes(engine.downloadBytes)}.`;
      download.textContent = `Download (${megabytes(engine.downloadBytes)})`;
    }
  };

  const paint = (settings: SpeechSettings) => {
    enabled.checked = settings.enabled;
    keepAudio.checked = settings.keepAudio;
    polish.value = String(settings.polishReady ? settings.polishLevel : 1);
    polish.disabled = settings.source === "off" || !settings.polishReady;
    polishHint.textContent = settings.polishReady
      ? "Where to start the slider under the listening mark. Basic keeps the words as heard; the others let the chat model fix them, from punctuation only up to proof-reading with the memo around the words. A longer pause starts a new paragraph, which then gets the full pass."
      : "Needs the chat model: turn on model prompts and pick a model in the Models tab.";
    for (const choice of sourceEl.querySelectorAll<HTMLButtonElement>("button")) {
      choice.setAttribute("aria-pressed", String(choice.dataset.source === settings.source));
    }
    localPanel.hidden = settings.source !== "local";
    serverPanel.hidden = settings.source !== "server";
    baseUrl.value = settings.baseUrl;
    key.value = "";
    keyHint.textContent = settings.hasKey ? "A key is saved on this computer." : "No key saved.";
    keyRemove.hidden = !settings.hasKey;
    model.value = settings.model;
    language.value = settings.language;
    if (!settings.serverHost) {
      where.textContent = "No server is set yet.";
    } else if (settings.serverLocal) {
      where.textContent = `Local: sound stays on this computer (${settings.serverHost}).`;
    } else {
      where.textContent = `Sound is sent to ${settings.serverHost} while you record.`;
    }
    paintEngine(settings);
    paintPermission(settings.microphone);
  };

  const load = async () => {
    const settings = await invoke<SpeechSettings>("get_speech_settings");
    paint(settings);
    return settings;
  };

  const loadDevices = async (chosen: string) => {
    const names = await invoke<string[]>("speech_devices");
    device.replaceChildren();
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "System default";
    device.append(fallback);
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      device.append(option);
    }
    if (chosen && !names.includes(chosen)) {
      const missing = document.createElement("option");
      missing.value = chosen;
      missing.textContent = `${chosen} (not connected)`;
      device.append(missing);
    }
    device.value = chosen;
  };

  function act(work: () => Promise<string>, busy = "") {
    status.textContent = busy;
    void work().then(
      (done) => {
        status.textContent = done;
      },
      (error: unknown) => {
        status.textContent = String(error);
      },
    );
  }

  const save = (fields: Record<string, unknown>, done: string) => {
    act(async () => {
      await invoke("save_speech_settings", fields);
      await load();
      return done;
    });
  };

  enabled.addEventListener("change", () => {
    save({ enabled: enabled.checked }, enabled.checked ? "Recording is on." : "Recording is off.");
  });
  keepAudio.addEventListener("change", () => {
    save({ keepAudio: keepAudio.checked }, "Saved.");
  });
  polish.addEventListener("change", () => {
    save({ polishLevel: Number(polish.value) }, "Saved.");
  });
  device.addEventListener("change", () => {
    save({ device: device.value }, "Microphone saved. It is used from the next recording.");
  });
  sourceEl.addEventListener("click", (event) => {
    const choice = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
    const source = choice?.dataset.source as SpeechSource | undefined;
    if (source) {
      save({ source }, "Saved.");
    }
  });
  required<HTMLButtonElement>("#speech-save").addEventListener("click", () => {
    const typed = key.value.trim();
    save(
      {
        baseUrl: baseUrl.value.trim(),
        key: typed === "" ? null : typed,
        model: model.value.trim(),
        language: language.value.trim(),
      },
      "Saved.",
    );
  });
  permissionAsk.addEventListener("click", () => {
    act(async () => {
      const result = await invoke<MicrophonePermission>("speech_request_microphone");
      await load();
      return result.access === "granted" ? "Microphone allowed." : "The microphone was not allowed.";
    }, "Waiting for your answer…");
  });
  permissionOpen.addEventListener("click", () => {
    act(async () => {
      await invoke("speech_open_privacy");
      return "System Settings is open. Come back here after allowing the microphone.";
    });
  });
  // The answer in System Settings is picked up when this window is used again.
  window.addEventListener("focus", () => {
    void load().catch(() => {});
  });

  keyRemove.addEventListener("click", () => {
    save({ key: "" }, "Key removed.");
  });

  download.addEventListener("click", () => {
    downloading = true;
    download.disabled = true;
    progress.hidden = false;
    progress.removeAttribute("value");
    engineStatus.textContent = "Starting the download…";
    act(async () => {
      try {
        await invoke("speech_download");
        return "The speech model is ready.";
      } finally {
        downloading = false;
        progress.hidden = true;
        await load();
      }
    }, "Downloading…");
  });
  remove.addEventListener("click", () => {
    act(async () => {
      await invoke("speech_remove_model");
      await load();
      return "The download was removed.";
    });
  });

  void listen<Progress>("speech-download", (event) => {
    const { received, total, stage } = event.payload;
    if (stage === "done" || stage === "error") {
      return;
    }
    downloading = true;
    progress.hidden = false;
    if (stage === "unpacking" || total === 0) {
      progress.removeAttribute("value");
      engineStatus.textContent = "Unpacking…";
      return;
    }
    progress.max = total;
    progress.value = received;
    const what = stage === "runtime" ? "the speech runtime" : "the speech model";
    engineStatus.textContent = `Downloading ${what}: ${megabytes(received)} of ${megabytes(total)}.`;
  });

  void load().then(
    (settings) => loadDevices(settings.device).catch(() => {}),
    (error: unknown) => {
      status.textContent = String(error);
    },
  );
}
