/** The AI prompt bubble of a memo: prompts, answers, proposed edits, and running work. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  applyToBlock,
  byteLength,
  diffLines,
  formatKilobytes,
  hunksOf,
  isProtectedLine,
  locateBlock,
  resolveSelection,
  splitLines,
  splitProtected,
  type DiffPart,
  type LineRange,
} from "../editor/line-diff";
import { joinDictation } from "../editor/dictation-span";
import { fieldSourceText } from "../editor/editor-field";
import { isOfflinePrivate } from "../look/visibility";
import { speechAvailable, startSpeech, stopSpeech, watchSpeech } from "./speech";

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
  defaultPresets: AiPreset[];
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
  lineStart: number | null;
  lineEnd: number | null;
  selection: boolean;
  startedAt: number;
  finishedAt: number | null;
};

/** The memo a bubble belongs to. */
export type LlmTarget = {
  /** Positioned box the bubble floats in, with the memo header as its first child. */
  host: HTMLElement;
  /** Id of the memo shown now. Empty for a memo that is not saved yet. */
  noteId(): string | null;
  /** Saves a new memo if needed and returns its id, so its chat is not shared with other new memos. */
  ensureNoteId(): Promise<string | null>;
  title(): string;
  text(): string;
  /** Replaces the memo text as one undo step. */
  replace(next: string): void;
  visibility(): string | null;
  /** Editor and preview boxes. Text selected inside them can be sent as the source of a prompt. */
  selectionRoots(): HTMLElement[];
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

/** The server limit can change while the app runs, so it is read again when a bubble opens. */
async function loadContentLimit() {
  try {
    const general = await invoke<{ memoContentLimit?: number }>("get_settings");
    contentLimit = general.memoContentLimit ?? 0;
  } catch {
    // The last known limit stays.
  }
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

type Picked = {
  text: string;
  /** The source is one code block, picked with the tab on the block. */
  code?: boolean;
  /** Memo lines of the selection, or null when its place in the memo is not clear. */
  range: LineRange | null;
};

type ModelList = {
  models: string[];
  ollama: boolean;
};

function scopeLabel(start: number | null, end: number | null, code = false): string {
  if (start == null || end == null) {
    return code ? "Code block" : "Selected text";
  }
  const lines = start === end ? `Line ${start}` : `Lines ${start}–${end}`;
  return code ? `Code block, ${lines.toLowerCase()}` : lines;
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
  let picked: Picked | null = null;
  let menuEl: HTMLElement | null = null;
  let presetWatch: ResizeObserver | null = null;
  /** The spoken prompt being recorded, and the box it is written into. */
  let voiceSession: string | null = null;
  let voiceStarting = false;
  let voiceSendAfter: AiMode | null = null;
  let inputEl: HTMLTextAreaElement | null = null;
  let micEl: HTMLButtonElement | null = null;
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
      const at = locateBlock(current.lines, before, entry.lineStart ? entry.lineStart - 1 : 0);
      if (at < 0) {
        notice = "The memo changed after this prompt was sent, so nothing was applied. Run the prompt again.";
        decisions.delete(entry.id);
        asEdit.delete(entry.id);
        if (entry.status === "edit") {
          void invoke("llm_mark", { noteId: entry.noteId, requestId: entry.id, status: "dismissed" });
        } else {
          paintLog(false);
        }
        return;
      }
      const status = accepted.size > 0 ? "applied" : "dismissed";
      if (accepted.size > 0) {
        target.replace(applyToBlock(current.lines, at, before.length, parts, accepted, current.kept));
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

    const now = sourceNow();
    const place = Math.max(0, locateBlock(now.lines, before, entry.lineStart ? entry.lineStart - 1 : 0));
    const everything = new Set(all.map((hunk) => hunk.id));
    const size = byteLength(applyToBlock(now.lines, place, before.length, parts, everything, now.kept));
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
      const actions = el("div", "ai-links");
      const copy = button("ai-link", "Copy", () => {
        void navigator.clipboard?.writeText(entry.text).then(() => {
          copy.textContent = "Copied";
        });
      });
      actions.append(
        copy,
        button("ai-link", "Add to memo", () => {
          const current = target.text().replace(/\s+$/, "");
          target.replace(current === "" ? entry.text : `${current}\n\n${entry.text}`);
          notice = "Added to the end of the memo.";
          paintLog(false);
        }),
        button("ai-link", entry.lineStart ? "Replace selection…" : "Replace memo…", () => {
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
      if (entry.selection) {
        question.append(el("span", "ai-tag", scopeLabel(entry.lineStart, entry.lineEnd)));
      }
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

  function send(instruction: string, mode: AiMode, consented = false) {
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
    // Every path that sends text passes here. Only the Send button of the question below sets `consented`.
    if (needsConsent && !consented) {
      pendingConsent = () => {
        void invoke("save_ai_settings", { privateOkHost: current.llmHost })
          .catch(() => {})
          .then(() => {
            current.privateOkHost = current.llmHost;
            send(text, mode, true);
          });
      };
      paintFoot();
      return;
    }
    pendingConsent = null;
    notice = "";
    const whole = sourceNow().lines.join("\n");
    let source = whole;
    let context: string | null = null;
    let request = text;
    let lineStart: number | null = null;
    let lineEnd: number | null = null;
    if (picked?.range) {
      const { start, end } = picked.range;
      const lines = splitLines(target.text())
        .slice(start, end + 1)
        .filter((line) => !isProtectedLine(line));
      source = lines.join("\n");
      context = whole;
      lineStart = start + 1;
      lineEnd = end + 1;
    } else if (picked) {
      // The place of the selection is unclear, so the whole memo is the source and the selection is a hint.
      request = `${text}\n\nThe request is about this part of the note:\n${picked.text}`;
    }
    if (source.trim() === "") {
      notice = "This memo has no text to send.";
      paintLog(true);
      paintFoot();
      return;
    }
    draftInstruction = "";
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const title = target.title();
    void target
      .ensureNoteId()
      .then((noteId) => {
        if (!noteId) {
          throw new Error("Save the memo first.");
        }
        const sent = invoke<ChatEntry>("llm_ask", {
          requestId,
          noteId,
          title,
          instruction: request,
          mode,
          text: source,
          context,
          lineStart,
          lineEnd,
        });
        void refresh(true);
        return sent;
      })
      .catch((error: unknown) => {
        notice = error instanceof Error ? error.message : String(error);
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
    closeMenu();
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
      footEl.append(presetRow(current.presets));
    }
    const form = el("form", "ai-composer");
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
          picked = null;
          paintFoot();
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
    input.value = draftInstruction;
    const fit = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };
    input.addEventListener("input", () => {
      draftInstruction = input.value;
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
    mode.value = draftMode;
    mode.addEventListener("change", () => {
      draftMode = mode.value as AiMode;
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
    // A spoken prompt: the words land in the box, and nothing of the sound is kept.
    const mic = button("ai-mic", "", () => {
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
          draftInstruction = joinDictation(draftInstruction, text);
          if (inputEl) {
            inputEl.value = draftInstruction;
            inputEl.dispatchEvent(new Event("input"));
          }
        },
        onLevel(level) {
          micEl?.style.setProperty("--rec-level", level.toFixed(2));
        },
        onDone(done) {
          voiceSession = null;
          const sendMode = voiceSendAfter;
          voiceSendAfter = null;
          if (done.error) {
            notice = done.error;
            paintLog(true);
          }
          paintMic();
          if (sendMode && draftInstruction.trim() !== "") {
            send(draftInstruction, sendMode);
          }
        },
      })
        .then(
          (id) => {
            voiceSession = id;
          },
          (error: unknown) => {
            notice = String(error);
            paintLog(true);
          },
        )
        .finally(() => {
          voiceStarting = false;
          paintMic();
        });
    });
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
        voiceSendAfter = draftMode;
        stopSpeech();
        return;
      }
      send(input.value, draftMode);
    });
    form.addEventListener("mousedown", (event) => {
      if (event.target === form || event.target === bar) {
        event.preventDefault();
        input.focus();
      }
    });
    footEl.append(form);
    requestAnimationFrame(() => {
      fit();
      input.focus();
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
      const chip = button("ai-chip", preset.name, () => send(preset.instruction, preset.mode));
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
          send(preset.instruction, preset.mode);
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

  function open() {
    if (bubble || anchor.hidden) {
      return;
    }
    float.hidden = true;
    bubble = el("section", "ai-bubble");
    bubble.setAttribute("role", "dialog");
    bubble.setAttribute("aria-label", "AI prompt");
    const header = target.host.querySelector<HTMLElement>(":scope > header");
    bubble.style.setProperty("--ai-top", `${(header?.offsetHeight ?? 36) + 2}px`);
    for (const type of ["mousedown", "pointerdown", "dblclick", "wheel"] as const) {
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
    void loadContentLimit();
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
    menuEl = null;
    presetWatch?.disconnect();
    presetWatch = null;
    pendingConsent = null;
    picked = null;
    inputEl = null;
    micEl = null;
    if (voiceSession) {
      voiceSendAfter = null;
      stopSpeech();
    }
    paintButton();
  }

  // --- Selected text as the source of a prompt ---

  /** The code block the pointer is over, when the tab stands for that block and not for a selection. */
  let hoverCode: HTMLTextAreaElement | null = null;

  const float = button("ai-float", "AI", () => {
    const found = selectedText();
    if (found) {
      picked = { text: found.text, range: resolveSelection(target.text(), found.text) };
    } else if (hoverCode) {
      const code = fieldSourceText(hoverCode);
      const at = locateBlock(splitLines(target.text()), splitLines(code));
      picked = {
        text: code,
        code: true,
        range: at < 0 ? null : { start: at, end: at + splitLines(code).length - 1 },
      };
    } else {
      hideFloat();
      return;
    }
    hideFloat();
    if (isOpen()) {
      paintFoot();
    } else {
      open();
    }
  });
  float.hidden = true;
  for (const type of ["mousedown", "pointerdown"] as const) {
    float.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  target.host.append(float);
  let pointer = { x: 0, y: 0 };
  let floatTimer: number | undefined;

  function hideFloat() {
    float.hidden = true;
    hoverCode = null;
  }

  const describeFloat = (label: string) => {
    float.title = label;
    float.setAttribute("aria-label", label);
  };

  /** Puts the tab in the top right corner of a code block while the pointer is over it. */
  function hoverFloat(event: MouseEvent) {
    if (anchor.hidden || isOpen() || selectedText()) {
      return;
    }
    const hit = event.target;
    if (!(hit instanceof Element) || float.contains(hit)) {
      return;
    }
    const field = hit.closest(".md-field");
    const area = field?.querySelector<HTMLTextAreaElement>('textarea[data-kind="code"]') ?? null;
    const inside = area !== null && target.selectionRoots().some((root) => root.contains(area));
    if (!field || !area || !inside || area.value.trim() === "") {
      if (hoverCode) {
        hideFloat();
      }
      return;
    }
    if (hoverCode === area && !float.hidden) {
      return;
    }
    hoverCode = area;
    describeFloat("Ask the model about this code block");
    const host = target.host.getBoundingClientRect();
    const box = field.getBoundingClientRect();
    const header = target.host.querySelector<HTMLElement>(":scope > header");
    const top = (header?.offsetHeight ?? 36) + 2;
    float.hidden = false;
    // Left of the corner, where the preview keeps its copy button.
    const x = box.right - host.left - float.offsetWidth - 34;
    const y = box.top - host.top + 3;
    float.style.left = `${Math.max(4, Math.min(x, host.width - float.offsetWidth - 6))}px`;
    float.style.top = `${Math.max(top, Math.min(y, host.height - float.offsetHeight - 6))}px`;
  }

  function selectedText(): { text: string; rect: DOMRect | null } | null {
    const roots = target.selectionRoots();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && roots.some((root) => root.contains(active))) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? 0;
      const text = active.value.slice(Math.min(start, end), Math.max(start, end));
      return text.trim().length > 1 ? { text, rect: null } : null;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const within = roots.some((root) => root.contains(range.commonAncestorContainer));
    const text = selection.toString();
    if (!within || text.trim().length <= 1) {
      return null;
    }
    const rects = range.getClientRects();
    return { text, rect: rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect() };
  }

  function placeFloat() {
    if (anchor.hidden || isOpen()) {
      hideFloat();
      return;
    }
    const found = selectedText();
    if (!found) {
      if (!hoverCode) {
        hideFloat();
      }
      return;
    }
    hoverCode = null;
    describeFloat("Ask the model about the selection");
    const host = target.host.getBoundingClientRect();
    const header = target.host.querySelector<HTMLElement>(":scope > header");
    const top = (header?.offsetHeight ?? 36) + 2;
    const x = (found.rect ? found.rect.right : pointer.x) - host.left + 6;
    const y = (found.rect ? found.rect.top : pointer.y - 12) - host.top - 2;
    float.hidden = false;
    float.style.left = `${Math.max(4, Math.min(x, host.width - float.offsetWidth - 6))}px`;
    float.style.top = `${Math.max(top, Math.min(y, host.height - float.offsetHeight - 6))}px`;
  }

  function scheduleFloat() {
    window.clearTimeout(floatTimer);
    floatTimer = window.setTimeout(placeFloat, 140);
  }

  // Listeners outside the memo end with it. Stack sections come and go while the window stays.
  const life = new AbortController();
  const until = { signal: life.signal };
  document.addEventListener("selectionchange", scheduleFloat, until);
  document.addEventListener(
    "mouseup",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      scheduleFloat();
    },
    until,
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.shiftKey || event.key.startsWith("Arrow")) {
        scheduleFloat();
      }
    },
    until,
  );
  document.addEventListener("mouseover", hoverFloat, until);

  // Escape closes the bubble before anything else in the memo reacts to it.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !isOpen()) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (menuEl) {
        closeMenu();
      } else {
        close();
      }
    },
    { capture: true, signal: life.signal },
  );
  // A click on the memo outside the bubble closes it.
  document.addEventListener(
    "mousedown",
    (event) => {
      const hit = event.target;
      if (!(hit instanceof Node)) {
        return;
      }
      if (menuEl && !menuEl.contains(hit) && !(hit instanceof Element && hit.closest(".ai-model, .ai-more"))) {
        closeMenu();
      }
      if (isOpen() && !bubble?.contains(hit) && !anchor.contains(hit) && !float.contains(hit)) {
        close();
      }
    },
    { capture: true, signal: life.signal },
  );

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

  // The microphone button follows the recording settings while the bubble is open.
  const unwatchSpeech = watchSpeech(() => {
    if (micEl) {
      micEl.hidden = !speechAvailable("prompt");
    }
  });
  const onChat = () => {
    void refresh(true);
  };
  settingsWatchers.add(paintAvailability);
  chatWatchers.add(onChat);
  // A stack section is mounted after the settings were read, so it paints from what is known.
  if (settings) {
    paintAvailability();
  }
  ensureListening();
  void settingsFlight?.then(() => refresh());

  // Follows the composer when it shows another memo, and keeps the running times moving.
  const timer = window.setInterval(() => {
    if (!target.host.isConnected) {
      destroy();
      return;
    }
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
  function destroy() {
    window.clearInterval(timer);
    window.clearTimeout(floatTimer);
    life.abort();
    settingsWatchers.delete(paintAvailability);
    chatWatchers.delete(onChat);
    unwatchSpeech();
    presetWatch?.disconnect();
    float.remove();
    bubble?.remove();
    bubble = null;
  }
  window.addEventListener("pagehide", destroy, until);

  return { close };
}
