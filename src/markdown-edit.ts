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
  const selected = value.slice(start, end);
  if (selected.includes("\n")) {
    return wrapText(value, start, end, "```\n", "\n```");
  }
  return wrapText(value, start, end, "`", "`");
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

function renumberOrderedLists(value: string, start: number, end: number): Edit {
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
  const textIndentUnit = "  ";
  const listIndentUnit = "    ";
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

