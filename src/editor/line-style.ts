import { tagLengthAt } from "./md-tags.ts";

const heading = /^(#{1,6})[ \t]/;
const hr = /^\s*([-*_]\s*){3,}$/;
const task = /^\s*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/;
const taskBox = /^(\s*(?:[-*+]|\d+[.)])[ \t]+\[[ xX]\])/;
const bullet = /^\s*[-*+][ \t]+\S/;
const ordered = /^\s*\d+[.)][ \t]+\S/;
const word = /[\p{L}\p{N}]/u;
const codeRe = /`[^`\n]+`/y;
const imageRe = /!\[[^\]]*\]\([^)\n]*\)/y;
const linkRe = /\[[^\]]+\]\([^)\n]*\)/y;
const strongStarRe = /\*\*[^*\n]+\*\*/y;
const strongUnderRe = /__[^_\n]+__/y;
const emStarRe = /\*(?!\*)[^*\n]+\*(?!\*)/y;

export type InlineMark = "plain" | "marker" | "strong" | "em" | "code" | "link" | "tag";

const listPrefix = /^(\s*(?:[-*+]|\d+[.)])(?:[ \t]+\[[ xX]\])?)[ \t]+\S/;

export function markerPrefix(text: string): number {
  if (heading.test(text)) {
    return 0;
  }
  if (text.startsWith(">")) {
    const second = text[1];
    return second === " " || second === "\t" ? 2 : 1;
  }
  if (hr.test(text)) {
    return 0;
  }
  const box = taskBox.exec(text);
  if (box?.[1]) {
    let end = box[1].length;
    while (text[end] === " " || text[end] === "\t") {
      end += 1;
    }
    return end;
  }
  const list = listPrefix.exec(text);
  if (!list?.[1]) {
    return 0;
  }
  let end = list[1].length;
  while (text[end] === " " || text[end] === "\t") {
    end += 1;
  }
  return end;
}

export type InlinePiece = { text: string; mark: InlineMark; inner?: InlinePiece[] };

function tagPieces(text: string): InlinePiece[] {
  const out: InlinePiece[] = [];
  let index = 0;
  let plain = 0;
  const flush = (to: number) => {
    if (to > plain) {
      out.push({ text: text.slice(plain, to), mark: "plain" });
    }
  };
  while (index < text.length) {
    if (text[index] === "#") {
      const len = tagLengthAt(text, index);
      if (len > 0) {
        flush(index);
        out.push({ text: text.slice(index, index + len), mark: "tag" });
        index += len;
        plain = index;
        continue;
      }
    }
    index += 1;
  }
  flush(text.length);
  return out;
}

function pieceFor(text: string, mark: InlineMark, tags: boolean): InlinePiece {
  if (!tags || (mark !== "strong" && mark !== "em") || !text.includes("#")) {
    return { text, mark };
  }
  const inner = tagPieces(text);
  if (!inner.some((piece) => piece.mark === "tag")) {
    return { text, mark };
  }
  return { text, mark, inner };
}

function stickyAt(re: RegExp, text: string, index: number): number {
  re.lastIndex = index;
  const match = re.exec(text);
  return match && match.index === index ? match[0].length : 0;
}

function emUnder(text: string, index: number): number {
  if (text[index] !== "_" || text[index + 1] === "_") {
    return 0;
  }
  const prev = index > 0 ? text[index - 1] : "";
  if (prev && word.test(prev)) {
    return 0;
  }
  let end = index + 1;
  while (end < text.length && text[end] !== "_" && text[end] !== "\n") {
    end += 1;
  }
  if (text[end] !== "_" || end === index + 1 || text[end + 1] === "_") {
    return 0;
  }
  const next = text[end + 1] ?? "";
  if (next && word.test(next)) {
    return 0;
  }
  if (text[index + 1] === " " || text[end - 1] === " ") {
    return 0;
  }
  return end + 1 - index;
}

function markAt(text: string, index: number, tags: boolean): { len: number; mark: InlineMark } | null {
  const ch = text[index];
  if (ch === "`") {
    const len = stickyAt(codeRe, text, index);
    return len > 0 ? { len, mark: "code" } : null;
  }
  if (ch === "!" || ch === "[") {
    const len = stickyAt(ch === "!" ? imageRe : linkRe, text, index);
    return len > 0 ? { len, mark: "link" } : null;
  }
  if (ch === "*") {
    const strong = stickyAt(strongStarRe, text, index);
    if (strong > 0) {
      return { len: strong, mark: "strong" };
    }
    const em = stickyAt(emStarRe, text, index);
    return em > 0 ? { len: em, mark: "em" } : null;
  }
  if (ch === "_") {
    const strong = stickyAt(strongUnderRe, text, index);
    if (strong > 0) {
      return { len: strong, mark: "strong" };
    }
    const em = emUnder(text, index);
    return em > 0 ? { len: em, mark: "em" } : null;
  }
  if (tags && ch === "#") {
    const len = tagLengthAt(text, index);
    return len > 0 ? { len, mark: "tag" } : null;
  }
  return null;
}

export function inlinePieces(text: string): InlinePiece[] {
  if (hr.test(text)) {
    return [{ text, mark: "plain" }];
  }
  const out: InlinePiece[] = [];
  const marked = markerPrefix(text);
  let index = 0;
  if (marked > 0) {
    out.push({ text: text.slice(0, marked), mark: "marker" });
    index = marked;
  }
  let plain = index;
  const flush = (to: number) => {
    if (to > plain) {
      out.push({ text: text.slice(plain, to), mark: "plain" });
    }
  };
  const tags = !heading.test(text);
  while (index < text.length) {
    const hit = markAt(text, index, tags);
    if (!hit) {
      index += 1;
      continue;
    }
    flush(index);
    out.push(pieceFor(text.slice(index, index + hit.len), hit.mark, tags));
    index += hit.len;
    plain = index;
  }
  flush(text.length);
  return out.length > 0 ? out : [{ text: "", mark: "plain" }];
}

export function rowClass(text: string): string {
  const atx = heading.exec(text);
  if (atx) {
    return `md-row is-h${atx[1].length}`;
  }
  if (text.startsWith(">")) {
    return "md-row is-quote";
  }
  if (hr.test(text)) {
    return "md-row is-hr";
  }
  const taskMatch = task.exec(text);
  if (taskMatch) {
    return taskMatch[1] === "x" || taskMatch[1] === "X" ? "md-row is-task is-done" : "md-row is-task";
  }
  if (bullet.test(text)) {
    return "md-row is-ul";
  }
  if (ordered.test(text)) {
    return "md-row is-ol";
  }
  return "md-row";
}

export type RenderPart = {
  text: string;
  syntax?: boolean;
  cls?: string;
  check?: boolean;
  checked?: boolean;
  children?: RenderPart[];
};

function edgesOf(text: string, mark: InlineMark): { open: string; body: string; close: string } | null {
  if ((mark === "strong" || mark === "em") && text.length >= 2) {
    const pairs = mark === "strong" ? ["**", "__"] : ["*", "_"];
    for (const open of pairs) {
      if (text.startsWith(open) && text.endsWith(open) && text.length >= open.length * 2) {
        return { open, body: text.slice(open.length, -open.length), close: open };
      }
    }
  }
  if (mark === "code" && text.startsWith("`") && text.endsWith("`") && text.length >= 2) {
    return { open: "`", body: text.slice(1, -1), close: "`" };
  }
  if (mark === "link") {
    const start = text.indexOf("[");
    const mid = text.indexOf("](");
    if (start >= 0 && mid > start && text.endsWith(")")) {
      return { open: text.slice(0, start + 1), body: text.slice(start + 1, mid), close: text.slice(mid) };
    }
  }
  return null;
}

function styledParts(text: string, mark: InlineMark, tags: boolean): RenderPart[] {
  if (mark === "plain") {
    return [{ text }];
  }
  if (mark === "tag") {
    return [{ text, cls: "md-tag" }];
  }
  const edges = edgesOf(text, mark);
  const cls = mark === "strong" ? "md-strong" : mark === "em" ? "md-em" : mark === "code" ? "md-code" : mark === "link" ? "md-link" : "";
  if (!edges) {
    return [{ text, cls: cls || undefined }];
  }
  const parts: RenderPart[] = [];
  if (edges.open) {
    parts.push({ text: edges.open, syntax: true });
  }
  if (edges.body) {
    const bits = tags && (mark === "strong" || mark === "em") ? tagPieces(edges.body) : [{ text: edges.body, mark: "plain" as const }];
    if (bits.length === 1 && bits[0]?.mark !== "tag") {
      parts.push({ text: edges.body, cls });
    } else {
      parts.push({
        text: edges.body,
        cls,
        children: bits.map((bit) => (bit.mark === "tag" ? { text: bit.text, cls: "md-tag" } : { text: bit.text })),
      });
    }
  }
  if (edges.close) {
    parts.push({ text: edges.close, syntax: true });
  }
  return parts;
}

function strikePart(part: RenderPart): RenderPart {
  if (part.syntax || part.check) {
    return part;
  }
  const cls = part.cls ? `${part.cls} md-strike` : "md-strike";
  return { ...part, cls, children: part.children?.map(strikePart) };
}

export function renderParts(text: string): RenderPart[] {
  if (text.length === 0) {
    return [];
  }
  if (hr.test(text)) {
    return [{ text, syntax: true }];
  }
  const kind = rowClass(text);
  const done = kind.includes("is-done");
  const tags = !heading.test(text);
  const parts: RenderPart[] = [];
  for (const piece of inlinePieces(text)) {
    if (piece.mark === "marker") {
      if (kind.includes("is-task")) {
        parts.push({ text: "", check: true, checked: /\[[xX]\]/.test(piece.text) });
        parts.push({ text: piece.text, syntax: true });
      } else if (kind.includes("is-ol")) {
        parts.push({ text: piece.text, cls: "md-marker" });
      } else {
        parts.push({ text: piece.text, syntax: true });
      }
      continue;
    }
    if (parts.length === 0 && piece.mark === "plain" && heading.test(text)) {
      const head = /^(#{1,6}[ \t]+)/.exec(piece.text);
      if (head?.[1]) {
        parts.push({ text: head[1], syntax: true });
        const rest = piece.text.slice(head[1].length);
        if (rest) {
          parts.push(done ? strikePart({ text: rest }) : { text: rest });
        }
        continue;
      }
    }
    for (const part of styledParts(piece.text, piece.mark, tags)) {
      parts.push(done ? strikePart(part) : part);
    }
  }
  return parts;
}

function walkParts(parts: RenderPart[], index: number, cursor = { at: 0 }): boolean | null {
  for (const part of parts) {
    if (part.children) {
      const hit = walkParts(part.children, index, cursor);
      if (hit !== null) {
        return hit;
      }
      continue;
    }
    const next = cursor.at + part.text.length;
    if (index < next) {
      return Boolean(part.syntax);
    }
    cursor.at = next;
  }
  return null;
}

function lineAt(text: string, offset: number): { start: number; end: number; line: string; column: number } {
  const bounded = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf("\n", Math.max(0, bounded - 1)) + 1;
  const nl = text.indexOf("\n", start);
  const end = nl < 0 ? text.length : nl;
  return { start, end, line: text.slice(start, end), column: bounded - start };
}

export function syntaxAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length || text[index] === "\n") {
    return false;
  }
  const { line, column } = lineAt(text, index);
  return walkParts(renderParts(line), column) ?? false;
}

export function snapOffset(text: string, offset: number): number {
  let index = Math.max(0, Math.min(offset, text.length));
  while (index < text.length && text[index] !== "\n" && syntaxAt(text, index)) {
    index += 1;
  }
  return index;
}

export function lineFrame(text: string, offset: number): { start: number; end: number; visual: number } {
  const { start, end, line } = lineAt(text, offset);
  return { start, end, visual: start + snapOffset(line, 0) };
}

export function stepOffset(text: string, offset: number, dir: -1 | 1): number {
  const snapped = snapOffset(text, offset);
  if (dir > 0) {
    if (snapped >= text.length || text[snapped] === "\n") {
      return snapped;
    }
    return snapOffset(text, snapped + 1);
  }
  let index = snapped - 1;
  while (index > 0 && text[index] !== "\n" && syntaxAt(text, index)) {
    index -= 1;
  }
  return Math.max(0, index);
}

export function backspaceEdit(text: string, offset: number): { text: string; offset: number } | null {
  if (offset <= 0 || offset > text.length || text[offset - 1] === "\n" || !syntaxAt(text, offset - 1)) {
    return null;
  }
  let index = offset - 1;
  while (index >= 0 && text[index] !== "\n" && syntaxAt(text, index)) {
    index -= 1;
  }
  if (index >= 0 && text[index] !== "\n") {
    return { text: text.slice(0, index) + text.slice(index + 1), offset: index };
  }
  const { start } = lineAt(text, offset);
  return { text: text.slice(0, start) + text.slice(offset), offset: start };
}
