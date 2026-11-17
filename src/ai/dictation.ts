/** The record button of a memo: speech goes into the memo at the cursor and is tidied while it arrives. */

import {
  applyPolish,
  insertLine,
  joinDictation,
  locateSpan,
  recordingPlace,
  spanFromInsert,
  splitTail,
  type Span,
} from "../editor/dictation-span";
import {
  polishSpeech,
  speechAvailable,
  speechRunning,
  speechSettings,
  startSpeech,
  stopSpeech,
  watchSpeech,
  type SpeechDone,
} from "./speech";
import { findTextRanges, keepScroll, revealRect, setHighlight } from "../editor/view-keep";
import { rememberRecordingText } from "./recording-tools";

/** The memo a record button writes into. */
export type DictationTarget = {
  /** Positioned box of the memo. Messages are shown inside it. */
  host: HTMLElement;
  noteId(): string | null;
  text(): string;
  /** Replaces the memo text. `quiet` adds no undo step, so one dictation is one undo. */
  replace(next: string, quiet?: boolean): void;
  /** Inserts text where the cursor is. */
  insertAtCursor(text: string): void;
  /** Puts the caret at a position in the memo text. */
  placeCaret(offset: number): void;
  /** Editor and preview boxes of the memo, to place the listening mark beside the text. */
  fieldRoots(): HTMLElement[];
  /** Called when the button appears or disappears, so the header can be laid out again. */
  onAvailability?(): void;
};

/** Note text given to the model on each side of the dictation. */
const CONTEXT_BEFORE = 1500;
const CONTEXT_AFTER = 400;
const POLISH_DELAY = 450;

/** Wires the record button inside `anchor`. It stays hidden until recording is turned on in settings. */
export function mountDictation(anchor: HTMLElement, target: DictationTarget) {
  const toggle = anchor.querySelector<HTMLButtonElement>(".rec-toggle");
  if (!toggle) {
    return;
  }
  const button = toggle;
  let sessionId: string | null = null;
  let starting = false;
  let span: Span | null = null;
  let polishing = false;
  let again = false;
  let polishOff = false;
  let polishTimer: number | undefined;
  let ended: SpeechDone | null = null;
  let message: HTMLElement | null = null;
  let messageTimer: number | undefined;
  /** Where the first words will land, measured when recording starts. */
  let startRect: DOMRect | null = null;
  let quietSince = 0;

  // The listening mark: it sits where the next words will appear.
  const live = document.createElement("div");
  live.className = "rec-live";
  live.hidden = true;
  live.setAttribute("aria-live", "polite");
  const bars = document.createElement("span");
  bars.className = "rec-bars";
  bars.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) {
    bars.append(document.createElement("i"));
  }
  const liveText = document.createElement("span");
  liveText.className = "rec-live-text";
  live.append(bars, liveText);
  target.host.append(live);

  const showLive = (state: "waiting" | "hearing" | "finishing") => {
    live.hidden = false;
    live.dataset.state = state;
    liveText.textContent =
      state === "waiting" ? "Waiting for speech…" : state === "hearing" ? "Listening…" : "Finishing…";
  };

  const hideLive = () => {
    live.hidden = true;
    live.style.removeProperty("--rec-level");
  };

  /** The screen box of the cursor, or of the line it is on, inside the memo's fields. */
  const caretRect = (): DOMRect | null => {
    const roots = target.fieldRoots();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && roots.some((root) => root.contains(active))) {
      const box = active.getBoundingClientRect();
      return new DOMRect(box.left + 8, box.bottom - 22, 0, 18);
    }
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (roots.some((root) => root.contains(range.endContainer))) {
        const rects = range.getClientRects();
        const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          return rect;
        }
        const node = range.endContainer;
        const row = (node instanceof Element ? node : node.parentElement)?.closest(".md-row");
        if (row) {
          const box = row.getBoundingClientRect();
          return new DOMRect(box.left, box.top, 0, box.height);
        }
      }
    }
    return null;
  };

  /** The screen box just after the dictated text, found by its last words in the rendered memo. */
  const spanEndRect = (): DOMRect | null => {
    if (!span) {
      return null;
    }
    const place = locateSpan(span, target.text());
    const text = place ? target.text().slice(place.start, place.end).trimEnd() : "";
    const needle =
      text
        .slice(-24)
        .replace(/^\S*\s/, "")
        .trim() || text.slice(-24).trim();
    if (needle === "") {
      return null;
    }
    let found: DOMRect | null = null;
    for (const root of target.fieldRoots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.lastIndexOf(needle) ?? -1;
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at + needle.length);
          range.collapse(true);
          const rects = range.getClientRects();
          found = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
        }
      }
    }
    return found;
  };

  const placeLive = () => {
    if (live.hidden) {
      return;
    }
    const host = target.host.getBoundingClientRect();
    const header = target.host.querySelector<HTMLElement>(":scope > header");
    const top = (header?.offsetHeight ?? 36) + 2;
    let rect = spanEndRect() ?? startRect;
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const root = target.fieldRoots().find((item) => item.offsetParent !== null);
      const box = root?.getBoundingClientRect();
      rect = box ? new DOMRect(box.left + 8, box.bottom - 24, 0, 18) : null;
    }
    if (!rect) {
      return;
    }
    let x = rect.right - host.left + 6;
    let y = rect.top - host.top + (rect.height - live.offsetHeight) / 2;
    if (x + live.offsetWidth > host.width - 6) {
      // No room after the words: the mark goes under them, so it never covers text.
      x = rect.right - host.left - live.offsetWidth;
      y = rect.bottom - host.top + 3;
    }
    live.style.left = `${Math.max(4, Math.min(x, host.width - live.offsetWidth - 6))}px`;
    live.style.top = `${Math.max(top, Math.min(y, host.height - live.offsetHeight - 6))}px`;
  };

  const say = (text: string) => {
    message?.remove();
    window.clearTimeout(messageTimer);
    message = document.createElement("p");
    message.className = "rec-message";
    message.textContent = text;
    const header = target.host.querySelector<HTMLElement>(":scope > header");
    message.style.top = `${(header?.offsetHeight ?? 36) + 4}px`;
    target.host.append(message);
    messageTimer = window.setTimeout(() => {
      message?.remove();
      message = null;
    }, 6000);
  };

  const paint = () => {
    const available = speechAvailable("memo");
    if (anchor.hidden === available) {
      anchor.hidden = !available;
      target.onAvailability?.();
    }
    const running = speechRunning();
    const mine = sessionId !== null && running?.sessionId === sessionId;
    const elsewhere = running !== null && !mine;
    button.classList.toggle("rec-on", mine || starting);
    button.classList.toggle("rec-elsewhere", elsewhere);
    button.setAttribute("aria-pressed", String(mine));
    const label = mine
      ? "Stop recording"
      : elsewhere
        ? "A recording is running elsewhere. Click to stop it."
        : speechSettings()?.source === "off"
          ? "Record sound into this memo"
          : "Dictate into this memo";
    button.title = label;
    button.setAttribute("aria-label", label);
    if (!mine) {
      button.style.removeProperty("--rec-level");
    }
  };

  /** Writes the memo and finds the dictated text again in what the editor made of it. */
  const write = (next: string, start: number, end: number) => {
    keepScroll(target.fieldRoots(), () => target.replace(next, true));
    const now = target.text();
    if (now === next) {
      span = { content: now, start, end };
    } else {
      span = { content: next, start, end };
      const place = locateSpan(span, now);
      span = place ? { content: now, ...place } : null;
    }
    followCaret();
  };

  /** The caret stays at the end of the dictated text, where the next words go, and that place is shown. */
  const followCaret = () => {
    if (span) {
      target.placeCaret(span.end);
    }
    markSpan();
    revealRect(target.fieldRoots(), spanEndRect() ?? caretRect());
    placeLive();
  };

  /** Marks the words dictated so far. The mark goes when the recording ends. */
  const markSpan = () => {
    const place = span ? locateSpan(span, target.text()) : null;
    const words = place ? target.text().slice(place.start, place.end) : "";
    setHighlight("dictation", highlightOwner, words ? findTextRanges(target.fieldRoots(), words) : []);
  };
  const highlightOwner = {};

  const heard = (piece: string) => {
    const text = piece.trim();
    if (text === "") {
      return;
    }
    const current = target.text();
    const place = span ? locateSpan(span, current) : null;
    if (place) {
      const joined = joinDictation(current.slice(place.start, place.end), text);
      write(
        `${current.slice(0, place.start)}${joined}${current.slice(place.end)}`,
        place.start,
        place.start + joined.length,
      );
    } else {
      target.insertAtCursor(text);
      const after = target.text();
      span = spanFromInsert(current, after);
      if (!span) {
        // No field had the cursor: the dictation goes to the end of the memo.
        const base = current.replace(/\s+$/, "");
        const next = base === "" ? text : `${base}\n${text}`;
        write(next, next.length - text.length, next.length);
      } else if (span.start > 0 && !/[\s([{"'“‘-]/.test(after[span.start - 1])) {
        write(`${after.slice(0, span.start)} ${after.slice(span.start)}`, span.start + 1, span.end + 1);
      } else {
        followCaret();
      }
    }
    schedulePolish();
    placeLive();
  };

  function schedulePolish() {
    window.clearTimeout(polishTimer);
    polishTimer = window.setTimeout(() => void polish(), POLISH_DELAY);
  }

  async function polish() {
    const settings = speechSettings();
    if (!span || polishOff || !settings?.polish || !settings.polishReady) {
      finishIfEnded();
      return;
    }
    if (polishing) {
      again = true;
      return;
    }
    const current = target.text();
    const place = locateSpan(span, current);
    if (!place) {
      finishIfEnded();
      return;
    }
    const { head, tail } = splitTail(current.slice(place.start, place.end));
    if (tail.trim() === "") {
      finishIfEnded();
      return;
    }
    polishing = true;
    try {
      const before = `${current.slice(Math.max(0, place.start - CONTEXT_BEFORE), place.start)}${head}`;
      const after = current.slice(place.end, place.end + CONTEXT_AFTER);
      const polished = await polishSpeech(before, after, tail);
      // A reply far longer than what was said is the model writing on its own. It is dropped.
      const sane = polished.trim() !== "" && polished.length <= tail.length * 2 + 60;
      const latest = target.text();
      const now = span ? locateSpan(span, latest) : null;
      if (sane && now) {
        const next = applyPolish(latest.slice(now.start, now.end), head, tail, polished);
        if (next !== null && next !== latest.slice(now.start, now.end)) {
          write(`${latest.slice(0, now.start)}${next}${latest.slice(now.end)}`, now.start, now.start + next.length);
        }
      }
    } catch (error) {
      // One failure turns tidying off for this recording. The text stays as it was heard.
      polishOff = true;
      say(`Text was not tidied: ${String(error)}`);
    } finally {
      polishing = false;
      if (again) {
        again = false;
        void polish();
      } else {
        finishIfEnded();
      }
    }
  }

  function finishIfEnded() {
    const done = ended;
    if (!done || polishing) {
      return;
    }
    ended = null;
    if (done.audio) {
      const current = target.text();
      const place = span ? locateSpan(span, current) : null;
      const at = place ? recordingPlace(current, place.start, place.end) : current.replace(/\s+$/, "").length;
      const placed = insertLine(current, at, done.audio);
      keepScroll(target.fieldRoots(), () => target.replace(placed.text, span !== null));
      const name = /\(memose-media\/([^)#]+)/.exec(done.audio)?.[1];
      if (name) {
        // The recording remembers the words it put into the memo, for its snippet and for re-analysis.
        const words = place ? current.slice(place.start, place.end).trim() : "";
        rememberRecordingText(name, words);
      }
      if (place && place.end === at) {
        target.placeCaret(placed.end);
      } else if (place) {
        target.placeCaret(place.end);
      }
    }
    if (done.error) {
      say(done.error);
    }
    span = null;
    sessionId = null;
    polishOff = false;
    setHighlight("dictation", highlightOwner, []);
    hideLive();
    paint();
  }

  const begin = async () => {
    starting = true;
    paint();
    try {
      span = null;
      ended = null;
      polishOff = false;
      startRect = caretRect();
      quietSince = Date.now();
      sessionId = await startSpeech("memo", target.noteId(), {
        onChunk: heard,
        onLevel(level) {
          button.style.setProperty("--rec-level", level.toFixed(2));
          live.style.setProperty("--rec-level", level.toFixed(2));
          if (live.dataset.state === "finishing") {
            return;
          }
          if (level > 0.12) {
            quietSince = Date.now();
            showLive("hearing");
          } else if (Date.now() - quietSince > 900) {
            showLive("waiting");
          }
        },
        onDone(done) {
          ended = done;
          window.clearTimeout(polishTimer);
          if (done.error) {
            hideLive();
          }
          void polish();
        },
      });
      showLive("waiting");
      placeLive();
    } catch (error) {
      sessionId = null;
      hideLive();
      say(String(error));
    } finally {
      starting = false;
      paint();
    }
  };

  button.addEventListener("mousedown", (event) => {
    // The cursor stays in the memo, so the first words land where it is.
    event.preventDefault();
  });
  const recordingHere = () => sessionId !== null && speechRunning()?.sessionId === sessionId;

  const stop = () => {
    if (recordingHere()) {
      showLive("finishing");
    }
    stopSpeech();
  };

  button.addEventListener("click", () => {
    if (starting) {
      return;
    }
    if (speechRunning()) {
      stop();
      return;
    }
    void begin();
  });

  // The listening mark is also a stop button.
  live.title = "Stop recording (Enter)";
  live.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  live.addEventListener("click", (event) => {
    event.stopPropagation();
    if (recordingHere()) {
      stop();
    }
  });

  // Enter ends dictation instead of starting a new line.
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "Enter" ||
        event.isComposing ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        !recordingHere() ||
        live.dataset.state === "finishing"
      ) {
        return;
      }
      // Only while the keys go to this memo, not to an AI prompt box or a settings field.
      const focus = document.activeElement;
      if (focus && focus !== document.body && !target.host.contains(focus)) {
        return;
      }
      if (focus instanceof Element && focus.closest(".ai-bubble")) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
    },
    true,
  );

  watchSpeech(paint);
}
