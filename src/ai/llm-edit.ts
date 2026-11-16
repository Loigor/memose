/** The AI prompt bubble of a memo: prompts, answers, proposed edits, and running work. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  applyHunks,
  byteLength,
  diffLines,
  formatKilobytes,
  hunksOf,
  isProtectedLine,
  splitLines,
  splitProtected,
  type DiffPart,
} from "../editor/line-diff";
import { isOfflinePrivate } from "../look/visibility";

export type AiMode = "auto" | "ask" | "edit";

export type AiPreset = {
  name: string;
  instruction: string;
  mode: AiMode;
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

export type ChatEntry = {
  id: string;
  noteId: string;
  title: string;
  instruction: string;
  mode: AiMode;
  status: "running" | "answer" | "edit" | "applied" | "dismissed" | "error" | "cancelled";
  text: string;
  source: string;
  startedAt: number;
  finishedAt: number | null;
};

/** The memo a bubble belongs to. */
export type LlmTarget = {
  /** Positioned box the bubble floats in, with the memo header as its first child. */
  host: HTMLElement;
  /** Id of the memo shown now. Empty for a memo that is not saved yet. */
  noteId(): string | null;
  title(): string;
  text(): string;
  /** Replaces the memo text as one undo step. */
  replace(next: string): void;
  visibility(): string | null;
  /** Called when the AI button appears or disappears, so the header can be laid out again. */
  onAvailability?(): void;
};

const DRAFT_KEY = "draft";
const modeNames: Record<AiMode, string> = { auto: "Auto", ask: "Ask", edit: "Edit" };

let settings: AiSettings | null = null;
let settingsFlight: Promise<AiSettings | null> | null = null;
let contentLimit = 0;
const settingsWatchers = new Set<() => void>();
const chatWatchers = new Set<(noteId: string) => void>();
let listening = false;

async function loadSettings(): Promise<AiSettings | null> {
  try {
    settings = await invoke<AiSettings>("get_ai_settings");
    const general = await invoke<{ memoContentLimit?: number }>("get_settings");
    contentLimit = general.memoContentLimit ?? 0;
  } catch {
    settings = null;
  }
  for (const paint of settingsWatchers) {
    paint();
  }
  return settings;
}

function ensureListening() {
  if (listening) {
    return;
  }
  listening = true;
  void listen("ai-settings-changed", () => {
    settingsFlight = loadSettings();
  });
  void listen<string>("llm-changed", (event) => {
    for (const watcher of chatWatchers) {
      watcher(event.payload);
    }
  });
  settingsFlight = loadSettings();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function seconds(from: number, to: number): string {
  const total = Math.max(0, Math.round((to - from) / 1000));
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`;
}

type Decisions = {
  accepted: Set<number>;
  decided: Set<number>;
};

/**
 * Wires the AI button inside `anchor` and the bubble it opens.
 * The button stays hidden until model prompts are turned on in settings.
 */
export function mountLlmBubble(anchor: HTMLElement, target: LlmTarget): { close(): void } {
  const toggle = anchor.querySelector<HTMLButtonElement>(".ai-toggle");
  if (!toggle) {
    return { close() {} };
  }
  const toggleEl = toggle;

  let bubble: HTMLElement | null = null;
  let logEl: HTMLElement | null = null;
  let jobsEl: HTMLElement | null = null;
  let footEl: HTMLElement | null = null;
  let noteEl: HTMLElement | null = null;
  let shownNote = "";
  let entries: ChatEntry[] = [];
  let jobs: ChatEntry[] = [];
  let pendingConsent: (() => void) | null = null;
  let draftInstruction = "";
  let draftMode: AiMode = "auto";
  let notice = "";
  const seen = new Set<string>();
  const asEdit = new Set<string>();
  const decisions = new Map<string, Decisions>();
  let autoOpened = "";

  const noteKey = () => target.noteId() || DRAFT_KEY;
  const isOpen = () => bubble !== null;

  const paintButton = () => {
    const key = noteKey();
    const busy = jobs.some((job) => job.noteId === key);
    const unread =
      !isOpen() &&
      entries.some((entry) => entry.status !== "running" && entry.status !== "cancelled" && !seen.has(entry.id));
    toggleEl.classList.toggle("ai-busy", busy);
    toggleEl.classList.toggle("ai-unread", unread);
    toggleEl.setAttribute("aria-expanded", String(isOpen()));
    toggleEl.title = busy ? "AI prompt (working…)" : unread ? "AI prompt (new answer)" : "AI prompt";
  };

  const paintAvailability = () => {
    const hidden = !settings?.llmEnabled;
    if (anchor.hidden !== hidden) {
      anchor.hidden = hidden;
      target.onAvailability?.();
    }
    if (hidden) {
      close();
    } else if (isOpen()) {
      paintFoot();
    }
  };

  async function refresh(scroll = false) {
    const key = noteKey();
    try {
      const [chat, running] = await Promise.all([
        invoke<ChatEntry[]>("llm_chat", { noteId: key }),
        invoke<ChatEntry[]>("llm_jobs"),
      ]);
      if (key !== noteKey()) {
        return;
      }
      entries = chat;
      jobs = running;
    } catch {
      return;
    }
    if (shownNote !== key) {
      shownNote = key;
      notice = "";
      pendingConsent = null;
    }
    const running = entries.some((entry) => entry.status === "running");
    if (running && !isOpen() && autoOpened !== key && !anchor.hidden) {
      autoOpened = key;
      open();
      return;
    }
    paintButton();
    if (isOpen()) {
      paintLog(scroll);
      paintJobs();
      paintHead();
    }
  }

  const paintHead = () => {
    if (noteEl) {
      noteEl.textContent = target.title() || "New memo";
    }
  };

  const paintJobs = () => {
    if (!jobsEl) {
      return;
    }
    const key = noteKey();
    const others = jobs.filter((job) => job.noteId !== key);
    jobsEl.hidden = others.length === 0;
    jobsEl.replaceChildren();
    if (others.length === 0) {
      return;
    }
    jobsEl.append(el("p", "ai-jobs-title", "Also running"));
    for (const job of others) {
      const row = el("div", "ai-job");
      row.append(el("span", "ai-spinner"));
      const label = el("span", "ai-job-text", `${job.title || "Memo"}: ${job.instruction}`);
      label.title = job.instruction;
      row.append(label, el("span", "ai-time", seconds(job.startedAt, Date.now())));
      row.append(button("", "Cancel", () => void invoke("llm_cancel", { requestId: job.id })));
      jobsEl.append(row);
    }
  };

  const sourceNow = () => splitProtected(target.text(), isProtectedLine);

  function diffBody(entry: ChatEntry): HTMLElement {
    const box = el("div", "ai-diff-box");
    const before = splitLines(entry.source);
    const parts: DiffPart[] = diffLines(before, splitLines(entry.text));
    const all = hunksOf(parts);
    if (all.length === 0) {
      box.append(el("p", "ai-note", "The model suggested no changes."));
      return box;
    }
    let state = decisions.get(entry.id);
    if (!state) {
      state = { accepted: new Set(), decided: new Set() };
      decisions.set(entry.id, state);
    }
    const { accepted, decided } = state;

    const finish = () => {
      const current = sourceNow();
      if (current.lines.join("\n") !== entry.source) {
        notice = "The memo changed after this prompt was sent, so nothing was applied. Run the prompt again.";
        decisions.delete(entry.id);
        void invoke("llm_mark", { noteId: entry.noteId, requestId: entry.id, status: "dismissed" });
        return;
      }
      const status = accepted.size > 0 ? "applied" : "dismissed";
      if (accepted.size > 0) {
        target.replace(applyHunks(parts, accepted, current.kept));
      }
      decisions.delete(entry.id);
      asEdit.delete(entry.id);
      if (entry.status === "edit") {
        void invoke("llm_mark", { noteId: entry.noteId, requestId: entry.id, status });
      } else {
        notice = status === "applied" ? "Changes applied." : "";
        paintLog(false);
      }
    };

    const bar = el("div", "ai-actions");
    const summary = el("span", "ai-summary");
    const left = all.length - decided.size;
    summary.textContent = `${left} ${left === 1 ? "change" : "changes"} to review`;
    bar.append(
      summary,
      button("ai-primary", decided.size === 0 ? "Accept all" : "Accept the rest", () => {
        for (const hunk of all) {
          if (!decided.has(hunk.id)) {
            accepted.add(hunk.id);
          }
        }
        finish();
      }),
      button("", accepted.size === 0 ? "Dismiss" : "Done", finish),
    );
    box.append(bar);

    const size = byteLength(applyHunks(parts, new Set(all.map((hunk) => hunk.id)), sourceNow().kept));
    if (contentLimit > 0 && size > contentLimit) {
      box.append(
        el(
          "p",
          "ai-warning",
          `With every change the memo is ${formatKilobytes(size)}. This server accepts ${formatKilobytes(contentLimit)}, so it would stay on this computer until shortened.`,
        ),
      );
    }

    const list = el("div", "ai-diff");
    for (const part of parts) {
      if (part.kind === "same") {
        const lines = part.lines;
        const shown = lines.length > 4 ? [lines[0], null, lines[lines.length - 1]] : lines;
        for (const line of shown) {
          list.append(
            line === null
              ? el("div", "ai-line ai-gap", `${lines.length - 2} unchanged lines`)
              : el("div", "ai-line", line === "" ? " " : line),
          );
        }
        continue;
      }
      const { hunk } = part;
      const item = el("div", "ai-hunk");
      if (decided.has(hunk.id)) {
        item.dataset.decided = accepted.has(hunk.id) ? "accepted" : "rejected";
      }
      for (const line of hunk.removed) {
        item.append(el("div", "ai-line ai-removed", line === "" ? " " : line));
      }
      for (const line of hunk.added) {
        item.append(el("div", "ai-line ai-added", line === "" ? " " : line));
      }
      const decide = (take: boolean) => {
        decided.add(hunk.id);
        if (take) {
          accepted.add(hunk.id);
        } else {
          accepted.delete(hunk.id);
        }
        if (decided.size === all.length) {
          finish();
        } else {
          paintLog(false);
        }
      };
      const row = el("div", "ai-hunk-actions");
      row.append(
        button("ai-primary", "Accept", () => decide(true)),
        button("", "Keep original", () => decide(false)),
      );
      item.append(row);
      list.append(item);
    }
    box.append(list);
    return box;
  }

  function entryBody(entry: ChatEntry): HTMLElement {
    const body = el("div", "ai-a");
    if (entry.status === "running") {
      const row = el("div", "ai-working");
      const time = el("span", "ai-time", `Working… ${seconds(entry.startedAt, Date.now())}`);
      time.dataset.started = String(entry.startedAt);
      row.append(el("span", "ai-spinner"), time);
      row.append(button("", "Cancel", () => void invoke("llm_cancel", { requestId: entry.id })));
      body.append(row);
      return body;
    }
    if (entry.status === "edit" || asEdit.has(entry.id)) {
      body.append(diffBody(entry));
      return body;
    }
    if (entry.status === "answer") {
      body.append(el("div", "ai-answer", entry.text));
      const actions = el("div", "ai-actions");
      const copy = button("", "Copy", () => {
        void navigator.clipboard?.writeText(entry.text).then(() => {
          copy.textContent = "Copied";
        });
      });
      actions.append(
        copy,
        button("", "Add to memo", () => {
          const current = target.text().replace(/\s+$/, "");
          target.replace(current === "" ? entry.text : `${current}\n\n${entry.text}`);
          notice = "Added to the end of the memo.";
          paintLog(false);
        }),
        button("", "Replace memo…", () => {
          asEdit.add(entry.id);
          paintLog(false);
        }),
      );
      body.append(actions);
      return body;
    }
    if (entry.status === "error") {
      body.append(el("p", "ai-note ai-error", entry.text));
      body.append(button("", "Run again", () => send(entry.instruction, entry.mode)));
      return body;
    }
    const text =
      entry.status === "applied"
        ? "Changes applied."
        : entry.status === "dismissed"
          ? "Changes dismissed."
          : "Cancelled.";
    body.append(el("p", "ai-note", text));
    return body;
  }

  function paintLog(scroll: boolean) {
    if (!logEl) {
      return;
    }
    const top = logEl.scrollTop;
    logEl.replaceChildren();
    if (entries.length === 0) {
      logEl.append(
        el(
          "p",
          "ai-empty",
          "Ask about this memo or ask for a change. Answers stay here. Changes are shown for you to accept first.",
        ),
      );
    }
    for (const entry of entries) {
      seen.add(entry.id);
      const item = el("div", "ai-entry");
      item.dataset.status = entry.status;
      const question = el("div", "ai-q");
      question.append(el("span", "ai-q-text", entry.instruction));
      if (entry.mode !== "auto") {
        question.append(el("span", "ai-tag", modeNames[entry.mode]));
      }
      item.append(question, entryBody(entry));
      logEl.append(item);
    }
    if (notice) {
      logEl.append(el("p", "ai-note ai-notice", notice));
    }
    logEl.scrollTop = scroll ? logEl.scrollHeight : top;
  }

  function send(instruction: string, mode: AiMode) {
    const current = settings;
    const text = instruction.trim();
    if (!current || text === "") {
      return;
    }
    const visibility = target.visibility();
    const needsConsent =
      visibility != null &&
      isOfflinePrivate(visibility) &&
      !current.llmLocal &&
      current.privateOkHost !== current.llmHost;
    if (needsConsent && !pendingConsent) {
      pendingConsent = () => {
        void invoke("save_ai_settings", { privateOkHost: current.llmHost }).catch(() => {});
        current.privateOkHost = current.llmHost;
        send(text, mode);
      };
      paintFoot();
      return;
    }
    pendingConsent = null;
    notice = "";
    const source = sourceNow().lines.join("\n");
    if (source.trim() === "") {
      notice = "This memo has no text to send.";
      paintLog(true);
      paintFoot();
      return;
    }
    draftInstruction = "";
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    void invoke<ChatEntry>("llm_ask", {
      requestId,
      noteId: noteKey(),
      title: target.title(),
      instruction: text,
      mode,
      text: source,
    }).catch((error: unknown) => {
      notice = String(error);
      if (isOpen()) {
        paintLog(true);
      }
    });
    paintFoot();
    void refresh(true);
  }

  function paintFoot() {
    if (!footEl) {
      return;
    }
    footEl.replaceChildren();
    const current = settings;
    if (!current) {
      return;
    }
    if (!current.llmBaseUrl || !current.llmModel) {
      footEl.append(el("p", "ai-note", "Set the model server and the model in Settings, under Models."));
      return;
    }
    if (pendingConsent) {
      const confirm = pendingConsent;
      footEl.append(
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
          pendingConsent = null;
          paintFoot();
        }),
      );
      footEl.append(actions);
      return;
    }
    if (current.presets.length > 0) {
      const chips = el("div", "ai-presets");
      for (const preset of current.presets) {
        const chip = button("ai-chip", preset.name, () => send(preset.instruction, preset.mode));
        chip.title = `${modeNames[preset.mode]}: ${preset.instruction}`;
        chips.append(chip);
      }
      footEl.append(chips);
    }
    const form = el("form", "ai-ask");
    const mode = el("select", "ai-mode");
    mode.setAttribute("aria-label", "What the prompt is for");
    mode.title = "Auto lets the model decide. Ask never changes the memo. Edit proposes changes to it.";
    for (const value of ["auto", "ask", "edit"] as const) {
      const option = el("option", "", modeNames[value]);
      option.value = value;
      mode.append(option);
    }
    mode.value = draftMode;
    mode.addEventListener("change", () => {
      draftMode = mode.value as AiMode;
    });
    const input = el("textarea", "ai-input");
    input.rows = 1;
    input.placeholder = "Ask about this memo, or ask for a change…";
    input.setAttribute("aria-label", "Prompt");
    input.value = draftInstruction;
    const fit = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
    };
    input.addEventListener("input", () => {
      draftInstruction = input.value;
      fit();
    });
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        close();
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const submit = el("button", "ai-primary", "Send");
    submit.type = "submit";
    form.append(mode, input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send(input.value, draftMode);
    });
    footEl.append(form);
    const where = current.llmLocal
      ? `${current.llmModel} on this computer`
      : `${current.llmModel} at ${current.llmHost}. The memo text is sent there.`;
    footEl.append(el("p", "ai-where", where));
    requestAnimationFrame(() => {
      fit();
      input.focus();
    });
  }

  function open() {
    if (bubble || anchor.hidden) {
      return;
    }
    bubble = el("section", "ai-bubble");
    bubble.setAttribute("role", "dialog");
    bubble.setAttribute("aria-label", "AI prompt");
    const header = target.host.querySelector<HTMLElement>(":scope > header");
    bubble.style.setProperty("--ai-top", `${(header?.offsetHeight ?? 36) + 2}px`);
    for (const type of ["mousedown", "dblclick", "wheel"] as const) {
      bubble.addEventListener(type, (event) => {
        event.stopPropagation();
      });
    }
    const head = el("div", "ai-head");
    noteEl = el("span", "ai-head-note");
    head.append(
      el("span", "ai-head-title", "AI prompt"),
      noteEl,
      button("ai-head-button", "Clear", () => {
        notice = "";
        decisions.clear();
        asEdit.clear();
        void invoke("llm_clear_chat", { noteId: noteKey() });
      }),
      button("ai-head-button ai-close", "×", close),
    );
    head.querySelector(".ai-close")?.setAttribute("aria-label", "Close AI prompt");
    jobsEl = el("div", "ai-jobs");
    logEl = el("div", "ai-log");
    footEl = el("div", "ai-foot");
    bubble.append(head, jobsEl, logEl, footEl);
    target.host.append(bubble);
    paintHead();
    paintJobs();
    paintLog(true);
    paintFoot();
    paintButton();
    void refresh(true);
  }

  function close() {
    if (!bubble) {
      return;
    }
    bubble.remove();
    bubble = null;
    logEl = null;
    jobsEl = null;
    footEl = null;
    noteEl = null;
    pendingConsent = null;
    paintButton();
  }

  toggleEl.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  toggleEl.addEventListener("click", () => {
    if (isOpen()) {
      close();
    } else {
      open();
    }
  });

  settingsWatchers.add(paintAvailability);
  chatWatchers.add(() => {
    void refresh(true);
  });
  ensureListening();
  void settingsFlight?.then(() => refresh());

  // Follows the composer when it shows another memo, and keeps the running times moving.
  const timer = window.setInterval(() => {
    if (anchor.hidden) {
      return;
    }
    if (shownNote !== noteKey()) {
      entries = [];
      void refresh(true);
      return;
    }
    if (!isOpen()) {
      return;
    }
    paintHead();
    for (const time of bubble?.querySelectorAll<HTMLElement>(".ai-working .ai-time") ?? []) {
      time.textContent = `Working… ${seconds(Number(time.dataset.started), Date.now())}`;
    }
    if (jobs.some((job) => job.noteId !== noteKey())) {
      paintJobs();
    }
  }, 1000);
  window.addEventListener("pagehide", () => window.clearInterval(timer));

  return { close };
}
