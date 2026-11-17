/**
 * Where dictated text sits in a memo while more of it arrives.
 *
 * Dictation grows and is reworded while the user keeps speaking, so its place in the
 * memo has to be found again each time. The span is remembered as offsets into the
 * memo text as it was last written. When the memo changed in between, the dictated
 * text is searched for near its old place.
 */

export type Span = {
  /** The memo text after the last write. */
  content: string;
  start: number;
  end: number;
};

/** The dictated text inside `span`. */
export function spanText(span: Span): string {
  return span.content.slice(span.start, span.end);
}

/** Finds what an insert added, by comparing the memo before and after it. */
export function spanFromInsert(before: string, after: string): Span | null {
  if (after.length <= before.length) {
    return null;
  }
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before[start] === after[start]) {
    start += 1;
  }
  let tail = 0;
  while (tail < before.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    tail += 1;
  }
  const end = after.length - tail;
  return end > start ? { content: after, start, end } : null;
}

/** The span's place in the memo as it is now, or null when its text is gone. */
export function locateSpan(span: Span, current: string): { start: number; end: number } | null {
  if (current === span.content) {
    return { start: span.start, end: span.end };
  }
  const text = spanText(span);
  if (text === "") {
    return null;
  }
  let best = -1;
  for (let at = current.indexOf(text); at >= 0; at = current.indexOf(text, at + 1)) {
    if (best < 0 || Math.abs(at - span.start) < Math.abs(best - span.start)) {
      best = at;
    }
  }
  return best < 0 ? null : { start: best, end: best + text.length };
}

/** Appends a newly heard piece to what was dictated so far. */
export function joinDictation(existing: string, piece: string): string {
  const next = piece.trim();
  if (next === "") {
    return existing;
  }
  if (existing === "" || /\s$/.test(existing)) {
    return `${existing}${next}`;
  }
  return `${existing} ${next}`;
}

/** The text to insert at the cursor for a first piece: a space is added after a word. */
export function leadIn(before: string, piece: string): string {
  const next = piece.trim();
  return before !== "" && !/[\s([{"'“‘-]$/.test(before) ? ` ${next}` : next;
}

/**
 * Splits dictation into a settled head and a tail that may still be reworded.
 * The tail starts at a sentence start and is at most about `max` characters.
 */
export function splitTail(text: string, max = 600): { head: string; tail: string } {
  if (text.length <= max) {
    return { head: "", tail: text };
  }
  const from = text.length - max;
  const breaks = /[.!?…]\s+|\n+/g;
  breaks.lastIndex = from;
  const found = breaks.exec(text);
  const at = found ? found.index + found[0].length : from;
  if (at >= text.length) {
    return { head: text.slice(0, from), tail: text.slice(from) };
  }
  return { head: text.slice(0, at), tail: text.slice(at) };
}

/**
 * Puts a reworded tail back. `sent` is the tail that was given to the model. Dictation
 * that arrived while the model worked comes after it and is kept as heard.
 */
export function applyPolish(current: string, head: string, sent: string, polished: string): string | null {
  const settled = `${head}${sent}`;
  if (!current.startsWith(settled)) {
    return null;
  }
  const later = current.slice(settled.length);
  const lead = /^\s*/.exec(sent)?.[0] ?? "";
  return `${head}${lead}${polished.trim()}${later}`;
}
