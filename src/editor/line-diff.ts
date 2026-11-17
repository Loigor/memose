/** Line diff between a memo and a proposed rewrite, with per-change accept. */

export type Hunk = {
  id: number;
  removed: string[];
  added: string[];
};

export type DiffPart = { kind: "same"; lines: string[] } | { kind: "hunk"; hunk: Hunk };

/** A line the model never sees, such as an attachment. `after` counts the text lines before it. */
export type KeptLine = {
  after: number;
  line: string;
};

export type ProtectedSplit = {
  lines: string[];
  kept: KeptLine[];
};

/** Above this many cell comparisons the diff is one change, to keep the window responsive. */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n?/g, "\n").split("\n");
}

/** Takes protected lines out of the text and remembers where they sat. */
export function splitProtected(text: string, isProtected: (line: string) => boolean): ProtectedSplit {
  const lines: string[] = [];
  const kept: KeptLine[] = [];
  for (const line of splitLines(text)) {
    if (isProtected(line)) {
      kept.push({ after: lines.length, line });
    } else {
      lines.push(line);
    }
  }
  return { lines, kept };
}

export function diffLines(before: string[], after: string[]): DiffPart[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const parts: DiffPart[] = [];
  let nextId = 0;
  const same = (lines: string[]) => {
    if (lines.length === 0) {
      return;
    }
    const last = parts[parts.length - 1];
    if (last?.kind === "same") {
      last.lines.push(...lines);
    } else {
      parts.push({ kind: "same", lines: [...lines] });
    }
  };
  const change = (removed: string[], added: string[]) => {
    if (removed.length === 0 && added.length === 0) {
      return;
    }
    const last = parts[parts.length - 1];
    if (last?.kind === "hunk") {
      last.hunk.removed.push(...removed);
      last.hunk.added.push(...added);
    } else {
      parts.push({ kind: "hunk", hunk: { id: nextId, removed: [...removed], added: [...added] } });
      nextId += 1;
    }
  };

  same(before.slice(0, head));
  if (a.length * b.length > MAX_CELLS) {
    change(a, b);
  } else {
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        same([a[i]]);
        i += 1;
        j += 1;
      } else if (j >= b.length || (i < a.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        change([a[i]], []);
        i += 1;
      } else {
        change([], [b[j]]);
        j += 1;
      }
    }
  }
  same(before.slice(before.length - tail));
  return parts;
}

export function hunksOf(parts: DiffPart[]): Hunk[] {
  return parts.flatMap((part) => (part.kind === "hunk" ? [part.hunk] : []));
}

/**
 * Text after taking the accepted changes and leaving the rest as it was.
 * Protected lines go back after the same text line they followed.
 */
export function applyHunks(parts: DiffPart[], accepted: ReadonlySet<number>, kept: KeptLine[] = []): string {
  const out: string[] = [];
  let consumed = 0;
  let nextKept = 0;
  const restore = (upTo: number) => {
    while (nextKept < kept.length && kept[nextKept].after <= upTo) {
      out.push(kept[nextKept].line);
      nextKept += 1;
    }
  };
  for (const part of parts) {
    if (part.kind === "same") {
      for (const line of part.lines) {
        restore(consumed);
        out.push(line);
        consumed += 1;
      }
      continue;
    }
    restore(consumed);
    const { hunk } = part;
    if (accepted.has(hunk.id)) {
      out.push(...hunk.added);
      consumed += hunk.removed.length;
    } else {
      for (const line of hunk.removed) {
        restore(consumed);
        out.push(line);
        consumed += 1;
      }
    }
  }
  restore(Number.POSITIVE_INFINITY);
  return out.join("\n");
}

/** UTF-8 size, which is how the server counts a memo. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatKilobytes(bytes: number): string {
  const tenths = Math.round((bytes * 10) / 1024);
  return tenths % 10 === 0 ? `${tenths / 10} KB` : `${(tenths / 10).toFixed(1)} KB`;
}

const mediaLine = /^!?\[[^\]]*\]\(memose-media\/[A-Za-z0-9._-]+\.[A-Za-z0-9]+(?:#[^)]*)?\)$/;
const speechMarker = /^\[memose-speech(?:-end)?-[A-Za-z0-9-]+\]: #/;

/** Attachment and recording lines stay out of the prompt and out of the diff. */
export function isProtectedLine(line: string): boolean {
  const trimmed = line.trim();
  return mediaLine.test(trimmed) || speechMarker.test(trimmed);
}

/** Lines of the memo that a selection covers, counted from 0 over all memo lines. */
export type LineRange = {
  start: number;
  end: number;
};

/** A line without markdown marks and spacing, to compare editor, preview, and source text. */
function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "")
    .replace(/^\s*(?:#{1,6}|>)\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds which memo lines hold the selected text. The selection may come from the editor or
 * from the rendered preview, so lines are compared without markdown marks. The first and
 * last selected lines may be partial. Returns null when the place is missing or not unique.
 */
export function resolveSelection(memo: string, selected: string): LineRange | null {
  const lines = splitLines(memo);
  const wanted = splitLines(selected)
    .map(plainLine)
    .filter((line) => line !== "");
  if (wanted.length === 0) {
    return null;
  }
  const plain = lines.map((line) => (isProtectedLine(line) ? "" : plainLine(line)));
  const matches: LineRange[] = [];
  for (let start = 0; start < plain.length; start += 1) {
    if (plain[start] === "") {
      continue;
    }
    const firstFits = wanted.length === 1 ? plain[start].includes(wanted[0]) : plain[start].endsWith(wanted[0]);
    if (!firstFits) {
      continue;
    }
    let at = start;
    let ok = true;
    for (let i = 1; i < wanted.length; i += 1) {
      at += 1;
      while (at < plain.length && plain[at] === "") {
        at += 1;
      }
      const last = i === wanted.length - 1;
      if (at >= plain.length || (last ? !plain[at].startsWith(wanted[i]) : plain[at] !== wanted[i])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push({ start, end: at });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Where `block` sits in `lines` as a run of equal lines. The match nearest to `near` wins. */
export function locateBlock(lines: string[], block: string[], near = 0): number {
  if (block.length === 0 || block.length > lines.length) {
    return -1;
  }
  let best = -1;
  for (let at = 0; at + block.length <= lines.length; at += 1) {
    let same = true;
    for (let i = 0; i < block.length; i += 1) {
      if (lines[at + i] !== block[i]) {
        same = false;
        break;
      }
    }
    if (same && (best < 0 || Math.abs(at - near) < Math.abs(best - near))) {
      best = at;
    }
  }
  return best;
}

/** Applies accepted changes of a diff that covers only `length` lines starting at `at`. */
export function applyToBlock(
  lines: string[],
  at: number,
  length: number,
  parts: DiffPart[],
  accepted: ReadonlySet<number>,
  kept: KeptLine[] = [],
): string {
  const whole: DiffPart[] = [
    { kind: "same", lines: lines.slice(0, at) },
    ...parts,
    { kind: "same", lines: lines.slice(at + length) },
  ];
  return applyHunks(whole, accepted, kept);
}
