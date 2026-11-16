/** The Models tab: the chat model server and the prompts shown on a memo. */

import { invoke } from "@tauri-apps/api/core";

import type { AiPreset, AiSettings } from "./ai/llm-edit";

type ModelList = {
  models: string[];
  ollama: boolean;
};

function required<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`settings form is incomplete: ${selector}`);
  }
  return found;
}

const defaultPresets: AiPreset[] = [
  {
    name: "Summarize",
    instruction: "Summarize the text in a few short bullet points. Use the language of the text.",
  },
  {
    name: "Action items",
    instruction:
      "List the action items from the text as a markdown task list (`- [ ] item`). Name the owner and date when the text gives them. Use the language of the text.",
  },
  {
    name: "Clean up wording",
    instruction:
      "Fix spelling, grammar, and punctuation. Keep the meaning, the structure, and the language. Change as little as possible.",
  },
];

export function initAiSettings(status: HTMLElement) {
  const enabled = required<HTMLInputElement>("#llm-enabled");
  const baseUrl = required<HTMLInputElement>("#llm-base-url");
  const where = required<HTMLElement>("#llm-where");
  const key = required<HTMLInputElement>("#llm-key");
  const keyHint = required<HTMLElement>("#llm-key-hint");
  const model = required<HTMLInputElement>("#llm-model");
  const modelList = required<HTMLDataListElement>("#llm-model-list");
  const modelHint = required<HTMLElement>("#llm-model-hint");
  const presetsEl = required<HTMLElement>("#llm-presets");
  let presets: AiPreset[] = [];

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
      const instruction = document.createElement("textarea");
      instruction.value = preset.instruction;
      instruction.rows = 2;
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
      row.append(name, instruction, remove);
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
    presets = settings.presets.map((preset) => ({ ...preset }));
    paintPresets();
  };

  const load = async () => {
    paint(await invoke<AiSettings>("get_ai_settings"));
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

  const act = (work: () => Promise<string>, busy = "") => {
    status.textContent = busy;
    void work().then(
      (done) => {
        status.textContent = done;
      },
      (error: unknown) => {
        status.textContent = String(error);
      },
    );
  };

  required<HTMLButtonElement>("#save-ai").addEventListener("click", () => {
    act(async () => {
      await save();
      return "Saved.";
    });
  });

  enabled.addEventListener("change", () => {
    act(async () => {
      await invoke("save_ai_settings", { llmEnabled: enabled.checked });
      return enabled.checked ? "Model edits are on." : "Model edits are off.";
    });
  });

  required<HTMLButtonElement>("#llm-refresh").addEventListener("click", () => {
    act(async () => {
      await save();
      const found = await invoke<ModelList>("llm_models");
      modelList.replaceChildren(
        ...found.models.map((id) => {
          const option = document.createElement("option");
          option.value = id;
          return option;
        }),
      );
      const wanted = model.value.trim();
      if (wanted === "" || found.models.includes(wanted)) {
        modelHint.textContent = "";
      } else if (found.ollama) {
        modelHint.textContent = `This server does not have "${wanted}" yet. Download it with: ollama pull ${wanted}`;
      } else {
        modelHint.textContent = `This server does not list "${wanted}". Load it in the app that serves this address.`;
      }
      const count = found.models.length;
      return `Connected. ${count} ${count === 1 ? "model" : "models"} found.`;
    }, "Testing…");
  });

  required<HTMLButtonElement>("#llm-preset-add").addEventListener("click", () => {
    presets.push({ name: "", instruction: "" });
    paintPresets();
    presetsEl.querySelector<HTMLInputElement>(".preset-row:last-child input")?.focus();
  });

  required<HTMLButtonElement>("#llm-preset-reset").addEventListener("click", () => {
    presets = defaultPresets.map((preset) => ({ ...preset }));
    paintPresets();
  });

  void load().catch((error: unknown) => {
    status.textContent = String(error);
  });
}
