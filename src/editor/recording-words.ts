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
  const place = locateWords(memo, old, name);
  if (place) {
    return `${memo.slice(0, place.start)}${next}${memo.slice(place.end)}`;
  }
  const token = memo.indexOf(`memose-media/${name}`);
  const lineStart = token < 0 ? memo.length : memo.lastIndexOf("\n", token) + 1;
  const lead = lineStart > 0 && memo[lineStart - 1] !== "\n" ? "\n" : "";
  return `${memo.slice(0, lineStart)}${lead}${next}\n${memo.slice(lineStart)}`;
}
