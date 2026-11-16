// Bracket folding like an IDE: any {, [ or ( whose matching closer sits on a later line folds the
// lines between them; the opener line and the closer line stay visible (`if (a) {…} else {…}`).
// Indent folding waits until a language needs it.

export const FOLD_SENTINEL = "\u200b";

export type FoldMark = "open" | "shut";

export type FoldView = {
  display: string;
  holes: string[];
  numbers: number[];
  markers: Array<FoldMark | null>;
  foldedLines: number[];
};

/** How strings and comments look, so brackets inside them are ignored. */
export type FoldSyntax = {
  /** Line comment prefixes, e.g. `//` or `#`. */
  line: string[];
  /** Block comment delimiters, e.g. `/*` … `*\/`. */
  block: Array<[string, string]>;
  /** Quote characters that end at the line break. */
  quotes: string[];
  /** Quote delimiters that may span lines (template literals, triple quotes). */
  multi: string[];
};

const C_LIKE: FoldSyntax = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], multi: [] };
const JS_LIKE: FoldSyntax = { ...C_LIKE, multi: ["`"] };
const HASH: FoldSyntax = { line: ["#"], block: [], quotes: ['"', "'"], multi: [] };
const PYTHON: FoldSyntax = { line: ["#"], block: [], quotes: ['"', "'"], multi: ['"""', "'''"] };
const CSS: FoldSyntax = { line: [], block: [["/*", "*/"]], quotes: ['"', "'"], multi: [] };
const SQL: FoldSyntax = { line: ["--"], block: [["/*", "*/"]], quotes: ['"', "'"], multi: [] };
const JSON_SYNTAX: FoldSyntax = { line: ["//"], block: [["/*", "*/"]], quotes: ['"'], multi: [] };
/** Markdown prose: apostrophes and slashes are text, not syntax. */
export const PROSE_SYNTAX: FoldSyntax = { line: [], block: [], quotes: [], multi: [] };

const BY_LANG: Record<string, FoldSyntax> = {
  js: JS_LIKE,
  jsx: JS_LIKE,
  mjs: JS_LIKE,
  cjs: JS_LIKE,
  javascript: JS_LIKE,
  ts: JS_LIKE,
  tsx: JS_LIKE,
  typescript: JS_LIKE,
  json: JSON_SYNTAX,
  jsonc: JSON_SYNTAX,
  json5: JS_LIKE,
  css: CSS,
  scss: C_LIKE,
  less: C_LIKE,
  py: PYTHON,
  python: PYTHON,
  sh: HASH,
  bash: HASH,
  zsh: HASH,
  shell: HASH,
  yaml: HASH,
  yml: HASH,
  toml: HASH,
  ruby: HASH,
  rb: HASH,
  r: HASH,
  perl: HASH,
  sql: SQL,
  lua: SQL,
};

export function foldSyntaxFor(lang: string | undefined, prose = false): FoldSyntax {
  if (prose) {
    return PROSE_SYNTAX;
  }
  const key = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return BY_LANG[key] ?? C_LIKE;
}

const OPENERS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
const CLOSERS: Record<string, string> = { "}": "{", "]": "[", ")": "(" };

type Frame = { line: number; ch: string };

function startsAt(source: string, index: number, token: string): boolean {
  return source.startsWith(token, index);
}

/** Fold ranges keyed by opener line; `end` is the closer's line, which stays visible. */
export function braceFolds(source: string, syntax: FoldSyntax = C_LIKE): Array<{ start: number; end: number }> {
  const endAt = new Map<number, number>();
  const stack: Frame[] = [];
  let line = 0;
  let quote: string | null = null;
  let blockEnd: string | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch === "\n") {
      line += 1;
      if (quote && !syntax.multi.includes(quote)) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (blockEnd) {
      if (startsAt(source, i, blockEnd)) {
        i += blockEnd.length;
        blockEnd = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        // Skip the escaped char, but never swallow a line break so line counting stays right.
        i += source[i + 1] === "\n" ? 1 : 2;
        continue;
      }
      if (startsAt(source, i, quote)) {
        i += quote.length;
        quote = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (syntax.line.some((token) => startsAt(source, i, token))) {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    const block = syntax.block.find(([open]) => startsAt(source, i, open));
    if (block) {
      blockEnd = block[1];
      i += block[0].length;
      continue;
    }
    const opensQuote = [...syntax.multi, ...syntax.quotes].find((token) => startsAt(source, i, token));
    if (opensQuote) {
      quote = opensQuote;
      i += opensQuote.length;
      continue;
    }
    if (OPENERS[ch]) {
      stack.push({ line, ch });
    } else if (CLOSERS[ch]) {
      const want = CLOSERS[ch];
      let at = stack.length - 1;
      while (at >= 0 && stack[at]?.ch !== want) {
        at -= 1;
      }
      if (at >= 0) {
        const open = stack[at];
        stack.length = at;
        if (open && line - open.line >= 2) {
          endAt.set(open.line, Math.max(endAt.get(open.line) ?? 0, line));
        }
      }
    }
    i += 1;
  }
  return [...endAt.entries()].sort((a, b) => a[0] - b[0]).map(([start, end]) => ({ start, end }));
}

export function lineIndexAt(source: string, offset: number): number {
  let line = 0;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

export function foldView(source: string, folded: ReadonlySet<number>, syntax?: FoldSyntax): FoldView {
  const endAt = new Map(braceFolds(source, syntax).map((range) => [range.start, range.end]));
  const lines = source.split("\n");
  const hidden = new Set<number>();
  const parts: string[] = [];
  const holes: string[] = [];
  const numbers: number[] = [];
  const markers: Array<FoldMark | null> = [];
  const foldedLines: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (hidden.has(i)) {
      continue;
    }
    const end = endAt.get(i);
    const foldable = end !== undefined && end > i + 1;
    const shut = Boolean(foldable && folded.has(i));
    numbers.push(i + 1);
    markers.push(foldable ? (shut ? "shut" : "open") : null);
    if (shut && end !== undefined) {
      parts.push(`${lines[i] ?? ""}${FOLD_SENTINEL}`);
      holes.push(`\n${lines.slice(i + 1, end).join("\n")}`);
      foldedLines.push(i);
      for (let hiddenLine = i + 1; hiddenLine < end; hiddenLine += 1) {
        hidden.add(hiddenLine);
      }
    } else {
      parts.push(lines[i] ?? "");
    }
  }
  if (numbers.length === 0) {
    numbers.push(1);
    markers.push(null);
  }
  return { display: parts.join("\n"), holes, numbers, markers, foldedLines };
}

export function expandFolds(display: string, holes: string[]): string {
  let hole = 0;
  let out = "";
  for (const ch of display) {
    if (ch === FOLD_SENTINEL) {
      out += holes[hole] ?? "";
      hole += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

export function displayToSource(display: string, holes: string[], offset: number): number {
  let sourceAt = 0;
  let hole = 0;
  const end = Math.max(0, Math.min(offset, display.length));
  for (let i = 0; i < end; i += 1) {
    if (display[i] === FOLD_SENTINEL) {
      sourceAt += holes[hole]?.length ?? 0;
      hole += 1;
      continue;
    }
    sourceAt += 1;
  }
  return sourceAt;
}

export function sourceToDisplay(display: string, holes: string[], offset: number): number {
  let sourceAt = 0;
  let hole = 0;
  const target = Math.max(0, offset);
  for (let i = 0; i < display.length; i += 1) {
    if (sourceAt >= target) {
      return i;
    }
    if (display[i] === FOLD_SENTINEL) {
      const hidden = holes[hole]?.length ?? 0;
      if (sourceAt + hidden > target) {
        return i;
      }
      sourceAt += hidden;
      hole += 1;
      continue;
    }
    sourceAt += 1;
  }
  return display.length;
}

export function sentinelCount(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === FOLD_SENTINEL) {
      count += 1;
    }
  }
  return count;
}

export function foldsAfterEdit(source: string, holes: string[], syntax?: FoldSyntax): Set<number> {
  const openers = new Set(braceFolds(source, syntax).map((range) => range.start));
  const next = new Set<number>();
  let from = 0;
  for (const hole of holes) {
    const at = source.indexOf(hole, from);
    if (at < 0) {
      continue;
    }
    const line = lineIndexAt(source, at);
    if (openers.has(line)) {
      next.add(line);
    }
    from = at + hole.length;
  }
  return next;
}

export function showFoldMarks(html: string): string {
  return html.split(FOLD_SENTINEL).join('<span class="md-fold-mark">…</span>');
}
