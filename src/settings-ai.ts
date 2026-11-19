/** The Models tab: the chat model server and the prompts shown on a memo. */

import { invoke } from "@tauri-apps/api/core";

import type { AiMode, AiPreset, AiSettings } from "./ai/llm-edit";
import { required } from "./dom";
import { statusRunner } from "./settings-status";

type ModelList = {
  models: string[];
  ollama: boolean;
};

const modeChoices: { value: AiMode; label: string }[] = [
  { value: "ask", label: "Answer only" },
  { value: "edit", label: "Change the memo" },
  { value: "auto", label: "Model decides" },
];

export function initAiSettings(status: HTMLElement) {
  const act = statusRunner(status);
  const enabled = required<HTMLInputElement>("#llm-enabled");
  const baseUrl = required<HTMLInputElement>("#llm-base-url");
  const where = required<HTMLElement>("#llm-where");
  const key = required<HTMLInputElement>("#llm-key");
  const keyHint = required<HTMLElement>("#llm-key-hint");
  const removeKey = required<HTMLButtonElement>("#llm-key-remove");
  const model = required<HTMLInputElement>("#llm-model");
  const modelChoices = required<HTMLElement>("#llm-model-choices");
  const modelHint = required<HTMLElement>("#llm-model-hint");
  const presetsEl = required<HTMLElement>("#llm-presets");
  let presets: AiPreset[] = [];
  let defaultPresets: AiPreset[] = [];
  let found: ModelList | null = null;

  const paintModels = () => {
    modelChoices.replaceChildren();
    const wanted = model.value.trim();
    modelChoices.hidden = !found || found.models.length === 0;
    for (const id of found?.models ?? []) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = id;
      choice.setAttribute("aria-pressed", String(id === wanted));
      choice.addEventListener("click", () => {
        model.value = id;
        paintModels();
        act(async () => {
          await invoke("save_ai_settings", { llmModel: id });
          return `Model set to ${id}.`;
        });
      });
      modelChoices.append(choice);
    }
    if (!found) {
      modelHint.textContent = "";
    } else if (found.models.length === 0) {
      modelHint.textContent = "The server lists no models. Type the model name above.";
    } else if (wanted === "" || found.models.includes(wanted)) {
      modelHint.textContent = "Pick a model from the list, or type another name above.";
    } else if (found.ollama) {
      modelHint.textContent = `This server does not have "${wanted}" yet. Download it with: ollama pull ${wanted}`;
    } else {
      modelHint.textContent = `This server does not list "${wanted}". Load it in the app that serves this address.`;
    }
  };

  const paintPresets = () => {
    presetsEl.replaceChildren();
    presets.forEach((preset, index) => {
      const row = document.createElement("div");
      row.className = "preset-row";
      const name = document.createElement("input");
      name.type = "text";
      name.value = preset.name;
      name.placeholder = "Name";
      name.maxLength = 40;
      name.setAttribute("aria-label", "Prompt name");
      name.addEventListener("input", () => {
        preset.name = name.value;
      });
      const mode = document.createElement("select");
      mode.setAttribute("aria-label", "What the prompt does");
      for (const choice of modeChoices) {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.label;
        mode.append(option);
      }
      mode.value = preset.mode;
      mode.addEventListener("change", () => {
        preset.mode = mode.value as AiMode;
      });
      const instruction = document.createElement("textarea");
      instruction.value = preset.instruction;
      instruction.rows = 4;
      instruction.placeholder = "What the model should do with the memo";
      instruction.setAttribute("aria-label", "Prompt instruction");
      instruction.addEventListener("input", () => {
        preset.instruction = instruction.value;
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        presets.splice(index, 1);
        paintPresets();
      });
      row.append(name, mode, remove, instruction);
      presetsEl.append(row);
    });
  };

  const paint = (settings: AiSettings) => {
    enabled.checked = settings.llmEnabled;
    baseUrl.value = settings.llmBaseUrl;
    key.value = "";
    keyHint.textContent = settings.hasLlmKey
      ? "A key is saved on this computer."
      : "No key saved. Local servers usually need none.";
    model.value = settings.llmModel;
    if (!settings.llmHost) {
      where.textContent = "";
    } else if (settings.llmLocal) {
      where.textContent = `Local: memo text stays on this computer (${settings.llmHost}).`;
    } else {
      where.textContent = `Memo text is sent to ${settings.llmHost} when you run a prompt.`;
    }
    presets = settings.presets.map((preset) => ({ ...preset, mode: preset.mode ?? "auto" }));
    defaultPresets = settings.defaultPresets ?? [];
    removeKey.hidden = !settings.hasLlmKey;
    paintPresets();
    paintModels();
  };

  const load = async () => {
    const settings = await invoke<AiSettings>("get_ai_settings");
    paint(settings);
    return settings;
  };

  const save = async () => {
    const typed = key.value.trim();
    await invoke("save_ai_settings", {
      llmEnabled: enabled.checked,
      llmBaseUrl: baseUrl.value.trim(),
      llmKey: typed === "" ? null : typed,
      llmModel: model.value.trim(),
      presets: presets.filter((preset) => preset.name.trim() !== "" && preset.instruction.trim() !== ""),
    });
    await load();
  };

  const listModels = async () => {
    found = await invoke<ModelList>("llm_models");
    paintModels();
    return found;
  };

  model.addEventListener("input", paintModels);

  required<HTMLButtonElement>("#save-ai").addEventListener("click", () => {
    act(async () => {
      await save();
      return "Saved.";
    });
  });

  enabled.addEventListener("change", () => {
    act(async () => {
      await invoke("save_ai_settings", { llmEnabled: enabled.checked });
      return enabled.checked ? "Model prompts are on." : "Model prompts are off.";
    });
  });

  required<HTMLButtonElement>("#llm-refresh").addEventListener("click", () => {
    act(async () => {
      await save();
      const list = await listModels();
      const count = list.models.length;
      return `Connected. ${count} ${count === 1 ? "model" : "models"} found.`;
    }, "Testing…");
  });

  removeKey.addEventListener("click", () => {
    act(async () => {
      await invoke("save_ai_settings", { llmKey: "" });
      await load();
      return "Key removed.";
    });
  });

  required<HTMLButtonElement>("#llm-preset-add").addEventListener("click", () => {
    presets.push({ name: "", instruction: "", mode: "auto" });
    paintPresets();
    presetsEl.querySelector<HTMLInputElement>(".preset-row:last-child input")?.focus();
  });

  required<HTMLButtonElement>("#llm-preset-reset").addEventListener("click", () => {
    presets = defaultPresets.map((preset) => ({ ...preset }));
    paintPresets();
  });

  void load().then(
    (settings) => {
      if (settings.llmBaseUrl) {
        // The list is a convenience. A server that is not running yet is not an error here.
        void listModels().catch(() => {});
      }
    },
    (error: unknown) => {
      status.textContent = String(error);
    },
  );
}
