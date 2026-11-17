/** The record button of a memo: speech goes into the memo at the cursor and is tidied while it arrives. */

import { applyPolish, joinDictation, locateSpan, spanFromInsert, splitTail, type Span } from "../editor/dictation-span";
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
  /** Called when the button appears or disappears, so the header can be laid out again. */
  onAvailability?(): void;
};

/** Note text given to the model on each side of the dictation. */
const CONTEXT_BEFORE = 1500;
const CONTEXT_AFTER = 400;
const POLISH_DELAY = 450;

export function recAnchorHtml(): string {
  return `<div class="rec-anchor" hidden>
    <button class="rec-toggle icon-button" type="button" aria-label="Record" aria-pressed="false" title="Record">
      <span class="rec-glyph" aria-hidden="true"></span>
    </button>
  </div>`;
}

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
    target.replace(next, true);
    const now = target.text();
    if (now === next) {
      span = { content: now, start, end };
      return;
    }
    span = { content: next, start, end };
    const place = locateSpan(span, now);
    span = place ? { content: now, ...place } : null;
  };

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
      }
    }
    schedulePolish();
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
      const at = place ? place.end : current.length;
      const lead = at > 0 && current[at - 1] !== "\n" ? "\n" : "";
      const trail = at < current.length && current[at] !== "\n" ? "\n" : "";
      target.replace(`${current.slice(0, at)}${lead}${done.audio}${trail}${current.slice(at)}`, span !== null);
    }
    if (done.error) {
      say(done.error);
    }
    span = null;
    sessionId = null;
    polishOff = false;
    paint();
  }

  const begin = async () => {
    starting = true;
    paint();
    try {
      span = null;
      ended = null;
      polishOff = false;
      sessionId = await startSpeech("memo", target.noteId(), {
        onChunk: heard,
        onLevel(level) {
          button.style.setProperty("--rec-level", level.toFixed(2));
        },
        onDone(done) {
          ended = done;
          window.clearTimeout(polishTimer);
          void polish();
        },
      });
    } catch (error) {
      sessionId = null;
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
  button.addEventListener("click", () => {
    if (starting) {
      return;
    }
    if (speechRunning()) {
      stopSpeech();
      return;
    }
    void begin();
  });

  watchSpeech(paint);
}
