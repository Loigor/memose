/** The Recording tab: the microphone, where speech becomes text, and the built-in model download. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  megabytes,
  speechLanguages,
  type MicrophonePermission,
  type SpeechModelId,
  type SpeechModelStatus,
  type SpeechSettings,
  type SpeechSource,
} from "./ai/speech";

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
  const modelList = required<HTMLElement>("#speech-models");
  const baseUrl = required<HTMLInputElement>("#speech-base-url");
  const where = required<HTMLElement>("#speech-where");
  const key = required<HTMLInputElement>("#speech-key");
  const keyHint = required<HTMLElement>("#speech-key-hint");
  const keyRemove = required<HTMLButtonElement>("#speech-key-remove");
  const model = required<HTMLInputElement>("#speech-model");
  const languageRow = required<HTMLElement>("#speech-language-row");
  const language = required<HTMLSelectElement>("#speech-language");
  const languageHint = required<HTMLElement>("#speech-language-hint");
  const polish = required<HTMLSelectElement>("#speech-polish");
  const polishHint = required<HTMLElement>("#speech-polish-hint");
  const permissionRow = required<HTMLElement>("#speech-permission");
  const permissionText = required<HTMLElement>("#speech-permission-text");
  const permissionAsk = required<HTMLButtonElement>("#speech-permission-ask");
  const permissionOpen = required<HTMLButtonElement>("#speech-permission-open");
  /** The model being downloaded, and how far it is. */
  let downloading: SpeechModelId | null = null;
  let progressText = "";
  let progressShare: number | null = null;
  let last: SpeechSettings | null = null;

  const languageOption = (code: string, name: string) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    return option;
  };
  /** The language this computer is set to, when the built-in models know it. */
  const homeLanguage = () => {
    const code = navigator.language.slice(0, 2).toLowerCase();
    return speechLanguages.some(([known]) => known === code) ? code : "en";
  };
  const languageName = (code: string) => speechLanguages.find(([known]) => known === code)?.[1] ?? code;

  const paintLanguage = (settings: SpeechSettings) => {
    const chosen = settings.engine.models.find((item) => item.id === settings.engine.model);
    const needsOne = settings.source === "local" && Boolean(chosen?.needsLanguage);
    const saved = settings.language;
    const options = [
      languageOption("", "Detect"),
      ...speechLanguages.map(([code, name]) => languageOption(code, name)),
    ];
    // A code typed for a speech server before this list existed stays choosable.
    if (saved && !speechLanguages.some(([code]) => code === saved)) {
      options.push(languageOption(saved, saved));
    }
    options[0].disabled = needsOne;
    language.replaceChildren(...options);
    language.value = saved;
    languageRow.hidden = settings.source === "off";
    const improves = settings.polishReady
      ? saved
        ? ` Text improvement is told the words are ${languageName(saved)}.`
        : ""
      : "";
    if (settings.source === "server") {
      languageHint.textContent = saved
        ? `Sent to the speech server with each piece of sound.${improves}`
        : "The speech server finds the language by itself.";
    } else if (needsOne) {
      languageHint.textContent = saved
        ? `${chosen?.name ?? "This model"} writes what it hears as ${languageName(saved)}.${improves}`
        : `${chosen?.name ?? "This model"} cannot find the language by itself, so it uses English until you pick one.`;
    } else {
      languageHint.textContent = saved
        ? `${chosen?.name ?? "The model"} finds the language by itself.${improves || " Choose Detect if you switch languages."}`
        : `${chosen?.name ?? "The model"} finds the language by itself.`;
    }
  };

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

  const fact = (label: string, value: string) => {
    const item = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    item.append(term, detail);
    return item;
  };

  const modelCard = (settings: SpeechSettings, item: SpeechModelStatus) => {
    const chosen = settings.engine.model === item.id;
    const card = document.createElement("div");
    card.className = "model-card";
    card.dataset.model = item.id;
    card.dataset.chosen = String(chosen);
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(chosen));

    const head = document.createElement("div");
    head.className = "model-head";
    const dot = document.createElement("span");
    dot.className = "model-dot";
    const name = document.createElement("strong");
    name.textContent = item.name;
    head.append(dot, name);
    const badge = document.createElement("span");
    badge.className = "model-badge";
    badge.textContent = chosen
      ? item.installed
        ? "In use"
        : "Chosen, not downloaded"
      : item.installed
        ? "Downloaded"
        : "";
    badge.hidden = badge.textContent === "";
    head.append(badge);

    const summary = document.createElement("p");
    summary.className = "hint";
    summary.textContent = item.summary;

    const facts = document.createElement("dl");
    facts.className = "model-facts";
    facts.append(
      fact("Size", megabytes(item.diskBytes)),
      fact("Memory", `${(item.memoryMb / 1000).toFixed(1)} GB RAM`),
      fact("Speed", `${item.speed}× real time`),
      fact("Start", `${item.loadSecs.toFixed(1)} s`),
    );

    const actions = document.createElement("div");
    actions.className = "actions";
    if (!chosen) {
      const use = document.createElement("button");
      use.type = "button";
      use.textContent = "Use";
      use.addEventListener("click", () => {
        // A model that cannot find the language starts from this computer's language.
        const language = item.needsLanguage && !settings.language ? { language: homeLanguage() } : {};
        save({ localModel: item.id, ...language }, `${item.name} will be used from the next recording.`);
      });
      actions.append(use);
    }
    if (!item.installed && settings.engine.supported) {
      const get = document.createElement("button");
      get.type = "button";
      get.className = chosen ? "primary" : "";
      get.textContent = `Download (${megabytes(item.downloadBytes)})`;
      get.disabled = downloading !== null;
      get.addEventListener("click", () => startDownload(item));
      actions.append(get);
    }
    if (item.installed) {
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "danger";
      drop.textContent = "Remove";
      drop.disabled = downloading !== null;
      drop.addEventListener("click", () => {
        act(async () => {
          await invoke("speech_remove_model", { model: item.id });
          await load();
          return `${item.name} was removed.`;
        });
      });
      actions.append(drop);
    }
    card.append(head, summary, facts);
    if (downloading === item.id) {
      const bar = document.createElement("progress");
      bar.className = "model-progress";
      if (progressShare === null) {
        bar.removeAttribute("value");
      } else {
        bar.max = 1;
        bar.value = progressShare;
      }
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = progressText;
      card.append(bar, note);
    }
    card.append(actions);
    return card;
  };

  const paintEngine = (settings: SpeechSettings) => {
    const { engine } = settings;
    modelList.replaceChildren(...engine.models.map((item) => modelCard(settings, item)));
    modelList.hidden = !engine.supported;
    const chosen = engine.models.find((item) => item.id === engine.model);
    if (!engine.supported) {
      engineStatus.textContent =
        "The built-in recognizers are not available for this computer. Use a speech server instead.";
    } else if (engine.installed) {
      engineStatus.textContent = `${chosen?.name ?? "The model"} is ready. Downloads use ${megabytes(engine.diskBytes)} on this computer.`;
    } else {
      engineStatus.textContent = `${chosen?.name ?? "The model"} needs a one-time download of ${megabytes(engine.downloadBytes)}.`;
    }
  };

  function startDownload(item: SpeechModelStatus) {
    downloading = item.id;
    progressShare = null;
    progressText = "Starting the download…";
    if (last) {
      paintEngine(last);
    }
    act(async () => {
      try {
        await invoke("speech_download", { model: item.id });
        return `${item.name} is ready.`;
      } finally {
        downloading = null;
        await load();
      }
    }, "Downloading…");
  }

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
    if (!settings.serverHost) {
      where.textContent = "No server is set yet.";
    } else if (settings.serverLocal) {
      where.textContent = `Local: sound stays on this computer (${settings.serverHost}).`;
    } else {
      where.textContent = `Sound is sent to ${settings.serverHost} while you record.`;
    }
    paintEngine(settings);
    paintLanguage(settings);
    paintPermission(settings.microphone);
  };

  const load = async () => {
    const settings = await invoke<SpeechSettings>("get_speech_settings");
    last = settings;
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

  language.addEventListener("change", () => {
    save(
      { language: language.value },
      language.value === ""
        ? "The language is found from the speech."
        : "Language saved. It is used from the next recording.",
    );
  });

  void listen<Progress>("speech-download", (event) => {
    const { received, total, stage } = event.payload;
    if (stage === "done" || stage === "error" || !downloading) {
      return;
    }
    if (stage === "unpacking" || total === 0) {
      progressShare = null;
      progressText = "Unpacking…";
    } else {
      progressShare = received / total;
      const what = stage === "runtime" ? "the speech runtime" : "the model";
      progressText = `Downloading ${what}: ${megabytes(received)} of ${megabytes(total)}.`;
    }
    if (last) {
      paintEngine(last);
    }
  });

  void load().then(
    (settings) => loadDevices(settings.device).catch(() => {}),
    (error: unknown) => {
      status.textContent = String(error);
    },
  );
}
