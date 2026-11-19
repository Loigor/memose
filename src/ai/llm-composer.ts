/**
 * The foot of an AI bubble: the question before text goes to another computer, the preset
 * row, the prompt box with its mode and model, and the spoken prompt.
 */

import { invoke } from "@tauri-apps/api/core";

import { button, el } from "../dom";
import { joinDictation } from "../editor/dictation-span";
import { aiSettings, modeNames, scopeLabel, type AiMode, type AiPreset } from "./llm-settings";
import type { Picked } from "./llm-float";
import { speechAvailable, startSpeech, stopSpeech } from "./speech";

/** What the user is putting together. It survives a repaint of the foot. */
export type Draft = {
  instruction: string;
  mode: AiMode;
  /** Memo text the prompt is about, or null for the whole memo. */
  picked: Picked | null;
  /** Sends a held prompt once the user agrees to send private text, or null when nothing waits. */
  consent: (() => void) | null;
};

export type ComposerContext = {
  draft: Draft;
  /** The open bubble, where menus are placed. */
  bubble(): HTMLElement | null;
  send(instruction: string, mode: AiMode): void;
  /** Shows a short note under the log. */
  say(text: string): void;
};

export type Composer = {
  /** Draws the foot into `foot`, replacing what was there. */
  paint(foot: HTMLElement): void;
  /** The open model or preset menu, if any. */
  menu(): HTMLElement | null;
  closeMenu(): void;
  /** Shows the microphone only while a prompt can be spoken. */
  paintMicAvailability(): void;
  /** Forgets the drawn foot when the bubble closes. A spoken prompt still running stops without being sent. */
  detach(): void;
};

type ModelList = {
  models: string[];
  ollama: boolean;
};

export function createComposer(ctx: ComposerContext): Composer {
  const { draft } = ctx;
  let footEl: HTMLElement | null = null;
  let menuEl: HTMLElement | null = null;
  let presetWatch: ResizeObserver | null = null;
  /** The spoken prompt being recorded, and the box it is written into. */
  let voiceSession: string | null = null;
  let voiceStarting = false;
  let voiceSendAfter: AiMode | null = null;
  let inputEl: HTMLTextAreaElement | null = null;
  let micEl: HTMLButtonElement | null = null;

  const repaint = () => {
    if (footEl) {
      paint(footEl);
    }
  };

  function paint(foot: HTMLElement) {
    footEl = foot;
    closeMenu();
    foot.replaceChildren();
    const current = aiSettings();
    if (!current) {
      return;
    }
    if (!current.llmBaseUrl || !current.llmModel) {
      foot.append(el("p", "ai-note", "Set the model server and the model in Settings, under Models."));
      return;
    }
    if (draft.consent) {
      const confirm = draft.consent;
      foot.append(
        el(
          "p",
          "ai-note",
          `This memo is kept on this computer only. Send its text to ${current.llmHost || "the model server"}?`,
        ),
      );
      const actions = el("div", "ai-actions");
      actions.append(
        button("ai-primary", "Send", confirm),
        button("", "Cancel", () => {
          draft.consent = null;
          repaint();
        }),
      );
      foot.append(actions);
      return;
    }
    if (current.presets.length > 0) {
      foot.append(presetRow(current.presets));
    }
    const form = el("form", "ai-composer");
    const { picked } = draft;
    if (picked) {
      const scope = el("div", "ai-scope");
      const label = picked.range
        ? scopeLabel(picked.range.start + 1, picked.range.end + 1, picked.code)
        : scopeLabel(null, null, picked.code);
      const preview = picked.text.replace(/\s+/g, " ").trim();
      scope.append(
        el("span", "ai-scope-label", label),
        el("span", "ai-scope-text", preview.length > 60 ? `${preview.slice(0, 60)}…` : preview),
        button("ai-scope-clear", "×", () => {
          draft.picked = null;
          repaint();
        }),
      );
      scope.title = "The prompt is about the selected text. Remove it to use the whole memo.";
      scope.querySelector(".ai-scope-clear")?.setAttribute("aria-label", "Use the whole memo");
      form.append(scope);
    }
    const input = el("textarea", "ai-input");
    input.rows = 2;
    input.placeholder = picked?.code
      ? "Ask about this code, or ask for a change…"
      : picked
        ? "Ask about the selection, or ask for a change…"
        : "Ask about this memo, or ask for a change…";
    input.setAttribute("aria-label", "Prompt");
    input.value = draft.instruction;
    const fit = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };
    input.addEventListener("input", () => {
      draft.instruction = input.value;
      fit();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        return;
      }
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const bar = el("div", "ai-composer-bar");
    const mode = el("select", "ai-mode");
    mode.setAttribute("aria-label", "What the prompt is for");
    mode.title = "Auto decides from your prompt. Ask never changes the memo. Edit proposes changes to it.";
    for (const value of ["auto", "ask", "edit"] as const) {
      const option = el("option", "", modeNames[value]);
      option.value = value;
      mode.append(option);
    }
    mode.value = draft.mode;
    mode.addEventListener("change", () => {
      draft.mode = mode.value as AiMode;
    });
    const model = button("ai-model", current.llmModel, () => {
      if (menuEl) {
        closeMenu();
        return;
      }
      const menu = openMenu(model, "left");
      menu.append(el("p", "ai-menu-note", "Loading models…"));
      void invoke<ModelList>("llm_models").then(
        (found) => {
          if (menuEl !== menu) {
            return;
          }
          menu.replaceChildren();
          if (found.models.length === 0) {
            menu.append(el("p", "ai-menu-note", "The server lists no models."));
          }
          for (const id of found.models) {
            const item = button("", id, () => {
              closeMenu();
              void invoke("save_ai_settings", { llmModel: id });
            });
            item.setAttribute("aria-pressed", String(id === current.llmModel));
            menu.append(item);
          }
        },
        (error: unknown) => {
          if (menuEl === menu) {
            menu.replaceChildren(el("p", "ai-menu-note", String(error)));
          }
        },
      );
    });
    model.title = current.llmLocal
      ? `${current.llmModel} on this computer. Click to change the model.`
      : `${current.llmModel} at ${current.llmHost}. The memo text is sent there. Click to change the model.`;
    const where = el("span", "ai-where", current.llmLocal ? "local" : current.llmHost);
    const submit = el("button", "ai-send", "↑");
    submit.type = "submit";
    submit.title = "Send (Enter)";
    submit.setAttribute("aria-label", "Send");
    const mic = button("ai-mic", "", toggleVoice);
    mic.append(el("span", "rec-glyph"));
    mic.hidden = !speechAvailable("prompt");
    micEl = mic;
    inputEl = input;
    paintMic();
    bar.append(mode, model, where, mic, submit);
    form.append(input, bar);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (voiceSession) {
        // The last words are still being turned into text. The prompt is sent when they arrive.
        voiceSendAfter = draft.mode;
        stopSpeech();
        return;
      }
      ctx.send(input.value, draft.mode);
    });
    form.addEventListener("mousedown", (event) => {
      if (event.target === form || event.target === bar) {
        event.preventDefault();
        input.focus();
      }
    });
    foot.append(form);
    requestAnimationFrame(() => {
      fit();
      input.focus();
    });
  }

  /** A spoken prompt: the words land in the box, and nothing of the sound is kept. */
  function toggleVoice() {
    if (voiceSession) {
      stopSpeech();
      return;
    }
    if (voiceStarting) {
      return;
    }
    voiceStarting = true;
    paintMic();
    void startSpeech("prompt", null, {
      onChunk(text) {
        draft.instruction = joinDictation(draft.instruction, text);
        if (inputEl) {
          inputEl.value = draft.instruction;
          inputEl.dispatchEvent(new Event("input"));
        }
      },
      onLevel(level) {
        micEl?.style.setProperty("--rec-level", level.toFixed(2));
      },
      onNotice(message) {
        ctx.say(message);
      },
      onDone(done) {
        voiceSession = null;
        const sendMode = voiceSendAfter;
        voiceSendAfter = null;
        if (done.error) {
          ctx.say(done.error);
        }
        paintMic();
        if (sendMode && draft.instruction.trim() !== "") {
          ctx.send(draft.instruction, sendMode);
        }
      },
    })
      .then(
        (id) => {
          voiceSession = id;
        },
        (error: unknown) => {
          ctx.say(String(error));
        },
      )
      .finally(() => {
        voiceStarting = false;
        paintMic();
      });
  }

  function paintMic() {
    if (!micEl) {
      return;
    }
    const on = voiceSession !== null || voiceStarting;
    micEl.classList.toggle("rec-on", on);
    const label = on ? "Stop recording the prompt" : "Speak the prompt";
    micEl.title = label;
    micEl.setAttribute("aria-label", label);
    micEl.setAttribute("aria-pressed", String(on));
    if (!on) {
      micEl.style.removeProperty("--rec-level");
    }
  }

  function closeMenu() {
    menuEl?.remove();
    menuEl = null;
  }

  /** A small list that opens upward from `from`, inside the bubble. */
  function openMenu(from: HTMLElement, side: "left" | "right"): HTMLElement {
    closeMenu();
    const menu = el("div", "ai-menu");
    menuEl = menu;
    const bubble = ctx.bubble();
    if (bubble) {
      const box = bubble.getBoundingClientRect();
      const at = from.getBoundingClientRect();
      menu.style.bottom = `${box.bottom - at.top + 4}px`;
      if (side === "left") {
        menu.style.left = `${Math.max(8, at.left - box.left)}px`;
      } else {
        menu.style.right = `${Math.max(8, box.right - at.right)}px`;
      }
      menu.style.maxHeight = `${Math.max(60, at.top - box.top - 12)}px`;
      bubble.append(menu);
    }
    return menu;
  }

  /** Presets on one row. Those that do not fit move behind a "More…" button. */
  function presetRow(presets: AiPreset[]): HTMLElement {
    const row = el("div", "ai-presets");
    const chips = presets.map((preset) => {
      const chip = button("ai-chip", preset.name, () => ctx.send(preset.instruction, preset.mode));
      chip.title = `${modeNames[preset.mode]}: ${preset.instruction}`;
      return chip;
    });
    let hiddenFrom = presets.length;
    const more = button("ai-chip ai-more", "More…", () => {
      if (menuEl) {
        closeMenu();
        return;
      }
      const menu = openMenu(more, "right");
      for (const preset of presets.slice(hiddenFrom)) {
        const item = button("", preset.name, () => {
          closeMenu();
          ctx.send(preset.instruction, preset.mode);
        });
        item.title = preset.instruction;
        menu.append(item);
      }
    });
    row.append(...chips, more);
    const layout = () => {
      for (const chip of chips) {
        chip.hidden = false;
      }
      more.hidden = false;
      const gap = 4;
      const room = row.clientWidth;
      const widths = chips.map((chip) => chip.offsetWidth);
      const total = widths.reduce((sum, width) => sum + width + gap, -gap);
      if (room <= 0 || total <= room) {
        more.hidden = true;
        hiddenFrom = presets.length;
        return;
      }
      let used = more.offsetWidth;
      hiddenFrom = 0;
      for (let i = 0; i < chips.length; i += 1) {
        if (used + gap + widths[i] > room) {
          break;
        }
        used += gap + widths[i];
        hiddenFrom = i + 1;
      }
      chips.forEach((chip, index) => {
        chip.hidden = index >= hiddenFrom;
      });
    };
    presetWatch?.disconnect();
    presetWatch = new ResizeObserver(layout);
    presetWatch.observe(row);
    requestAnimationFrame(layout);
    return row;
  }

  return {
    paint,
    menu: () => menuEl,
    closeMenu,
    paintMicAvailability() {
      if (micEl) {
        micEl.hidden = !speechAvailable("prompt");
      }
    },
    detach() {
      footEl = null;
      // The menu lived in the bubble, which is gone.
      menuEl = null;
      presetWatch?.disconnect();
      presetWatch = null;
      inputEl = null;
      micEl = null;
      if (voiceSession) {
        voiceSendAfter = null;
        stopSpeech();
      }
    },
  };
}
