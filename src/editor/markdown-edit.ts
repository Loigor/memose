export type Edit = { value: string; start: number; end: number };

const taskLine = /^(\s*)([-*+])\s+\[([ xX])\][ \t]*(.*)$/;
const listLine = /^(\s*)([-*+])[ \t]+(.*)$/;
const orderedListLine = /^(\s*)(\d+)([.)])[ \t]+(.*)$/;

function lineBounds(value: string, index: number): { lineStart: number; lineEnd: number } {
  const lineStart = index === 0 ? 0 : value.lastIndexOf("\n", index - 1) + 1;
  const breakAt = value.indexOf("\n", index);
  return { lineStart, lineEnd: breakAt === -1 ? value.length : breakAt };
}

function inFence(value: string, index: number): boolean {
  const fences = value.slice(0, index).match(/^```/gm);
  return (fences?.length ?? 0) % 2 === 1;
}

export function wrapText(value: string, start: number, end: number, before: string, after: string): Edit {
  const selected = value.slice(start, end);
  const next = value.slice(0, start) + before + selected + after + value.slice(end);
  if (selected.length === 0) {
    const cursor = start + before.length;
    return { value: next, start: cursor, end: cursor };
  }
  return { value: next, start: start + before.length, end: end + before.length };
}

export function applyCode(value: string, start: number, end: number): Edit {
  const atLineStart = start === 0 || value[start - 1] === "\n";
  const before = atLineStart ? "```\n" : "\n```\n";
  return wrapText(value, start, end, before, "\n```");
}

export function completeOpenFence(value: string, caret: number): Edit | null {
  if (closedFenceIn(value)) {
    return null;
  }
  const { lineStart, lineEnd } = lineBounds(value, caret);
  const line = value.slice(lineStart, lineEnd);
  const open = /^(```+)\s*$/.exec(line);
  if (!open || caret < lineStart + open[1].length) {
    return null;
  }
  const ticks = open[1];
  const next = `${value.slice(0, lineEnd)}\n${ticks}${value.slice(lineEnd)}`;
  return { value: next, start: lineEnd + 1, end: lineEnd + 1 };
}

export function liftedCodeIndex(blocks: Block[], fromIndex: number): number {
  for (let i = Math.max(0, fromIndex); i < blocks.length; i += 1) {
    if (blocks[i]?.kind === "code") {
      return i;
    }
  }
  return -1;
}

export function applyTitle(value: string, start: number, end: number): Edit {
  const { lineStart, lineEnd } = lineBounds(value, start);
  const line = value.slice(lineStart, lineEnd);
  if (/^#{1,6}\s/.test(line)) {
    return { value, start, end };
  }
  const prefix = "# ";
  return {
    value: value.slice(0, lineStart) + prefix + value.slice(lineStart),
    start: start + prefix.length,
    end: end + prefix.length,
  };
}

export function applyTask(value: string, start: number, end: number): Edit {
  const { lineStart, lineEnd } = lineBounds(value, start);
  const line = value.slice(lineStart, lineEnd);
  if (taskLine.test(line)) {
    return { value, start, end };
  }
  const prefix = "- [ ] ";
  return {
    value: value.slice(0, lineStart) + prefix + value.slice(lineStart),
    start: start + prefix.length,
    end: end + prefix.length,
  };
}

const fenceLine = /^\s*```/;

export function toggleTask(value: string, index: number, checked: boolean): string | null {
  const lines = value.split("\n");
  let seen = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (fenceLine.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const match = /^(\s*[-*+]\s+)\[([ xX])\]/.exec(line);
    if (!match) {
      continue;
    }
    if (seen !== index) {
      seen += 1;
      continue;
    }
    const mark = checked ? "[x]" : "[ ]";
    if (match[0].endsWith(mark)) {
      return value;
    }
    lines[i] = `${match[1]}${mark}${line.slice(match[0].length)}`;
    return lines.join("\n");
  }
  return null;
}

export function taskListOnEnter(value: string, start: number, end: number): Edit | null {
  if (start !== end || inFence(value, start)) {
    return null;
  }
  const { lineStart, lineEnd } = lineBounds(value, start);
  const match = taskLine.exec(value.slice(lineStart, lineEnd));
  if (!match) {
    return listOnEnter(value, start, lineStart, lineEnd);
  }
  const indent = match[1] ?? "";
  const bullet = match[2] ?? "-";
  const body = (match[4] ?? "").trim();
  if (body.length === 0) {
    if (indent.length > 0) {
      const removeCount = indent.startsWith("\t") ? 1 : Math.min(4, indent.length);
      const nextIndent = indent.slice(removeCount);
      const replacement = `${nextIndent}${bullet} [ ] `;
      const next = value.slice(0, lineStart) + replacement + value.slice(lineEnd);
      const cursor = lineStart + replacement.length;
      return renumberOrderedLists(next, cursor, cursor);
    }
    return { value: value.slice(0, lineStart) + value.slice(lineEnd), start: lineStart, end: lineStart };
  }
  const insert = `\n${indent}${bullet} [ ] `;
  const next = value.slice(0, start) + insert + value.slice(end);
  const cursor = start + insert.length;
  return { value: next, start: cursor, end: cursor };
}

function indentCols(indent: string): number {
  return indent.replace(/\t/g, "    ").length;
}

export function renumberOrderedLists(value: string, start: number, end: number): Edit {
  const lines = value.split("\n");
  const counters = new Map<number, number>();
  let fenced = false;
  let offset = 0;
  let nextStart = start;
  let nextEnd = end;
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineStart = offset;
    offset += line.length + 1;

    if (fenceLine.test(line)) {
      fenced = !fenced;
      counters.clear();
      continue;
    }
    if (fenced) {
      continue;
    }
    if (line.trim().length === 0) {
      counters.clear();
      continue;
    }

    const isTask = taskLine.exec(line);
    const isList = !isTask ? listLine.exec(line) : null;
    const isOrdered = !isTask && !isList ? orderedListLine.exec(line) : null;

    if (!isTask && !isList && !isOrdered) {
      const lead = /^[ \t]+/.exec(line);
      const cols = lead ? indentCols(lead[0]) : 0;
      if (cols === 0) {
        counters.clear();
      } else {
        for (const key of [...counters.keys()]) {
          if (key >= cols) {
            counters.delete(key);
          }
        }
      }
      continue;
    }

    const indent = (isTask?.[1] ?? isList?.[1] ?? isOrdered?.[1]) ?? "";
    const cols = indentCols(indent);
    for (const key of [...counters.keys()]) {
      if (key > cols) {
        counters.delete(key);
      }
    }

    if (!isOrdered) {
      counters.delete(cols);
      continue;
    }

    const oldNumStr = isOrdered[2] ?? "1";
    const delim = isOrdered[3] ?? ".";
    const nextNum = (counters.get(cols) ?? 0) + 1;
    counters.set(cols, nextNum);
    const newNumStr = String(nextNum);

    if (oldNumStr !== newNumStr) {
      changed = true;
      const numStartInLine = indent.length;
      const numEndInLine = numStartInLine + oldNumStr.length;
      lines[i] = `${indent}${newNumStr}${delim}${line.slice(numEndInLine + delim.length)}`;
      const delta = newNumStr.length - oldNumStr.length;
      const absNumEnd = lineStart + numEndInLine;
      if (nextStart >= absNumEnd) {
        nextStart += delta;
      } else if (nextStart > lineStart + numStartInLine) {
        nextStart = Math.max(lineStart + numStartInLine, nextStart + delta);
      }
      if (nextEnd >= absNumEnd) {
        nextEnd += delta;
      } else if (nextEnd > lineStart + numStartInLine) {
        nextEnd = Math.max(nextStart, nextEnd + delta);
      }
    }
  }

  if (!changed) {
    return { value, start, end };
  }
  return { value: lines.join("\n"), start: nextStart, end: nextEnd };
}

function listOnEnter(value: string, start: number, lineStart: number, lineEnd: number): Edit | null {
  const line = value.slice(lineStart, lineEnd);
  if (taskLine.test(line)) {
    return null;
  }
  const match = listLine.exec(line);
  if (match) {
    const indent = match[1] ?? "";
    const bullet = match[2] ?? "*";
    const body = (match[3] ?? "").trim();
    if (start < lineStart + indent.length + bullet.length) {
      return null;
    }
    if (body.length === 0) {
      if (indent.length > 0) {
        const removeCount = indent.startsWith("\t") ? 1 : Math.min(4, indent.length);
        const nextIndent = indent.slice(removeCount);
        const replacement = `${nextIndent}${bullet} `;
        const next = value.slice(0, lineStart) + replacement + value.slice(lineEnd);
        const cursor = lineStart + replacement.length;
        return renumberOrderedLists(next, cursor, cursor);
      }
      return { value: value.slice(0, lineStart) + value.slice(lineEnd), start: lineStart, end: lineStart };
    }
    const insert = `\n${indent}${bullet} `;
    const next = value.slice(0, start) + insert + value.slice(start);
    const cursor = start + insert.length;
    return { value: next, start: cursor, end: cursor };
  }
  const ordered = orderedListLine.exec(line);
  if (!ordered) {
    return null;
  }
  const indent = ordered[1] ?? "";
  const numRaw = ordered[2] ?? "1";
  const delim = ordered[3] ?? ".";
  const body = (ordered[4] ?? "").trim();
  if (start < lineStart + indent.length + numRaw.length + delim.length) {
    return null;
  }
  if (body.length === 0) {
    if (indent.length > 0) {
      const removeCount = indent.startsWith("\t") ? 1 : Math.min(4, indent.length);
      const nextIndent = indent.slice(removeCount);
      const replacement = `${nextIndent}1${delim} `;
      const next = value.slice(0, lineStart) + replacement + value.slice(lineEnd);
      const cursor = lineStart + replacement.length;
      return renumberOrderedLists(next, cursor, cursor);
    }
    const stripped = value.slice(0, lineStart) + value.slice(lineEnd);
    return renumberOrderedLists(stripped, lineStart, lineStart);
  }
  const nextNum = Number.parseInt(numRaw, 10) + 1;
  const insert = `\n${indent}${nextNum}${delim} `;
  const next = value.slice(0, start) + insert + value.slice(start);
  const cursor = start + insert.length;
  return renumberOrderedLists(next, cursor, cursor);
}

export function tabOnMarkdown(value: string, start: number, end: number, shiftKey: boolean): Edit {
  const textIndentUnit = "\t";
  const listIndentUnit = "\t";
  if (start === end && !value.slice(start, end).includes("\n")) {
    const { lineStart, lineEnd } = lineBounds(value, start);
    const line = value.slice(lineStart, lineEnd);
    const isTask = taskLine.exec(line);
    const isList = !isTask ? listLine.exec(line) : null;
    const isOrdered = !isTask && !isList ? orderedListLine.exec(line) : null;

    if (isTask || isList || isOrdered) {
      const currentIndent = (isTask?.[1] ?? isList?.[1] ?? isOrdered?.[1]) ?? "";
      if (!shiftKey) {
        const nextLine = listIndentUnit + line;
        const next = value.slice(0, lineStart) + nextLine + value.slice(lineEnd);
        const cursor = start + listIndentUnit.length;
        return renumberOrderedLists(next, cursor, cursor);
      }
      if (currentIndent.length > 0) {
        const removeCount = currentIndent.startsWith("\t")
          ? 1
          : Math.min(listIndentUnit.length, currentIndent.length);
        const nextLine = line.slice(removeCount);
        const next = value.slice(0, lineStart) + nextLine + value.slice(lineEnd);
        const cursor = Math.max(lineStart, start - removeCount);
        return renumberOrderedLists(next, cursor, cursor);
      }
      let prefixLen = 0;
      if (isTask) {
        const body = isTask[4] ?? "";
        prefixLen = line.length - body.length;
      } else if (isList) {
        const body = isList[3] ?? "";
        prefixLen = line.length - body.length;
      } else if (isOrdered) {
        const body = isOrdered[4] ?? "";
        prefixLen = line.length - body.length;
      }
      const nextLine = line.slice(prefixLen);
      const next = value.slice(0, lineStart) + nextLine + value.slice(lineEnd);
      const cursor = Math.max(lineStart, start - prefixLen);
      return renumberOrderedLists(next, cursor, cursor);
    }

    if (!shiftKey) {
      const next = value.slice(0, start) + textIndentUnit + value.slice(end);
      const cursor = start + textIndentUnit.length;
      return { value: next, start: cursor, end: cursor };
    }
    const leadMatch = /^[ \t]+/.exec(line);
    if (!leadMatch) {
      return { value, start, end };
    }
    const removeCount = leadMatch[0].startsWith("\t") ? 1 : Math.min(textIndentUnit.length, leadMatch[0].length);
    const nextLine = line.slice(removeCount);
    const next = value.slice(0, lineStart) + nextLine + value.slice(lineEnd);
    const cursor = Math.max(lineStart, start - removeCount);
    return { value: next, start: cursor, end: cursor };
  }

  const firstBounds = lineBounds(value, start);
  const effectiveEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lastBounds = lineBounds(value, effectiveEnd);
  const blockSlice = value.slice(firstBounds.lineStart, lastBounds.lineEnd);
  const lines = blockSlice.split("\n");
  let firstDelta = 0;
  let totalDelta = 0;
  const updatedLines = lines.map((line, idx) => {
    const isTask = taskLine.exec(line);
    const isList = !isTask ? listLine.exec(line) : null;
    const isOrdered = !isTask && !isList ? orderedListLine.exec(line) : null;
    const unit = isTask || isList || isOrdered ? listIndentUnit : textIndentUnit;
    if (!shiftKey) {
      if (idx === 0) firstDelta = unit.length;
      totalDelta += unit.length;
      return unit + line;
    }
    const leadMatch = /^[ \t]+/.exec(line);
    if (leadMatch) {
      const removeCount = leadMatch[0].startsWith("\t") ? 1 : Math.min(unit.length, leadMatch[0].length);
      if (idx === 0) firstDelta = -removeCount;
      totalDelta -= removeCount;
      return line.slice(removeCount);
    }
    if (isTask || isList || isOrdered) {
      const body = (isTask?.[4] ?? isList?.[3] ?? isOrdered?.[4]) ?? "";
      const prefixLen = line.length - body.length;
      if (idx === 0) firstDelta = -prefixLen;
      totalDelta -= prefixLen;
      return line.slice(prefixLen);
    }
    return line;
  });

  const replaced = updatedLines.join("\n");
  const next = value.slice(0, firstBounds.lineStart) + replaced + value.slice(lastBounds.lineEnd);
  const nextStart = Math.max(firstBounds.lineStart, start + firstDelta);
  const nextEnd = Math.max(nextStart, end + totalDelta);
  return renumberOrderedLists(next, nextStart, nextEnd);
}

export type TextBlock = { kind: "text"; text: string };
export type CodeBlock = { kind: "code"; lang: string; text: string };
export type MediaBlock = { kind: "media"; name: string; label?: string; width?: number; inline?: boolean };
export type Block = TextBlock | CodeBlock | MediaBlock;

export function isTypedBlock(block: Block): block is TextBlock | CodeBlock {
  return block.kind === "text" || block.kind === "code";
}

export function closedFenceIn(value: string): boolean {
  let ticks: string | null = null;
  for (const line of value.split("\n")) {
    if (ticks) {
      const close = /^(```+)(\s*)$/.exec(line);
      if (close && close[1].length >= ticks.length) {
        return true;
      }
      continue;
    }
    const open = /^(```+)([^`]*)$/.exec(line);
    if (open) {
      ticks = open[1];
    }
  }
  return false;
}

function splitFencedCode(text: string): Array<TextBlock | CodeBlock> {
  const lines = text.split("\n");
  const out: Array<TextBlock | CodeBlock> = [];
  let textLines: string[] = [];
  let open: { ticks: string; lang: string; body: string[] } | null = null;
  const flushText = () => {
    if (textLines.length === 0) {
      return;
    }
    out.push({ kind: "text", text: textLines.join("\n") });
    textLines = [];
  };
  for (const line of lines) {
    if (!open) {
      const match = /^(```+)([^`]*)$/.exec(line);
      if (match) {
        flushText();
        open = { ticks: match[1] ?? "```", lang: (match[2] ?? "").trim(), body: [] };
        continue;
      }
      textLines.push(line);
      continue;
    }
    const close = /^(```+)(\s*)$/.exec(line);
    if (close && close[1].length >= open.ticks.length) {
      out.push({ kind: "code", lang: open.lang, text: open.body.join("\n") });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  if (open) {
    textLines.push(`${open.ticks}${open.lang}`, ...open.body);
  }
  flushText();
  return out;
}

export const mediaPrefix = "memose-media/";
export const mediaTokenRegex = /(!?)\[([^\]]*)\]\(memose-media\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)(?:#([^)]*))?\)/;
export const mediaTokenGlobal = /(!?)\[([^\]]*)\]\(memose-media\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)(?:#([^)]*))?\)/g;

export function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?)$/i.test(name);
}

export function isVideo(name: string): boolean {
  return /\.(mp4|webm|mov|m4v|mkv|ogv|avi)$/i.test(name);
}

export function isAudio(name: string): boolean {
  return /\.(mp3|wav|ogg|m4a|aac|flac|opus|weba|wma)$/i.test(name);
}

export function isPreviewableMedia(name: string): boolean {
  return isImage(name) || isVideo(name) || isAudio(name);
}

export function displayFileName(name: string, label?: string): string {
  const trimmed = label?.trim();
  if (trimmed) {
    return trimmed;
  }
  const match = name.match(/^[0-9a-f]{8}-(.+)$/i);
  return match ? match[1].replace(/_/g, " ") : name;
}

export function parseMediaMeta(rawLabel?: string, rawFrag?: string): { label?: string; width?: number } {
  let width: number | undefined;
  let cleanLabel = rawLabel?.trim();
  if (cleanLabel) {
    const pipeMatch = cleanLabel.match(/^(.*?)\|(\d{2,4})$/);
    if (pipeMatch) {
      cleanLabel = pipeMatch[1].trim();
      const parsedW = Number(pipeMatch[2]);
      if (parsedW >= 40 && parsedW <= 2000) {
        width = parsedW;
      }
    }
  }
  if (rawFrag) {
    const params = new URLSearchParams(rawFrag);
    const wParam = Number(params.get("w"));
    if (wParam >= 40 && wParam <= 2000) {
      width = Math.round(wParam);
    }
  }
  return { label: cleanLabel || undefined, width };
}

export function mediaMarkdown(name: string, label?: string, width?: number): string {
  const cleanLabel = (label ?? "").replace(/[\r\n]/g, "").replace(/\[/g, "(").replace(/\]/g, ")").trim();
  const frag = width && width >= 40 ? `#w=${Math.round(width)}` : "";
  if (isPreviewableMedia(name)) {
    return `![${cleanLabel}](${mediaPrefix}${name}${frag})`;
  }
  const shown = cleanLabel || displayFileName(name);
  return `[${shown}](${mediaPrefix}${name}${frag})`;
}

function isAtom(block: Block): boolean {
  return block.kind === "media" || block.kind === "code";
}

export function ensureTextSlots(items: Block[]): Block[] {
  const next: Block[] = [];
  for (const block of items) {
    if (isAtom(block) && (next.length === 0 || isAtom(next[next.length - 1]!))) {
      next.push({ kind: "text", text: "" });
    }
    const previous = next[next.length - 1];
    if (block.kind === "text" && previous?.kind === "text") {
      if (previous.text.length > 0 && block.text.length > 0) {
        previous.text = `${previous.text}\n${block.text}`;
      } else {
        previous.text = previous.text || block.text;
      }
      continue;
    }
    if (block.kind === "text") {
      next.push({ kind: "text", text: block.text });
    } else if (block.kind === "code") {
      next.push({ kind: "code", lang: block.lang, text: block.text });
    } else {
      next.push({
        kind: "media",
        name: block.name,
        label: block.label,
        width: block.width,
        inline: block.inline,
      });
    }
  }
  if (next.length === 0 || isAtom(next[next.length - 1]!)) {
    next.push({ kind: "text", text: "" });
  }
  if (next[0] && isAtom(next[0])) {
    next.unshift({ kind: "text", text: "" });
  }
  return next;
}

export function parseBlocks(content: string): Block[] {
  const next: Block[] = [];
  let lastIndex = 0;
  mediaTokenGlobal.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = mediaTokenGlobal.exec(content)) !== null) {
    const tokenStart = match.index;
    const tokenEnd = match.index + match[0].length;
    const charBefore = tokenStart > 0 ? content[tokenStart - 1] : "\n";
    const charAfter = tokenEnd < content.length ? content[tokenEnd] : "\n";
    const hasInlineNeighbor = charBefore !== "\n" || (charAfter !== "\n" && charAfter !== "\r");
    const meta = parseMediaMeta(match[2], match[4]);
    const fragInline = Boolean(match[4] && new URLSearchParams(match[4]).get("inline") === "1");
    const inline = hasInlineNeighbor || fragInline;

    if (tokenStart > lastIndex) {
      let before = content.slice(lastIndex, tokenStart);
      if (lastIndex > 0 && next[next.length - 1]?.kind === "media" && !(next[next.length - 1] as MediaBlock).inline) {
        before = before.replace(/^\r?\n/, "");
      }
      if (!inline) {
        before = before.replace(/\r?\n$/, "");
      }
      if (before.length > 0) {
        next.push(...splitFencedCode(before));
      }
    }
    next.push({
      kind: "media",
      name: match[3],
      label: meta.label,
      width: meta.width,
      inline,
    });
    lastIndex = tokenEnd;
  }
  if (lastIndex < content.length) {
    let after = content.slice(lastIndex);
    if (lastIndex > 0 && next[next.length - 1]?.kind === "media" && !(next[next.length - 1] as MediaBlock).inline) {
      after = after.replace(/^\r?\n/, "");
    }
    if (after.length > 0) {
      next.push(...splitFencedCode(after));
    }
  }
  return ensureTextSlots(next);
}

export function serializeBlocks(items: Block[]): string {
  let out = "";
  for (let i = 0; i < items.length; i += 1) {
    const block = items[i];
    if (block.kind === "text") {
      if (block.text.length === 0) {
        continue;
      }
      const prev = items[i - 1];
      const prevIsInlineMedia = prev?.kind === "media" && Boolean(prev.inline);
      if (out.length > 0 && !prevIsInlineMedia && !out.endsWith("\n")) {
        out += "\n";
      }
      out += block.text;
    } else if (block.kind === "code") {
      if (out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
      }
      out += `\`\`\`${block.lang}\n${block.text}${block.text ? "\n" : ""}\`\`\``;
    } else {
      const md = mediaMarkdown(block.name, block.label, block.width);
      if (block.inline) {
        out += md;
      } else {
        if (out.length > 0 && !out.endsWith("\n")) {
          out += "\n";
        }
        out += md;
      }
    }
  }
  return out;
}

export function applyJsonFormat(value: string): Edit | null {
  const next = formatDocument(value);
  if (next == null || next === value) {
    return null;
  }
  return { value: next, start: 0, end: 0 };
}

export function formatDocument(text: string): string | null {
  const json = formatJsonDocument(text);
  if (json != null) {
    return json;
  }
  const indented = indentCLike(text);
  return indented === text ? null : indented;
}

type CodeScan = { quote: string | null; escape: boolean; block: boolean };

function indentCLike(text: string): string {
  const tab = "  ";
  const ended = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (ended && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const scan: CodeScan = { quote: null, escape: false, block: false };
  let depth = 0;
  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    const { leadingClose, delta } = scanCodeLine(trimmed, scan);
    depth = Math.max(0, depth - leadingClose);
    out.push(trimmed ? tab.repeat(depth) + trimmed : "");
    depth = Math.max(0, depth + delta + leadingClose);
  }
  const next = out.join("\n");
  return ended ? `${next}\n` : next;
}

function scanCodeLine(line: string, scan: CodeScan): { leadingClose: number; delta: number } {
  let leadingClose = 0;
  for (const char of line) {
    if (char === " " || char === "\t") {
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      leadingClose += 1;
      continue;
    }
    break;
  }
  let delta = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (scan.block) {
      if (char === "*" && next === "/") {
        scan.block = false;
        index += 1;
      }
      continue;
    }
    if (scan.quote) {
      if (scan.escape) {
        scan.escape = false;
        continue;
      }
      if (char === "\\") {
        scan.escape = true;
        continue;
      }
      if (char === scan.quote) {
        scan.quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      break;
    }
    if (char === "/" && next === "*") {
      scan.block = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      scan.quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      delta += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      delta -= 1;
    }
  }
  return { leadingClose, delta };
}

export function formatJsonDocument(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
    return text.endsWith("\n") ? `${pretty}\n` : pretty;
  } catch {
    let changed = false;
    const next = text.replace(/```json[^\n]*\n([\s\S]*?)```/gi, (full, body: string) => {
      try {
        const pretty = JSON.stringify(JSON.parse(body), null, 2);
        changed = true;
        return `\`\`\`json\n${pretty}\n\`\`\``;
      } catch {
        return full;
      }
    });
    return changed ? next : null;
  }
}

export function noteTitle(content: string): string {
  const withoutMedia = content.replace(mediaTokenGlobal, "").trim();
  const textLine = withoutMedia
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (textLine) {
    return textLine.replace(/^#+\s*/, "");
  }
  const match = content.match(mediaTokenRegex);
  if (match?.[3]) {
    const name = match[3];
    const meta = parseMediaMeta(match[2], match[4]);
    if (meta.label) {
      return meta.label;
    }
    if (isVideo(name)) {
      return "Video";
    }
    if (isAudio(name)) {
      return "Audio";
    }
    if (isImage(name)) {
      return "Image";
    }
    return displayFileName(name);
  }
  return "Note";
}


