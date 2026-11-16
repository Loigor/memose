/** Model edits on a memo: a prompt menu, then a line diff to accept or drop. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  applyHunks,
  byteLength,
  diffLines,
  formatKilobytes,
  hunksOf,
  isProtectedLine,
  splitProtected,
  type DiffPart,
  type KeptLine,
} from "../editor/line-diff";
import { isOfflinePrivate } from "../look/visibility";

export type AiPreset = {
  name: string;
  instruction: string;
};

export type AiSettings = {
  llmEnabled: boolean;
  llmBaseUrl: string;
  hasLlmKey: boolean;
  llmModel: string;
  llmHost: string;
  llmLocal: boolean;
  privateOkHost: string;
  presets: AiPreset[];
};

/** The memo a menu works on. */
export type LlmTarget = {
  /** Element the review panel covers. It must be a positioned box. */
  pane: HTMLElement;
  text(): string;
  /** Replaces the memo text as one undo step. */
  replace(next: string): void;
  visibility(): string | null;
};

let settings: AiSettings | null = null;
let settingsFlight: Promise<AiSettings | null> | null = null;
let contentLimit = 0;
const repaint = new Set<() => void>();
let listening = false;

async function loadSettings(): Promise<AiSettings | null> {
  try {
    settings = await invoke<AiSettings>("get_ai_settings");
    const general = await invoke<{ memoContentLimit?: number }>("get_settings");
    contentLimit = general.memoContentLimit ?? 0;
  } catch {
    settings = null;
  }
  for (const paint of repaint) {
    paint();
  }
  return settings;
}

function ensureSettings(): Promise<AiSettings | null> {
  if (!listening) {
    listening = true;
    void listen("ai-settings-changed", () => {
      settingsFlight = loadSettings();
    });
  }
  settingsFlight ??= loadSettings();
  return settingsFlight;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

export function aiMenuHtml(): string {
  return `<div class="ai-anchor" hidden>
    <button class="ai-toggle icon-button" type="button" aria-label="Ask the model" aria-expanded="false" title="Ask the model">AI</button>
    <div class="ai-pop" hidden></div>
  </div>`;
}

/**
 * Wires the model menu inside `anchor` (markup from `aiMenuHtml`).
 * The button stays hidden until model edits are turned on in settings.
 */
export function mountLlmMenu(anchor: HTMLElement, target: LlmTarget, onOpen?: () => void): { close(): void } {
  const toggle = anchor.querySelector<HTMLButtonElement>(".ai-toggle");
  const pop = anchor.querySelector<HTMLElement>(".ai-pop");
  if (!toggle || !pop) {
    return { close() {} };
  }
  let review: HTMLElement | null = null;
  let requestId = "";

  const close = () => {
    pop.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };

  const paintAvailability = () => {
    anchor.hidden = !settings?.llmEnabled;
    if (anchor.hidden) {
      close();
    }
  };
  repaint.add(paintAvailability);
  void ensureSettings();

  const dropReview = () => {
    review?.remove();
    review = null;
    target.pane.classList.remove("ai-reviewing");
  };

  const openReview = (): HTMLElement => {
    dropReview();
    review = el("div", "ai-review");
    review.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    target.pane.classList.add("ai-reviewing");
    target.pane.append(review);
    return review;
  };

  const showMessage = (panel: HTMLElement, message: string, again?: () => void) => {
    panel.replaceChildren();
    panel.append(el("p", "ai-status", message));
    const actions = el("div", "ai-actions");
    if (again) {
      const retry = button("ai-primary", "Run again");
      retry.addEventListener("click", again);
      actions.append(retry);
    }
    const dismiss = button("", "Close");
    dismiss.addEventListener("click", dropReview);
    actions.append(dismiss);
    panel.append(actions);
  };

  const showDiff = (panel: HTMLElement, source: string, parts: DiffPart[], kept: KeptLine[], instruction: string) => {
    const accepted = new Set<number>();
    const decided = new Set<number>();
    const all = hunksOf(parts);
    panel.replaceChildren();

    const bar = el("div", "ai-actions ai-bar");
    const summary = el("span", "ai-summary");
    const acceptAll = button("ai-primary", "Accept all");
    const cancel = button("", "Cancel");
    bar.append(summary, acceptAll, cancel);
    const warning = el("p", "ai-warning");
    warning.hidden = true;
    const list = el("div", "ai-diff");
    panel.append(bar, warning, list);

    const finish = () => {
      if (target.text() !== source) {
        showMessage(panel, "The memo changed while the answer was open. Nothing was applied.", () => run(instruction));
        return;
      }
      if (accepted.size > 0) {
        target.replace(applyHunks(parts, accepted, kept));
      }
      dropReview();
    };

    const paintSummary = () => {
      const left = all.length - decided.size;
      summary.textContent =
        left === 0 ? "All changes decided" : `${left} ${left === 1 ? "change" : "changes"} to review`;
      acceptAll.textContent = decided.size === 0 ? "Accept all" : "Accept the rest";
      cancel.textContent = accepted.size === 0 ? "Cancel" : "Done";
      const size = byteLength(applyHunks(parts, new Set(all.map((hunk) => hunk.id)), kept));
      warning.hidden = contentLimit === 0 || size <= contentLimit;
      if (!warning.hidden) {
        warning.textContent = `With every change the memo is ${formatKilobytes(size)}. This server accepts ${formatKilobytes(contentLimit)}, so it would stay on this computer until shortened.`;
      }
    };

    for (const part of parts) {
      if (part.kind === "same") {
        const lines = part.lines;
        const shown = lines.length > 6 ? [...lines.slice(0, 2), null, ...lines.slice(-2)] : lines;
        for (const line of shown) {
          list.append(
            line === null
              ? el("div", "ai-line ai-gap", `${lines.length - 4} unchanged lines`)
              : el("div", "ai-line", line === "" ? " " : line),
          );
        }
        continue;
      }
      const { hunk } = part;
      const box = el("div", "ai-hunk");
      for (const line of hunk.removed) {
        box.append(el("div", "ai-line ai-removed", line === "" ? " " : line));
      }
      for (const line of hunk.added) {
        box.append(el("div", "ai-line ai-added", line === "" ? " " : line));
      }
      const row = el("div", "ai-hunk-actions");
      const accept = button("ai-primary", "Accept");
      const reject = button("", "Keep original");
      const decide = (take: boolean) => {
        decided.add(hunk.id);
        if (take) {
          accepted.add(hunk.id);
        } else {
          accepted.delete(hunk.id);
        }
        box.dataset.decided = take ? "accepted" : "rejected";
        paintSummary();
        if (decided.size === all.length) {
          finish();
        }
      };
      accept.addEventListener("click", () => decide(true));
      reject.addEventListener("click", () => decide(false));
      row.append(accept, reject);
      box.append(row);
      list.append(box);
    }

    acceptAll.addEventListener("click", () => {
      for (const hunk of all) {
        if (!decided.has(hunk.id)) {
          accepted.add(hunk.id);
        }
      }
      finish();
    });
    cancel.addEventListener("click", () => {
      if (accepted.size > 0) {
        finish();
      } else {
        dropReview();
      }
    });
    paintSummary();
  };

  async function run(instruction: string) {
    close();
    const source = target.text();
    const { lines, kept } = splitProtected(source, isProtectedLine);
    const panel = openReview();
    if (lines.join("\n").trim() === "") {
      showMessage(panel, "This memo has no text to send.");
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    requestId = id;
    panel.replaceChildren();
    const where = settings?.llmLocal ? "the local model" : settings?.llmHost || "the model";
    panel.append(el("p", "ai-status ai-waiting", `Asking ${where}…`));
    const actions = el("div", "ai-actions");
    const stop = button("", "Cancel");
    stop.addEventListener("click", () => {
      requestId = "";
      void invoke("llm_cancel", { requestId: id });
      dropReview();
    });
    actions.append(stop);
    panel.append(actions);
    try {
      const answer = await invoke<string>("llm_edit", { requestId: id, instruction, text: lines.join("\n") });
      if (requestId !== id || review !== panel) {
        return;
      }
      const parts = diffLines(lines, answer.replace(/\r\n?/g, "\n").split("\n"));
      if (hunksOf(parts).length === 0) {
        showMessage(panel, "The model suggested no changes.");
        return;
      }
      showDiff(panel, source, parts, kept, instruction);
    } catch (error) {
      if (requestId !== id || review !== panel) {
        return;
      }
      showMessage(panel, String(error), () => run(instruction));
    }
  }

  const ask = (instruction: string) => {
    const current = settings;
    if (!current) {
      return;
    }
    const visibility = target.visibility();
    const needsConsent =
      visibility != null &&
      isOfflinePrivate(visibility) &&
      !current.llmLocal &&
      current.privateOkHost !== current.llmHost;
    if (!needsConsent) {
      void run(instruction);
      return;
    }
    pop.replaceChildren();
    pop.append(
      el(
        "p",
        "ai-consent",
        `This memo is kept on this computer only. Send its text to ${current.llmHost || "the model server"}?`,
      ),
    );
    const send = button("ai-primary", "Send");
    const keep = button("", "Cancel");
    send.addEventListener("click", () => {
      void invoke("save_ai_settings", { privateOkHost: current.llmHost }).catch(() => {});
      current.privateOkHost = current.llmHost;
      void run(instruction);
    });
    keep.addEventListener("click", close);
    pop.append(send, keep);
  };

  const paintMenu = () => {
    pop.replaceChildren();
    const current = settings;
    if (!current) {
      return;
    }
    if (!current.llmBaseUrl || !current.llmModel) {
      pop.append(el("p", "ai-consent", "Set the model server and model in Settings, under Models."));
      return;
    }
    for (const preset of current.presets) {
      const item = button("", preset.name);
      item.title = preset.instruction;
      item.addEventListener("click", () => ask(preset.instruction));
      pop.append(item);
    }
    const form = el("form", "ai-ask");
    const input = el("input", "");
    input.type = "text";
    input.placeholder = "Ask for a change…";
    input.setAttribute("aria-label", "Instruction for the model");
    input.autocomplete = "off";
    form.append(input);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const instruction = input.value.trim();
      if (instruction) {
        ask(instruction);
      }
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        close();
      }
    });
    pop.append(form);
  };

  toggle.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  toggle.addEventListener("click", () => {
    const open = pop.hidden;
    if (open) {
      onOpen?.();
      paintMenu();
    }
    pop.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("mousedown", (event) => {
    const hit = event.target;
    if (!pop.hidden && hit instanceof Node && !anchor.contains(hit)) {
      close();
    }
  });

  return { close };
}
