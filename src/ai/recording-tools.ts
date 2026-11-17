/**
 * Tools on a recording made in this app: a snippet of the words it put into the memo,
 * and re-analysis of the whole recording, plain or refined with the memo as context.
 * A new text is shown as a word diff to accept or decline.
 */

import { acceptWords, locateWords, wordDiff } from "../editor/recording-words";
import { findTextRanges, keepScroll, setHighlight } from "../editor/view-keep";
import {
  DEFAULT_LEVEL,
  improvementLevels,
  levelSlider,
  polishSpeech,
  recordingsInfo,
  topLevel,
  saveRecordingText,
  transcribeRecording,
  watchSpeech,
  type RecordingInfo,
} from "./speech";

/** The memo whose audio players get the tools. */
export type RecordingToolsTarget = {
  /** Boxes that hold the memo's audio players. */
  roots(): HTMLElement[];
  text(): string;
  /** Replaces the memo text as one undo step. */
  replace(next: string): void;
};

/** Memo text given to the model on each side of the words. */
const CONTEXT_BEFORE = 1500;
const CONTEXT_AFTER = 400;
const SNIPPET = 90;

type Proposal = {
  old: string;
  next: string;
  /** Improvement level the new text was made with. */
  level: number;
};

type ToolState = {
  info: RecordingInfo;
  /** The level a run is going at, or null when none runs. */
  busy: number | null;
  /** The level the slider shows. It goes back to the default after each run. */
  level: number;
  proposal: Proposal | null;
  error: string;
};

/** Known recordings, shared by every memo in this window. `null` means "not one of ours". */
const known = new Map<string, ToolState | null>();
/** Text saved for a recording before its player was looked up. */
const fresh = new Map<string, string>();

/** Remembers the words a new recording put into the memo, so its snippet is right at once. */
export function rememberRecordingText(name: string, text: string) {
  const state = known.get(name);
  if (state) {
    state.info = { ...state.info, text };
  } else {
    known.delete(name);
    fresh.set(name, text);
  }
  void saveRecordingText(name, text);
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
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return node;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET).trimEnd()}…` : flat;
}

/** Adds the tools to the audio players of one memo and keeps them there as the memo is redrawn. */
export function mountRecordingTools(target: RecordingToolsTarget) {
  let scheduled = false;

  const render = (figure: HTMLElement, name: string) => {
    const state = known.get(name);
    const wrap = figure.querySelector<HTMLElement>(".media-audio");
    if (!state || !wrap) {
      return;
    }
    wrap.querySelector(":scope > .rec-tools")?.remove();
    const tools = el("div", "rec-tools");
    for (const type of ["mousedown", "pointerdown", "dragstart"] as const) {
      // The player itself can be dragged. Its tools are clicked, not dragged.
      tools.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === "dragstart") {
          event.preventDefault();
        }
      });
    }
    const words = state.info.text || state.info.heard;
    if (words) {
      const line = el("p", "rec-snippet", `“${snippet(words)}”`);
      line.title = words;
      tools.append(line);
    }

    if (state.proposal) {
      const { old, next } = state.proposal;
      const levelName = improvementLevels.find((item) => item.level === state.proposal?.level)?.name ?? "";
      const diff = el("p", "rec-diff");
      for (const part of wordDiff(old, next)) {
        if (part.kind === "same") {
          diff.append(document.createTextNode(part.lines.join("")));
          continue;
        }
        if (part.hunk.removed.length > 0) {
          diff.append(el("del", "", part.hunk.removed.join("")));
        }
        if (part.hunk.added.length > 0) {
          diff.append(el("ins", "", part.hunk.added.join("")));
        }
      }
      tools.append(el("p", "rec-note", `Re-analyzed (${levelName}):`), diff);
      const actions = el("div", "rec-actions");
      actions.append(
        button("rec-accept", old === next ? "Keep" : "Accept", () => {
          const memo = target.text();
          if (old !== next) {
            keepScroll(target.roots(), () => target.replace(acceptWords(memo, name, old, next)));
          }
          state.info = { ...state.info, text: next };
          state.proposal = null;
          void saveRecordingText(name, next);
          paintAll();
        }),
        button("", "Decline", () => {
          state.proposal = null;
          paintAll();
        }),
      );
      tools.append(actions);
    } else if (state.busy) {
      const row = el("p", "rec-note rec-busy");
      const name = improvementLevels.find((item) => item.level === state.busy)?.name ?? "";
      row.append(el("span", "ai-spinner"), document.createTextNode(` Re-analyzing (${name})…`));
      tools.append(row);
    } else {
      const actions = el("div", "rec-actions rec-reanalyze");
      // Without the chat model a re-analysis is the recognizer's text only.
      const reanalyze = button("rec-link", "Re-analyze", () => void run(name, Math.min(state.level, topLevel())));
      reanalyze.title = "Turn the whole recording into text again, improved to the level under it";
      actions.append(reanalyze);
      tools.append(actions);
      tools.append(
        levelSlider(state.level, (next) => {
          state.level = next;
        }),
      );
      if (state.error) {
        tools.append(el("p", "rec-note rec-error", state.error));
      }
    }
    wrap.append(tools);
    if (state.proposal) {
      // The words a re-analysis would replace are marked in the memo until it is accepted or declined.
      markWords(figure, state.proposal.old);
    }
  };

  const highlightOwner = {};

  function markWords(figure: HTMLElement, words: string) {
    setHighlight("rewording", highlightOwner, words ? findTextRanges(target.roots(), words, figure) : []);
  }

  async function run(name: string, level: number) {
    const state = known.get(name);
    if (!state || state.busy) {
      return;
    }
    state.busy = level;
    state.error = "";
    paintAll();
    try {
      const memo = target.text();
      const old = locateWords(memo, state.info.text, name) ? state.info.text : "";
      let next = (await transcribeRecording(name)).trim();
      if (level > 1 && next !== "") {
        const place = old ? locateWords(memo, old, name) : null;
        const token = memo.indexOf(`memose-media/${name}`);
        const lineStart = token < 0 ? memo.length : memo.lastIndexOf("\n", token) + 1;
        const start = place ? place.start : lineStart;
        const end = place ? place.end : lineStart;
        const before = memo.slice(Math.max(0, start - CONTEXT_BEFORE), start);
        const after = memo.slice(end, end + CONTEXT_AFTER);
        next = (await polishSpeech(before, after, next, level)).trim();
      }
      state.proposal = next === "" ? null : { old, next, level };
      if (next === "") {
        state.error = "No speech was found in the recording.";
      }
    } catch (error) {
      state.error = String(error);
    } finally {
      state.busy = null;
      // The slider starts from the default again for the next run.
      state.level = DEFAULT_LEVEL;
      paintAll();
    }
  }

  const figures = () =>
    target
      .roots()
      .flatMap((root) => [...root.querySelectorAll<HTMLElement>("[data-media]")])
      .filter((figure) => Boolean(figure.querySelector(".media-audio")));

  /**
   * Recordings that follow each other, with at most empty lines between them, join into
   * one bubble. The empty lines inside a group are hidden.
   */
  function group() {
    for (const root of target.roots()) {
      for (const node of root.querySelectorAll(".rec-joined, .rec-joins-next, .rec-group-gap")) {
        node.classList.remove("rec-joined", "rec-joins-next", "rec-group-gap");
      }
    }
    for (const figure of figures()) {
      const row = figure.closest<HTMLElement>(".media-row");
      if (!row || !figure.querySelector(".rec-tools")) {
        continue;
      }
      const gaps: Element[] = [];
      let prev = row.previousElementSibling;
      while (prev && !prev.classList.contains("media-row") && (prev.textContent ?? "").trim() === "") {
        gaps.push(prev);
        prev = prev.previousElementSibling;
      }
      if (prev?.classList.contains("media-row") && prev.querySelector(".rec-tools")) {
        row.classList.add("rec-joined");
        prev.classList.add("rec-joins-next");
        for (const gap of gaps) {
          gap.classList.add("rec-group-gap");
        }
      }
    }
  }

  function paintAll() {
    // Cleared first: a figure with a proposal marks its words again while it is drawn.
    setHighlight("rewording", highlightOwner, []);
    for (const figure of figures()) {
      const name = figure.dataset.media;
      if (name) {
        render(figure, name);
      }
    }
    group();
  }

  async function scan() {
    scheduled = false;
    const found = figures();
    const unknown = [...new Set(found.map((figure) => figure.dataset.media ?? ""))].filter(
      (name) => name !== "" && !known.has(name),
    );
    if (unknown.length > 0) {
      try {
        const infos = await recordingsInfo(unknown);
        for (const name of unknown) {
          const info = infos.find((item) => item.name === name);
          const text = fresh.get(name);
          fresh.delete(name);
          known.set(
            name,
            info
              ? {
                  info: text === undefined ? info : { ...info, text },
                  busy: null,
                  level: DEFAULT_LEVEL,
                  proposal: null,
                  error: "",
                }
              : null,
          );
        }
      } catch {
        return;
      }
    }
    for (const figure of found) {
      const name = figure.dataset.media;
      if (name && known.get(name) && !figure.querySelector(".rec-tools")) {
        render(figure, name);
      }
    }
    group();
    // A redraw makes new text nodes, so the marked words are found again.
    const open = found.find((figure) => known.get(figure.dataset.media ?? "")?.proposal);
    const proposal = open ? known.get(open.dataset.media ?? "")?.proposal : null;
    if (open && proposal) {
      markWords(open, proposal.old);
    }
  }

  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => void scan());
    }
  };

  const observer = new MutationObserver(schedule);
  const watched = new Set<HTMLElement>();
  const watchRoots = () => {
    for (const root of target.roots()) {
      if (!watched.has(root)) {
        watched.add(root);
        observer.observe(root, { childList: true, subtree: true });
      }
    }
  };
  watchRoots();
  schedule();
  // The refine button depends on the chat model being set up.
  watchSpeech(() => {
    watchRoots();
    paintAll();
  });
}
