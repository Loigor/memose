// shortcut: folds a brace block when { or [ ends the line and the closer is alone on a later line. Indent folding waits until a language needs it.

export const FOLD_SENTINEL = "\u200b";

export type FoldMark = "open" | "shut";

export type FoldView = {
  display: string;
  holes: string[];
  numbers: number[];
  markers: Array<FoldMark | null>;
  foldedLines: number[];
};

type Frame = { line: number; ch: "{" | "[" };

function lineStart(source: string, index: number): number {
  return index === 0 ? 0 : source.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(source: string, index: number): number {
  const at = source.indexOf("\n", index);
  return at === -1 ? source.length : at;
}

export function braceFolds(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: Frame[] = [];
  let line = 0;
  let quote: string | null = null;
  let block = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch === "\n") {
      line += 1;
      quote = null;
      i += 1;
      continue;
    }
    if (block) {
      if (ch === "*" && source[i + 1] === "/") {
        block = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      block = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const rest = source.slice(i + 1, lineEnd(source, i));
      if (rest.trim() === "") {
        stack.push({ line, ch });
      }
      i += 1;
      continue;
    }
    if ((ch === "}" || ch === "]") && stack.length > 0) {
      const want = ch === "}" ? "{" : "[";
      const top = stack[stack.length - 1];
      if (top && top.ch === want) {
        stack.pop();
        const before = source.slice(lineStart(source, i), i);
        const after = source.slice(i + 1, lineEnd(source, i));
        if (top.line < line && before.trim() === "" && /^[,;)\]\s]*$/.test(after)) {
          ranges.push({ start: top.line, end: line });
        }
      }
    }
    i += 1;
  }
  return ranges;
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

export function foldView(source: string, folded: ReadonlySet<number>): FoldView {
  const endAt = new Map(braceFolds(source).map((range) => [range.start, range.end]));
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
    const foldable = end !== undefined && end > i;
    const shut = Boolean(foldable && folded.has(i));
    numbers.push(i + 1);
    markers.push(foldable ? (shut ? "shut" : "open") : null);
    if (shut && end !== undefined) {
      parts.push(`${lines[i] ?? ""}${FOLD_SENTINEL}`);
      holes.push(`\n${lines.slice(i + 1, end + 1).join("\n")}`);
      foldedLines.push(i);
      for (let hiddenLine = i + 1; hiddenLine <= end; hiddenLine += 1) {
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

export function foldsAfterEdit(source: string, holes: string[]): Set<number> {
  const openers = new Set(braceFolds(source).map((range) => range.start));
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
