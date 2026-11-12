import type { Editable } from "./editable.ts";
import { handleBlockAreaNavigation, handleBlockMediaDeletion } from "./editor-blocks.ts";
import { renderParts, rowClass, type RenderPart } from "./line-style.ts";
import {
  closedFenceIn,
  completeOpenFence,
  mediaTokenRegex,
  tabOnMarkdown,
  taskListOnEnter,
  type Block,
  type Edit,
} from "./markdown-edit.ts";

export type LineEditorOptions = {
  text: string;
  index: number;
  placeholder: string;
  grow: boolean;
  inline: boolean;
  empty: boolean;
  container: HTMLElement;
  blocks: () => Block[];
  undo: (force: boolean) => void;
  change: (value: string, caret: { start: number; end: number }) => void;
  reparse: (value: string) => void;
  apply: (edit: Edit) => void;
  removeMedia: (mediaIndex: number, focusBlockIndex: number, caretOffset: number) => void;
  splitInline: (before: string, after: string) => void;
  releaseInline: () => void;
  allowTab: () => boolean;
  onCaret: () => void;
};

export function mountLineEditor(options: LineEditorOptions): { shell: HTMLElement; field: Editable } {
  const shell = document.createElement("div");
  shell.className = "md-field";
  const root = document.createElement("div");
  root.className = "md-lines";
  root.contentEditable = "true";
  root.spellcheck = false;
  root.autocapitalize = "off";
  root.setAttribute("autocorrect", "off");
  root.setAttribute("writingsuggestions", "false");
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");
  root.dataset.blockField = "";
  root.dataset.index = String(options.index);
  root.dataset.kind = "text";
  if (options.placeholder) {
    root.setAttribute("placeholder", options.placeholder);
    root.dataset.placeholder = options.placeholder;
  }
  if (options.grow) {
    root.classList.add("grow");
  }
  if (options.inline) {
    root.classList.add("inline-line-slot");
  }
  if (options.empty) {
    root.classList.add("empty-slot");
  }
  shell.append(root);

  const field = root as unknown as Editable;
  let saved = { start: 0, end: 0, focus: 0 };
  let writing = false;
  let composing = false;
  let skipBreak = false;
  let ticket = 0;

  const readValue = () => {
    const parts: string[] = [];
    for (const row of root.children) {
      parts.push(row.textContent ?? "");
    }
    return parts.join("\n");
  };

  const paintEmpty = (value: string) => {
    const empty = value.length === 0;
    root.classList.toggle("is-empty", empty);
    const rows = root.querySelectorAll<HTMLElement>(":scope > .md-row");
    rows.forEach((row, index) => {
      if (empty && index === 0 && root.dataset.placeholder) {
        row.dataset.placeholder = root.dataset.placeholder;
      } else {
        delete row.dataset.placeholder;
      }
    });
  };

  const fillRow = (row: HTMLElement, text: string) => {
    row.className = rowClass(text);
    paintMarks(row, text);
  };

  const writeAll = (text: string) => {
    writing = true;
    try {
      const lines = text.split("\n");
      const rows = [...root.children].filter((el): el is HTMLElement => el.classList.contains("md-row"));
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        let row = rows[i];
        if (!row) {
          row = document.createElement("div");
          root.append(row);
        }
        if (!isCleanRow(row) || (row.textContent ?? "") !== line) {
          fillRow(row, line);
        } else {
          const next = rowClass(line);
          if (row.className !== next) {
            row.className = next;
          }
          paintMarks(row, line);
        }
      }
      for (let i = lines.length; i < rows.length; i += 1) {
        rows[i]?.remove();
      }
      for (const node of [...root.childNodes]) {
        if (!(node instanceof HTMLElement) || !node.classList.contains("md-row")) {
          node.remove();
        }
      }
      paintEmpty(text);
    } finally {
      writing = false;
    }
  };

  const pointAt = (offset: number): { node: Node; offset: number } => {
    let left = Math.max(0, offset);
    const rows = [...root.children];
    if (rows.length === 0) {
      return { node: root, offset: 0 };
    }
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const text = row.textContent ?? "";
      if ((left <= text.length || i === rows.length - 1) && row instanceof HTMLElement) {
        return pointInRow(row, left);
      }
      left -= text.length + 1;
    }
    return { node: root, offset: root.childNodes.length };
  };

  const setRange = (start: number, end: number, focusAt = end) => {
    const anchorAt = focusAt === start ? end : start;
    const anchorPoint = pointAt(anchorAt);
    const focusPoint = pointAt(focusAt);
    const sel = root.ownerDocument.getSelection();
    sel?.setBaseAndExtent(anchorPoint.node, anchorPoint.offset, focusPoint.node, focusPoint.offset);
  };

  let painting = false;
  const reveal = (caret: { start: number; end: number; focus?: number }, focused?: boolean) => {
    if (painting) {
      return;
    }
    painting = true;
    try {
      const active = root.ownerDocument.activeElement;
      const hasFocus = focused ?? (active === root || (active instanceof Node && root.contains(active)));
      const value = readValue();
      const live = new Set<number>();
      if (hasFocus) {
        live.add(lineIndex(value, caret.focus ?? caret.end));
      }
      let rebuilt = false;
      const rows = [...root.querySelectorAll<HTMLElement>(":scope > .md-row")];
      rows.forEach((row, index) => {
        const text = row.textContent ?? "";
        const source = live.has(index);
        const next = `${rowClass(text)}${source ? " is-live" : ""}`;
        if (row.className !== next) {
          row.className = next;
        }
        if (source) {
          row.style.removeProperty("--lead");
          if (paintSource(row, text)) {
            rebuilt = true;
          }
        } else if (paintMarks(row, text)) {
          rebuilt = true;
        }
      });
      if (rebuilt && hasFocus) {
        setRange(caret.start, caret.end, caret.focus ?? caret.end);
      }
    } finally {
      painting = false;
    }
  };

  const place = (start: number, end: number) => {
    const value = readValue();
    const from = Math.max(0, Math.min(Math.min(start, end), value.length));
    const to = Math.max(0, Math.min(Math.max(start, end), value.length));
    saved = { start: from, end: to, focus: to };
    setRange(from, to);
    reveal(saved);
  };

  const offsetOf = (node: Node, nodeOffset: number): number | null => {
    if (node !== root && !root.contains(node)) {
      return null;
    }
    if (node === root) {
      let pos = 0;
      const kids = [...root.childNodes];
      const index = Math.min(nodeOffset, kids.length);
      for (let i = 0; i < index; i += 1) {
        pos += (kids[i].textContent?.length ?? 0) + 1;
      }
      return pos;
    }
    const row =
      node instanceof HTMLElement && node.classList.contains("md-row")
        ? node
        : node.parentElement?.closest(".md-row");
    if (!(row instanceof HTMLElement) || !root.contains(row)) {
      return null;
    }
    let pos = 0;
    for (const child of root.children) {
      if (child === row) {
        return pos + (columnInRow(row, node, nodeOffset) ?? 0);
      }
      pos += (child.textContent?.length ?? 0) + 1;
    }
    return null;
  };

  const liveCaret = (): { start: number; end: number; focus: number } | null => {
    const sel = root.ownerDocument.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) {
      return null;
    }
    const anchor = offsetOf(sel.anchorNode, sel.anchorOffset);
    const focus = offsetOf(sel.focusNode, sel.focusOffset);
    if (anchor == null || focus == null) {
      return null;
    }
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), focus };
  };

  const currentCaret = () => {
    const live = liveCaret();
    if (live) {
      saved = live;
    }
    return saved;
  };

  Object.defineProperty(field, "value", {
    configurable: true,
    get: () => readValue(),
    set: (next: string) => {
      writeAll(String(next));
    },
  });
  Object.defineProperty(field, "selectionStart", {
    configurable: true,
    get: () => currentCaret().start,
  });
  Object.defineProperty(field, "selectionEnd", {
    configurable: true,
    get: () => currentCaret().end,
  });
  field.setSelectionRange = (start: number, end: number) => {
    place(start, end);
  };

  const scheduleReparse = (value: string) => {
    const mine = ++ticket;
    queueMicrotask(() => {
      if (mine !== ticket || !root.isConnected) {
        return;
      }
      options.reparse(value);
    });
  };

  const publish = (value: string, caret: { start: number; end: number }) => {
    const closed = completeOpenFence(value, caret.start);
    if (closed) {
      writeAll(closed.value);
      place(closed.start, closed.end);
      scheduleReparse(closed.value);
      return;
    }
    if (mediaTokenRegex.test(value) || closedFenceIn(value)) {
      scheduleReparse(value);
      return;
    }
    options.change(value, caret);
  };

  const commitFromDom = () => {
    if (writing || composing || !root.isConnected) {
      return;
    }
    let caret = currentCaret();
    if (!rowsClean(root)) {
      const plain = plainFromDom(root);
      writeAll(plain.text);
      place(plain.start, plain.end);
      caret = { start: plain.start, end: plain.end, focus: plain.end };
    } else {
      // shortcut: class and mark check on every row; window the rows if a few thousand lines hitch while typing.
      reveal(caret);
    }
    const value = readValue();
    paintEmpty(value);
    publish(value, caret);
  };

  const insertBreak = () => {
    const caret = currentCaret();
    const value = readValue();
    const next = `${value.slice(0, caret.start)}\n${value.slice(caret.end)}`;
    const at = caret.start + 1;
    writeAll(next);
    place(at, at);
    publish(next, { start: at, end: at });
  };

  const remember = () => {
    currentCaret();
    options.onCaret();
  };

  const showCaretLine = () => {
    if (writing || composing) {
      return;
    }
    reveal(currentCaret());
    options.onCaret();
  };

  root.addEventListener("focus", () => {
    const sel = root.ownerDocument.getSelection();
    const inside = Boolean(sel?.anchorNode && root.contains(sel.anchorNode));
    if (!inside) {
      place(saved.start, saved.end);
    } else {
      reveal(currentCaret());
    }
    remember();
  });
  root.addEventListener("focusout", () => {
    queueMicrotask(() => {
      if (!root.isConnected || writing) {
        return;
      }
      const active = root.ownerDocument.activeElement;
      if (active === root || (active instanceof Node && root.contains(active))) {
        return;
      }
      reveal(saved, false);
    });
  });
  root.addEventListener("keyup", showCaretLine);
  root.addEventListener("mouseup", showCaretLine);
  root.addEventListener("select", remember);
  root.addEventListener("compositionstart", () => {
    composing = true;
    options.undo(false);
  });
  root.addEventListener("compositionend", () => {
    composing = false;
    scheduleCommit();
  });
  root.addEventListener("beforeinput", (event) => {
    if (!root.isConnected || event.isComposing || composing) {
      return;
    }
    options.undo(false);
    if (
      event.inputType === "deleteContentBackward" ||
      event.inputType === "deleteContentForward" ||
      event.inputType === "deleteByCut"
    ) {
      const caret = currentCaret();
      const value = readValue();
      let from = caret.start;
      let to = caret.end;
      if (from === to && event.inputType === "deleteContentBackward" && from > 0 && value[from - 1] === "\n") {
        from -= 1;
      } else if (from === to && event.inputType === "deleteContentForward" && value[from] === "\n") {
        to += 1;
      }
      // Join in the string so a rendered checkbox row is not merged by the browser.
      if (from !== to && value.slice(from, to).includes("\n")) {
        event.preventDefault();
        options.undo(true);
        const next = value.slice(0, from) + value.slice(to);
        writeAll(next);
        place(from, from);
        publish(next, { start: from, end: from });
        return;
      }
    }
    const breaking = event.inputType === "insertParagraph" || event.inputType === "insertLineBreak";
    if (!breaking) {
      return;
    }
    if (skipBreak) {
      skipBreak = false;
      event.preventDefault();
      return;
    }
    event.preventDefault();
    insertBreak();
  });
  let paintFrame = 0;
  const scheduleCommit = () => {
    if (paintFrame) {
      return;
    }
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      commitFromDom();
    });
  };

  root.addEventListener("input", () => {
    if (writing || composing) {
      return;
    }
    scheduleCommit();
  });
  root.addEventListener("mousedown", (event) => {
    const box = event.target instanceof HTMLInputElement && event.target.classList.contains("md-check") ? event.target : null;
    if (!box) {
      return;
    }
    event.preventDefault();
    const row = box.closest(".md-row");
    if (!(row instanceof HTMLElement)) {
      return;
    }
    const rows = [...root.querySelectorAll<HTMLElement>(":scope > .md-row")];
    const index = rows.indexOf(row);
    if (index < 0) {
      return;
    }
    const lines = readValue().split("\n");
    const line = lines[index] ?? "";
    const nextLine = line.replace(/^(\s*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/, (_all, pre: string, mark: string) => {
      return `${pre}${mark === " " ? "[x]" : "[ ]"}`;
    });
    if (nextLine === line) {
      return;
    }
    lines[index] = nextLine;
    const next = lines.join("\n");
    const caret = currentCaret();
    options.undo(true);
    writeAll(next);
    place(caret.start, caret.end);
    publish(next, caret);
  });
  root.addEventListener("keydown", (event) => {
    if (!writing && !composing) {
      reveal(currentCaret());
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey || event.altKey)) {
      skipBreak = true;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && ["b", "i", "u"].includes(event.key.toLowerCase())) {
      event.preventDefault();
    }
    if (
      handleBlockMediaDeletion(options.container, field, event, options.blocks, options.removeMedia)
    ) {
      return;
    }
    if (handleBlockAreaNavigation(options.container, field, event)) {
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.isComposing &&
      root.classList.contains("inline-line-slot")
    ) {
      skipBreak = true;
      const value = readValue();
      const caret = currentCaret();
      if (value.length === 0) {
        event.preventDefault();
        options.releaseInline();
        return;
      }
      event.preventDefault();
      options.splitInline(value.slice(0, caret.start), value.slice(caret.end));
      return;
    }
    if (event.key === "Tab" && !event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing) {
      if (!options.allowTab()) {
        return;
      }
      event.preventDefault();
      const caret = currentCaret();
      options.apply(tabOnMarkdown(readValue(), caret.start, caret.end, event.shiftKey));
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.isComposing
    ) {
      return;
    }
    const caret = currentCaret();
    const edit = taskListOnEnter(readValue(), caret.start, caret.end);
    if (!edit) {
      return;
    }
    skipBreak = true;
    event.preventDefault();
    options.apply(edit);
  });
  root.addEventListener("keyup", () => {
    skipBreak = false;
  });

  writeAll(options.text);
  return { shell, field };
}

const MARK_NAMES = new Set(["md-strong", "md-em", "md-code", "md-link", "md-marker", "md-strike", "md-tag", "md-syntax"]);

function isTagSpan(node: Node): node is HTMLElement {
  if (!(node instanceof HTMLElement) || node.tagName !== "SPAN" || !node.classList.contains("md-tag")) {
    return false;
  }
  for (const name of node.classList) {
    if (!MARK_NAMES.has(name)) {
      return false;
    }
  }
  return node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").includes("\n");
}

function isMarkSpan(node: Node): node is HTMLElement {
  if (!(node instanceof HTMLElement) || node.tagName !== "SPAN" || node.classList.length === 0) {
    return false;
  }
  for (const name of node.classList) {
    if (!MARK_NAMES.has(name)) {
      return false;
    }
  }
  if ((node.textContent ?? "").includes("\n")) {
    return false;
  }
  if (node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE) {
    return true;
  }
  if (!node.classList.contains("md-strong") && !node.classList.contains("md-em")) {
    return false;
  }
  if (node.childNodes.length === 0) {
    return false;
  }
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      continue;
    }
    if (!isTagSpan(child)) {
      return false;
    }
  }
  return true;
}

function lineIndex(value: string, offset: number): number {
  let line = 0;
  const end = Math.max(0, Math.min(offset, value.length));
  for (let i = 0; i < end; i += 1) {
    if (value.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function paintSource(row: HTMLElement, text: string): boolean {
  if (text.length === 0) {
    if (row.childNodes.length === 1 && row.childNodes[0] instanceof HTMLBRElement) {
      return false;
    }
    row.replaceChildren(document.createElement("br"));
    return true;
  }
  const only = row.childNodes.length === 1 ? row.childNodes[0] : null;
  if (only?.nodeType === Node.TEXT_NODE && only.textContent === text) {
    return false;
  }
  row.replaceChildren(document.createTextNode(text));
  return true;
}

function paintChrome(row: HTMLElement, text: string) {
  const lead = /^\s*/.exec(text)?.[0].length ?? 0;
  const indented = row.classList.contains("is-ul") || row.classList.contains("is-task") || row.classList.contains("is-quote") || row.classList.contains("is-ol");
  if (indented) {
    row.style.setProperty("--lead", String(lead));
  } else {
    row.style.removeProperty("--lead");
  }
}

function samePart(node: Node, part: RenderPart): boolean {
  if (part.check) {
    return node instanceof HTMLInputElement && node.classList.contains("md-check") && node.checked === Boolean(part.checked);
  }
  if (part.children) {
    return (
      node instanceof HTMLElement &&
      node.className === (part.cls ?? "") &&
      node.childNodes.length === part.children.length &&
      part.children.every((child, index) => samePart(node.childNodes[index]!, child))
    );
  }
  if (part.syntax || part.cls) {
    return node instanceof HTMLElement && node.className === (part.syntax ? "md-syntax" : part.cls) && node.childNodes.length === 1 && node.textContent === part.text;
  }
  return node.nodeType === Node.TEXT_NODE && node.textContent === part.text;
}

function appendPart(parent: Node, part: RenderPart) {
  if (part.check) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "md-check";
    box.checked = Boolean(part.checked);
    box.tabIndex = -1;
    box.contentEditable = "false";
    parent.appendChild(box);
    return;
  }
  if (!part.syntax && !part.cls && !part.children) {
    parent.appendChild(document.createTextNode(part.text));
    return;
  }
  const span = document.createElement("span");
  span.className = part.syntax ? "md-syntax" : (part.cls ?? "");
  if (part.children) {
    for (const child of part.children) {
      appendPart(span, child);
    }
  } else {
    span.append(document.createTextNode(part.text));
  }
  parent.appendChild(span);
}

function paintMarks(row: HTMLElement, text: string): boolean {
  paintChrome(row, text);
  if (text.length === 0) {
    if (row.childNodes.length === 1 && row.childNodes[0] instanceof HTMLBRElement) {
      return false;
    }
    row.replaceChildren(document.createElement("br"));
    return true;
  }
  const only = row.childNodes.length === 1 ? row.childNodes[0] : null;
  if (
    row.className === "md-row" &&
    only?.nodeType === Node.TEXT_NODE &&
    only.textContent === text &&
    !/[*_`[!>#-]/.test(text) &&
    !/^\s*\d/.test(text)
  ) {
    return false;
  }
  const parts = renderParts(text);
  if (parts.length === row.childNodes.length && parts.every((part, index) => samePart(row.childNodes[index]!, part))) {
    return false;
  }
  const frag = document.createDocumentFragment();
  for (const part of parts) {
    appendPart(frag, part);
  }
  row.replaceChildren(frag);
  return true;
}

function columnInRow(row: HTMLElement, node: Node, nodeOffset: number): number | null {
  if (node !== row && !row.contains(node)) {
    return null;
  }
  if (node === row) {
    let acc = 0;
    const kids = [...row.childNodes];
    const index = Math.min(Math.max(0, nodeOffset), kids.length);
    for (let i = 0; i < index; i += 1) {
      acc += kids[i]?.textContent?.length ?? 0;
    }
    return acc;
  }
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      return acc + Math.min(Math.max(0, nodeOffset), current.textContent?.length ?? 0);
    }
    acc += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  if (node instanceof HTMLElement) {
    let before = 0;
    for (const child of row.childNodes) {
      if (child === node || child.contains(node)) {
        const len = node.textContent?.length ?? 0;
        const count = node.childNodes.length;
        if (nodeOffset <= 0) {
          return before;
        }
        if (nodeOffset >= count) {
          return before + len;
        }
        let inner = 0;
        for (let i = 0; i < nodeOffset; i += 1) {
          inner += node.childNodes[i]?.textContent?.length ?? 0;
        }
        return before + inner;
      }
      before += child.textContent?.length ?? 0;
    }
  }
  return null;
}

function pointInRow(row: HTMLElement, column: number): { node: Node; offset: number } {
  const text = row.textContent ?? "";
  if (text.length === 0) {
    return { node: row, offset: 0 };
  }
  const nodes: Node[] = [];
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }
  let left = Math.max(0, Math.min(column, text.length));
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    const len = node.textContent?.length ?? 0;
    if (left < len) {
      return { node, offset: left };
    }
    if (left === len) {
      const next = nodes[i + 1];
      if (next && syntaxText(node) && !syntaxText(next)) {
        return { node: next, offset: 0 };
      }
      return { node, offset: len };
    }
    left -= len;
  }
  const last = nodes[nodes.length - 1];
  if (last) {
    return { node: last, offset: last.textContent?.length ?? 0 };
  }
  return { node: row, offset: 0 };
}

function syntaxText(node: Node): boolean {
  return node.parentElement?.classList.contains("md-syntax") === true;
}

function isCleanRow(node: Node): node is HTMLElement {
  if (!(node instanceof HTMLElement) || !node.classList.contains("md-row")) {
    return false;
  }
  if ((node.textContent ?? "").includes("\n")) {
    return false;
  }
  if (node.childNodes.length === 0) {
    return true;
  }
  if (node.childNodes.length === 1 && node.childNodes[0] instanceof HTMLBRElement) {
    return (node.textContent ?? "") === "";
  }
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      continue;
    }
    if (child instanceof HTMLInputElement && child.classList.contains("md-check")) {
      continue;
    }
    if (!isMarkSpan(child)) {
      return false;
    }
  }
  return true;
}

function rowsClean(root: HTMLElement): boolean {
  if (root.childNodes.length === 0) {
    return false;
  }
  for (const node of root.childNodes) {
    if (!isCleanRow(node)) {
      return false;
    }
  }
  return true;
}

function plainFromDom(root: HTMLElement): { text: string; start: number; end: number } {
  const sel = root.ownerDocument.getSelection();
  const anchor = sel?.anchorNode && root.contains(sel.anchorNode) ? { node: sel.anchorNode, offset: sel.anchorOffset } : null;
  const focus = sel?.focusNode && root.contains(sel.focusNode) ? { node: sel.focusNode, offset: sel.focusOffset } : null;
  let text = "";
  let start: number | null = null;
  let end: number | null = null;
  const mark = (node: Node, offset: number) => {
    if (anchor?.node === node) {
      start = text.length + offset;
    }
    if (focus?.node === node) {
      end = text.length + offset;
    }
  };
  const add = (chunk: string, node: Node | null) => {
    if (node && node.nodeType === Node.TEXT_NODE) {
      mark(node, 0);
      const data = node.textContent ?? "";
      if (anchor?.node === node) {
        start = text.length + Math.min(anchor.offset, data.length);
      }
      if (focus?.node === node) {
        end = text.length + Math.min(focus.offset, data.length);
      }
      text += data;
      return;
    }
    text += chunk;
  };
  const walkChildren = (el: HTMLElement) => {
    const kids = [...el.childNodes];
    for (let i = 0; i < kids.length; i += 1) {
      if (anchor?.node === el && anchor.offset === i) {
        start = text.length;
      }
      if (focus?.node === el && focus.offset === i) {
        end = text.length;
      }
      const child = kids[i];
      if (child instanceof HTMLBRElement) {
        mark(child, 0);
        if (el.childNodes.length > 1) {
          text += "\n";
        }
        continue;
      }
      if (child instanceof HTMLElement && (child.tagName === "DIV" || child.tagName === "P")) {
        if (text.length > 0 && !text.endsWith("\n")) {
          text += "\n";
        }
        walkChildren(child);
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        add(child.textContent ?? "", child);
        continue;
      }
      if (child instanceof HTMLElement) {
        walkChildren(child);
      }
    }
    if (anchor?.node === el && anchor.offset >= kids.length) {
      start = text.length;
    }
    if (focus?.node === el && focus.offset >= kids.length) {
      end = text.length;
    }
  };
  const tops = [...root.childNodes];
  for (let i = 0; i < tops.length; i += 1) {
    if (anchor?.node === root && anchor.offset === i) {
      start = text.length;
    }
    if (focus?.node === root && focus.offset === i) {
      end = text.length;
    }
    const node = tops[i];
    if (i > 0 && (node instanceof HTMLElement || node instanceof HTMLBRElement) && !text.endsWith("\n")) {
      text += "\n";
    }
    if (node instanceof HTMLBRElement) {
      mark(node, 0);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      add(node.textContent ?? "", node);
      continue;
    }
    if (node instanceof HTMLElement) {
      walkChildren(node);
    }
  }
  if (text.endsWith("\n") && tops.length > 0) {
    const last = tops[tops.length - 1];
    const lastEmpty =
      last instanceof HTMLElement && (last.textContent ?? "") === "" && last.querySelector("br") != null;
    if (!lastEmpty) {
      text = text.replace(/\n$/, "");
      if (start != null) {
        start = Math.min(start, text.length);
      }
      if (end != null) {
        end = Math.min(end, text.length);
      }
    }
  }
  const a = start ?? text.length;
  const b = end ?? a;
  return { text, start: Math.min(a, b), end: Math.max(a, b) };
}

export function lineOffsetAtPoint(root: HTMLElement, clientX: number, clientY: number): number | null {
  let pos = 0;
  for (const row of root.querySelectorAll<HTMLElement>(":scope > .md-row")) {
    const rect = row.getBoundingClientRect();
    const text = row.textContent ?? "";
    if (clientY >= rect.top && clientY <= rect.bottom) {
      if (text.length === 0) {
        return clientX >= rect.left - 1 && clientX <= rect.left + 2 ? pos : null;
      }
      const range = root.ownerDocument.createRange();
      range.selectNodeContents(row);
      const box = range.getBoundingClientRect();
      const left = box.width > 0 ? box.left : rect.left;
      const right = box.width > 0 ? box.right : rect.left;
      if (clientX < left - 1 || clientX > right + 2) {
        return null;
      }
      const doc = root.ownerDocument as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
      };
      const caret = doc.caretRangeFromPoint?.(clientX, Math.min(box.bottom - 1, Math.max(box.top + 1, clientY)));
      if (caret && row.contains(caret.startContainer)) {
        const column = columnInRow(row, caret.startContainer, caret.startOffset);
        if (column != null) {
          return pos + column;
        }
      }
      const ratio = (clientX - left) / Math.max(1, right - left);
      return pos + Math.round(ratio * text.length);
    }
    pos += text.length + 1;
  }
  return null;
}
