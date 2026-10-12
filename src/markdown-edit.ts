export type Edit = { value: string; start: number; end: number };

const taskLine = /^(\s*)([-*+])\s+\[([ xX])\][ \t]*(.*)$/;
const listLine = /^(\s*)([-*+])[ \t]+(.*)$/;

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
  const body = match[4] ?? "";
  if (body.length === 0) {
    return { value: value.slice(0, lineStart) + value.slice(lineEnd), start: lineStart, end: lineStart };
  }
  const insert = `\n${indent}${bullet} [ ] `;
  const next = value.slice(0, start) + insert + value.slice(end);
  const cursor = start + insert.length;
  return { value: next, start: cursor, end: cursor };
}

function listOnEnter(value: string, start: number, lineStart: number, lineEnd: number): Edit | null {
  const line = value.slice(lineStart, lineEnd);
  const match = listLine.exec(line);
  if (!match || taskLine.test(line)) {
    return null;
  }
  const indent = match[1] ?? "";
  const bullet = match[2] ?? "*";
  const body = (match[3] ?? "").trim();
  if (start < lineStart + indent.length + bullet.length) {
    return null;
  }
  if (body.length === 0) {
    return { value: value.slice(0, lineStart) + value.slice(lineEnd), start: lineStart, end: lineStart };
  }
  const insert = `\n${indent}${bullet} `;
  const next = value.slice(0, start) + insert + value.slice(start);
  const cursor = start + insert.length;
  return { value: next, start: cursor, end: cursor };
}
