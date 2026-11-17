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
  levelSlider,
  polishSpeech,
  saveImprovementLevel,
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
/** Silence before a piece of speech that starts a new paragraph. */
const PARAGRAPH_PAUSE_MS = 2500;
const PARAGRAPH_BREAK = "\n\n";
/** The quick pass on the paragraph still being spoken never goes past this level. */
const LIVE_LEVEL = 2;

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
  /** Improvement level of this recording. The slider under the listening mark changes it. */
  let level = 2;
  /** Paragraphs that ended and wait for the full pass, by their number in the dictation. */
  let finalQueue: number[] = [];
  /** The paragraph being spoken has new words for a quick pass. */
  let livePending = false;
  /** Each paragraph's text after its last pass, so an unchanged one is not sent again. */
  let passed = new Map<number, string>();
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
  const pill = document.createElement("div");
  pill.className = "rec-pill";
  pill.append(bars, liveText);
  live.append(pill);
  target.host.append(live);

  /** The improvement slider under the listening mark. Its level is saved for the next recording too. */
  let slider: HTMLElement | null = null;
  const setSlider = () => {
    slider?.remove();
    slider = levelSlider(level, (next) => {
      level = next;
      void saveImprovementLevel(next);
      if (level <= 1) {
        finalQueue = [];
        livePending = false;
      } else if (span) {
        // A higher level is used from the next piece of speech or the next ended paragraph.
        livePending = true;
        schedulePolish();
      }
    });
    slider.addEventListener("change", () => {
      // The caret goes back to the dictation, so Enter still ends it.
      if (span) {
        target.placeCaret(span.end);
      }
    });
    live.append(slider);
  };

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

  /** The dictated text so far, as paragraphs. */
  const paragraphs = (): string[] => {
    const place = span ? locateSpan(span, target.text()) : null;
    return place ? target.text().slice(place.start, place.end).split(PARAGRAPH_BREAK) : [];
  };

  /** Puts changed paragraphs back into the memo. Returns false when the dictation is gone. */
  const writeParagraphs = (parts: string[]): boolean => {
    const current = target.text();
    const place = span ? locateSpan(span, current) : null;
    if (!place) {
      return false;
    }
    const next = parts.join(PARAGRAPH_BREAK);
    if (next !== current.slice(place.start, place.end)) {
      write(
        `${current.slice(0, place.start)}${next}${current.slice(place.end)}`,
        place.start,
        place.start + next.length,
      );
    }
    return true;
  };

  const heard = (piece: string, pauseMs = 0) => {
    const text = piece.trim();
    if (text === "") {
      return;
    }
    const current = target.text();
    const place = span ? locateSpan(span, current) : null;
    if (place) {
      const before = current.slice(place.start, place.end);
      // A long pause ends the paragraph: it gets the full pass and the speech goes on below it.
      const newParagraph = pauseMs >= PARAGRAPH_PAUSE_MS && before.trim() !== "";
      if (newParagraph) {
        const ended = before.split(PARAGRAPH_BREAK).length - 1;
        if (!finalQueue.includes(ended)) {
          finalQueue.push(ended);
        }
      }
      const joined = newParagraph
        ? `${before.replace(/\s+$/, "")}${PARAGRAPH_BREAK}${text}`
        : joinDictation(before, text);
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
    livePending = true;
    schedulePolish();
    placeLive();
  };

  function schedulePolish() {
    window.clearTimeout(polishTimer);
    polishTimer = window.setTimeout(() => void polish(), POLISH_DELAY);
  }

  const canPolish = () => level > 1 && !polishOff && Boolean(speechSettings()?.polishReady);

  /** Runs the waiting passes one at a time: ended paragraphs first, then the one being spoken. */
  async function polish() {
    if (polishing) {
      return;
    }
    polishing = true;
    try {
      while (span && canPolish()) {
        const finalIndex = finalQueue.shift();
        const isFinal = finalIndex !== undefined;
        if (!isFinal && !livePending) {
          break;
        }
        const parts = paragraphs();
        const index = isFinal ? finalIndex : parts.length - 1;
        const paragraph = parts[index];
        if (paragraph === undefined) {
          continue;
        }
        if (!isFinal) {
          livePending = false;
        }
        if (passed.get(index) === paragraph && (isFinal ? level <= LIVE_LEVEL : true)) {
          continue;
        }
        // The quick pass sends the end of the paragraph being spoken. The full pass sends a whole paragraph.
        const { head, tail } = isFinal ? { head: "", tail: paragraph } : splitTail(paragraph);
        if (tail.trim() === "") {
          continue;
        }
        const passLevel = isFinal ? level : Math.min(level, LIVE_LEVEL);
        const current = target.text();
        const place = span ? locateSpan(span, current) : null;
        const lead = parts.slice(0, index).join(PARAGRAPH_BREAK);
        const trail = parts.slice(index + 1).join(PARAGRAPH_BREAK);
        const before = place
          ? `${current.slice(Math.max(0, place.start - CONTEXT_BEFORE), place.start)}${lead}${lead ? PARAGRAPH_BREAK : ""}${head}`
          : "";
        const after = place ? `${trail}${current.slice(place.end, place.end + CONTEXT_AFTER)}` : "";
        const reply = await polishSpeech(before, after, tail, passLevel);
        // A reply far longer than what was said is the model writing on its own. It is dropped.
        if (reply.trim() === "" || reply.length > tail.length * 2 + 60) {
          continue;
        }
        const now = paragraphs();
        const latest = now[index];
        if (latest === undefined) {
          continue;
        }
        const next = isFinal ? (latest === paragraph ? reply.trim() : null) : applyPolish(latest, head, tail, reply);
        if (next === null) {
          continue;
        }
        now[index] = next;
        if (!writeParagraphs(now)) {
          break;
        }
        passed.set(index, next);
      }
    } catch (error) {
      // One failure turns improving off for this recording. The text stays as it was heard.
      polishOff = true;
      finalQueue = [];
      livePending = false;
      say(`Text was not improved: ${String(error)}`);
    } finally {
      polishing = false;
      if (span && canPolish() && (finalQueue.length > 0 || livePending)) {
        void polish();
      } else {
        finishIfEnded();
      }
    }
  }

  function finishIfEnded() {
    const done = ended;
    if (!done || polishing || (canPolish() && span && (finalQueue.length > 0 || livePending))) {
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
      finalQueue = [];
      livePending = false;
      passed = new Map();
      // The level last set on the slider carries over to the next recording.
      level = speechSettings()?.polishLevel ?? 2;
      setSlider();
      startRect = caretRect();
      quietSince = Date.now();
      sessionId = await startSpeech("memo", target.noteId(), {
        onChunk: (text, _seq, pauseMs) => heard(text, pauseMs),
        onLevel(loudness) {
          button.style.setProperty("--rec-level", loudness.toFixed(2));
          live.style.setProperty("--rec-level", loudness.toFixed(2));
          if (live.dataset.state === "finishing") {
            return;
          }
          if (loudness > 0.12) {
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
          // The last paragraph gets its full pass too.
          const last = paragraphs().length - 1;
          if (last >= 0 && !finalQueue.includes(last)) {
            finalQueue.push(last);
          }
          livePending = false;
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
  pill.title = "Stop recording (Enter)";
  live.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof Element && event.target.closest(".level-slider"))) {
      event.preventDefault();
    }
    event.stopPropagation();
  });
  pill.addEventListener("click", (event) => {
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
