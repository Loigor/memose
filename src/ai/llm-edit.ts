/**
 * The AI prompt bubble of a memo: the chat log, running work, and the wiring between the
 * prompt box (llm-composer), entry bodies (llm-entry) and the selection tab (llm-float).
 */

import { invoke } from "@tauri-apps/api/core";

import { isProtectedLine, splitLines, splitProtected } from "../editor/line-diff";
import { button, el } from "../dom";
import { isOfflinePrivate } from "../look/visibility";
import { createComposer, type Draft } from "./llm-composer";
import { entryBody, type Decisions, type EntryContext } from "./llm-entry";
import { mountSelectionFloat } from "./llm-float";
import {
  aiSettings,
  ensureListening,
  loadContentLimit,
  modeNames,
  scopeLabel,
  seconds,
  watchAiSettings,
  watchChats,
  type AiMode,
  type ChatEntry,
} from "./llm-settings";
import { watchSpeech } from "./speech";

export type { AiMode, AiPreset, AiSettings, ChatEntry } from "./llm-settings";

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

/**
 * Wires the AI button inside `anchor` and the bubble it opens.
 * The button stays hidden until model prompts are turned on in settings.
 */
export function mountLlmBubble(anchor: HTMLElement, target: LlmTarget): { close(): void; destroy(): void } {
  const toggle = anchor.querySelector<HTMLButtonElement>(".ai-toggle");
  if (!toggle) {
    return { close() {}, destroy() {} };
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
  let notice = "";
  /** The log follows new content until the user scrolls up to read. */
  let stuckToEnd = true;
  let logWatch: ResizeObserver | null = null;
  const seen = new Set<string>();
  const asEdit = new Set<string>();
  const decisions = new Map<string, Decisions>();
  let autoOpened = "";
  const draft: Draft = { instruction: "", mode: "auto", picked: null, consent: null };

  const noteKey = () => target.noteId() || DRAFT_KEY;
  const isOpen = () => bubble !== null;

  const composer = createComposer({
    draft,
    bubble: () => bubble,
    send: (instruction, mode) => send(instruction, mode),
    say(text) {
      notice = text;
      paintLog(true);
    },
  });
  const paintFoot = () => {
    if (footEl) {
      composer.paint(footEl);
    }
  };

  const sourceNow = () => splitProtected(target.text(), isProtectedLine);

  const entryContext: EntryContext = {
    decisions,
    asEdit,
    source: sourceNow,
    text: () => target.text(),
    replace: (next) => target.replace(next),
    setNotice(text) {
      notice = text;
    },
    repaint: () => paintLog(false),
    runAgain: (entry) => send(entry.instruction, entry.mode),
  };

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
    const hidden = !aiSettings()?.llmEnabled;
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

  /** Newest refresh. An older reply that arrives later must not put back an older chat. */
  let refreshGen = 0;
  async function refresh(scroll = false) {
    const key = noteKey();
    const gen = ++refreshGen;
    try {
      const [chat, running] = await Promise.all([
        invoke<ChatEntry[]>("llm_chat", { noteId: key }),
        invoke<ChatEntry[]>("llm_jobs"),
      ]);
      if (gen !== refreshGen || key !== noteKey()) {
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
      draft.consent = null;
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
          "Ask about this memo, ask for a change, or ask for new text. Answers stay here. Changes are shown for you to accept first.",
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
      item.append(question, entryBody(entry, entryContext));
      logEl.append(item);
    }
    if (notice) {
      logEl.append(el("p", "ai-note ai-notice", notice));
    }
    if (scroll || stuckToEnd) {
      scrollToEnd();
    } else {
      logEl.scrollTop = top;
    }
  }

  /**
   * Keeps the newest entry in view. The footer and the preset row settle a frame later and
   * shrink the log, so the end is set again once the layout is done.
   */
  function scrollToEnd() {
    stuckToEnd = true;
    const log = logEl;
    if (!log) {
      return;
    }
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(() => {
      if (logEl === log && stuckToEnd) {
        log.scrollTop = log.scrollHeight;
      }
    });
  }

  function send(instruction: string, mode: AiMode, consented = false) {
    const current = aiSettings();
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
      draft.consent = () => {
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
    draft.consent = null;
    notice = "";
    const whole = sourceNow().lines.join("\n");
    let source = whole;
    let context: string | null = null;
    let request = text;
    let lineStart: number | null = null;
    let lineEnd: number | null = null;
    const { picked } = draft;
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
    // An empty memo is fine: the prompt then asks for new text. An empty selection is not.
    if (lineStart != null && source.trim() === "") {
      notice = "The selected lines have no text to send.";
      paintLog(true);
      paintFoot();
      return;
    }
    draft.instruction = "";
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

  function open() {
    if (bubble || anchor.hidden) {
      return;
    }
    float.hide();
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
    const log = logEl;
    log.addEventListener("scroll", () => {
      stuckToEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    });
    // When the log gets smaller (the prompt box grows), the end stays in view.
    logWatch?.disconnect();
    logWatch = new ResizeObserver(() => {
      if (stuckToEnd) {
        log.scrollTop = log.scrollHeight;
      }
    });
    logWatch.observe(log);
    stuckToEnd = true;
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
    logWatch?.disconnect();
    logWatch = null;
    draft.consent = null;
    draft.picked = null;
    composer.detach();
    paintButton();
  }

  // Listeners outside the memo end with it. Stack sections come and go while the window stays.
  const life = new AbortController();
  const until = { signal: life.signal };

  // Selected text or a code block as the source of a prompt.
  const float = mountSelectionFloat({
    host: target.host,
    disabled: () => Boolean(anchor.hidden),
    bubbleOpen: isOpen,
    selectionRoots: () => target.selectionRoots(),
    text: () => target.text(),
    onPick(picked) {
      draft.picked = picked;
      if (isOpen()) {
        paintFoot();
      } else {
        open();
      }
    },
    signal: life.signal,
  });

  // Escape closes the bubble before anything else in the memo reacts to it.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !isOpen()) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (composer.menu()) {
        composer.closeMenu();
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
      const menu = composer.menu();
      if (menu && !menu.contains(hit) && !(hit instanceof Element && hit.closest(".ai-model, .ai-more"))) {
        composer.closeMenu();
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
  const unwatchSpeech = watchSpeech(() => composer.paintMicAvailability());
  const unwatchSettings = watchAiSettings(paintAvailability);
  const unwatchChats = watchChats(() => {
    void refresh(true);
  });
  // A stack section is mounted after the settings were read, so it paints from what is known.
  if (aiSettings()) {
    paintAvailability();
  }
  void ensureListening()?.then(() => refresh());

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
  function destroy() {
    // Closing also ends a spoken prompt that is still being recorded.
    close();
    window.clearInterval(timer);
    life.abort();
    unwatchSettings();
    unwatchChats();
    unwatchSpeech();
    float.remove();
    bubble?.remove();
    bubble = null;
  }
  window.addEventListener("pagehide", destroy, until);

  return { close, destroy };
}
