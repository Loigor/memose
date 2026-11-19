/** Text of a recording in its memo: where its words are, and how a new text differs. */

import { diffLines, type DiffPart } from "./line-diff.ts";

/** Words and the spaces between them, so a diff keeps the spacing. */
export function wordTokens(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token !== "");
}

export function wordDiff(before: string, after: string): DiffPart[] {
  return diffLines(wordTokens(before), wordTokens(after));
}

/** Where the recording's words are in the memo: the match nearest before its own line. */
export function locateWords(memo: string, words: string, name: string): { start: number; end: number } | null {
  if (words.trim() === "") {
    return null;
  }
  const token = memo.indexOf(`memose-media/${name}`);
  return nearest(memo, words, token < 0 ? memo.length : token);
}

const media = /^!?\[[^\]]*\]\(memose-media\/[^)]+\)$/;
const fence = /^\s*```/;
const wordPattern = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * Where the recording's words are in the memo, also after they were edited: the exact
 * text when it is there, otherwise the lines just above the recording that are mostly
 * its words. Null when neither is found.
 */
export function findWords(memo: string, words: string, name: string): { start: number; end: number } | null {
  const exact = locateWords(memo, words, name);
  if (exact) {
    return exact;
  }
  const own = new Set(Array.from(words.toLowerCase().matchAll(wordPattern), (match) => match[0]));
  const token = memo.indexOf(`memose-media/${name}`);
  if (own.size === 0 || token < 0) {
    return null;
  }
  // The text block over the recording, below any recordings right above it.
  let lineStart = memo.lastIndexOf("\n", token) + 1;
  type Line = { start: number; words: { start: number; end: number; own: boolean }[] };
  const lines: Line[] = [];
  let skipping = true;
  while (lineStart > 0) {
    const end = lineStart - 1;
    const start = memo.lastIndexOf("\n", end - 1) + 1;
    const text = memo.slice(start, end);
    lineStart = start;
    if (skipping && media.test(text.trim())) {
      continue;
    }
    skipping = false;
    if (text.trim() === "" || fence.test(text) || media.test(text.trim())) {
      break;
    }
    lines.unshift({
      start,
      words: Array.from(text.matchAll(wordPattern), (match) => ({
        start: start + (match.index ?? 0),
        end: start + (match.index ?? 0) + match[0].length,
        own: own.has(match[0].toLowerCase()),
      })),
    });
  }
  // The last run of lines that are mostly the recording's words.
  const mostly = (line: Line) =>
    line.words.length > 0 && line.words.filter((word) => word.own).length * 2 >= line.words.length;
  let last = lines.length - 1;
  while (last >= 0 && !mostly(lines[last])) {
    last -= 1;
  }
  if (last < 0) {
    return null;
  }
  let first = last;
  while (first > 0 && mostly(lines[first - 1])) {
    first -= 1;
  }
  const run = lines.slice(first, last + 1).flatMap((line) => line.words);
  const seen = new Set(run.filter((word) => word.own).map((word) => memo.slice(word.start, word.end).toLowerCase()));
  if (seen.size * 2 < own.size) {
    return null;
  }
  // From the first to the last of its words, with the punctuation that closes it.
  const from = run.find((word) => word.own);
  const to = run.filter((word) => word.own).pop();
  if (!from || !to) {
    return null;
  }
  const close = /^[.!?…,;:"”’)\]]*/.exec(memo.slice(to.end))?.[0] ?? "";
  return { start: from.start, end: to.end + close.length };
}

function nearest(memo: string, words: string, near: number): { start: number; end: number } | null {
  let best = -1;
  for (let at = memo.indexOf(words); at >= 0; at = memo.indexOf(words, at + 1)) {
    const before = at + words.length <= near;
    const bestBefore = best >= 0 && best + words.length <= near;
    if (best < 0 || (before && !bestBefore) || (before === bestBefore && Math.abs(at - near) < Math.abs(best - near))) {
      best = at;
    }
  }
  return best < 0 ? null : { start: best, end: best + words.length };
}

/** The memo after accepting `next` in place of the recording's old words, or above the recording when they are gone. */
export function acceptWords(memo: string, name: string, old: string, next: string): string {
  // The words may have been edited after the re-analysis was shown.
  const place = findWords(memo, old, name);
  if (place) {
    return `${memo.slice(0, place.start)}${next}${memo.slice(place.end)}`;
  }
  const token = memo.indexOf(`memose-media/${name}`);
  const lineStart = token < 0 ? memo.length : memo.lastIndexOf("\n", token) + 1;
  const lead = lineStart > 0 && memo[lineStart - 1] !== "\n" ? "\n" : "";
  return `${memo.slice(0, lineStart)}${lead}${next}\n${memo.slice(lineStart)}`;
}
