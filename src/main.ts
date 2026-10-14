import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { applyCode, applyTask, applyTitle, taskListOnEnter, toggleTask, wrapText, type Edit } from "./markdown-edit";
import { paintSurface, paintThemeButton, palette, paperAt, stackHeaderHtml, type ThemeName } from "./memo-chrome";
import { defaultBinds, formatBind, isModifierKey, matchBind, matchMouse, modifierDown, type ShortcutBinds } from "./shortcuts";

type Note = {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  syncState: string;
  remoteName: string | null;
  lastError: string | null;
  pinned: boolean;
  opacity: number;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  visibility?: string | null;
  space?: string | null;
  collapsed?: boolean;
  stackHost?: string | null;
  theme?: string | null;
};
type TextBlock = { kind: "text"; text: string };
type MediaBlock = { kind: "media"; name: string };
type Block = TextBlock | MediaBlock;

const card = document.querySelector<HTMLElement>("#card");
const blocks = document.querySelector<HTMLDivElement>("#blocks");
const preview = document.querySelector<HTMLDivElement>("#preview");
const notePane = document.querySelector<HTMLElement>("#note-pane");
const lightbox = document.querySelector<HTMLDivElement>("#lightbox");
const lightboxImage = document.querySelector<HTMLImageElement>("#lightbox-image");
const markdownToggle = document.querySelector<HTMLButtonElement>("#markdown-toggle");
const markdownPop = document.querySelector<HTMLDivElement>("#markdown-pop");
const modeToggle = document.querySelector<HTMLButtonElement>("#mode-toggle");
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
const themeIcon = document.querySelector<SVGElement>("#theme-icon");
const colorPop = document.querySelector<HTMLDivElement>("#color-pop");
const hueSlider = document.querySelector<HTMLInputElement>("#hue-slider");
const hueAdd = document.querySelector<HTMLButtonElement>("#hue-add");
const pinToggle = document.querySelector<HTMLButtonElement>("#pin-toggle");
const visibilityLabel = document.querySelector<HTMLButtonElement>("#visibility-label");
const audiencePop = document.querySelector<HTMLDivElement>("#audience-pop");
const visibilityChoices = document.querySelector<HTMLDivElement>("#visibility-choices");
const spaceBlock = document.querySelector<HTMLDivElement>("#space-block");
const spaceChoices = document.querySelector<HTMLDivElement>("#space-choices");
const editedSep = document.querySelector<HTMLElement>("#edited-sep");
const deleteConfirm = document.querySelector<HTMLDivElement>("#delete-confirm");
const deleteNote = document.querySelector<HTMLButtonElement>("#delete-note");
const deleteYes = document.querySelector<HTMLButtonElement>("#delete-yes");
const deleteNo = document.querySelector<HTMLButtonElement>("#delete-no");
const editedAt = document.querySelector<HTMLElement>("#edited-at");
const memoList = document.querySelector<HTMLElement>("#memo-list");
const recent = document.querySelector<HTMLUListElement>("#recent");
const recentSearch = document.querySelector<HTMLInputElement>("#recent-search");
const recentMore = document.querySelector<HTMLButtonElement>("#recent-more");
const conflict = document.querySelector<HTMLElement>("#conflict");
const conflictLocal = document.querySelector<HTMLButtonElement>("#conflict-local");
const conflictRemote = document.querySelector<HTMLButtonElement>("#conflict-remote");

const collapsedCount = 3;
const recentFetchLimit = 200;

let openGen = 0;
let recentExpanded = false;
let listHidden = false;
let memoQuery = "";
let editingId: string | null = null;
let binds: ShortcutBinds = defaultBinds();
let draftId: string | null = null;
let altHeld = false;
let gestureHeld = false;
let showingPreview = false;
let previewGen = 0;
const pinnedFromScript = (globalThis as { __memosePin?: unknown }).__memosePin;
const themeFromScript = (globalThis as { __memoseTheme?: unknown }).__memoseTheme;
const pinnedThemeHint: ThemeName | null =
  themeFromScript === "dark" || themeFromScript === "light" ? themeFromScript : null;
const pinnedNoteId =
  (typeof pinnedFromScript === "string" ? pinnedFromScript : "") ||
  new URLSearchParams(window.location.search).get("pin") ||
  document.documentElement.dataset.noteId ||
  "";
if (pinnedNoteId) {
  document.documentElement.dataset.noteId = pinnedNoteId;
  document.documentElement.classList.add("pin-window");
}
let noteContent = "";
let loadedContent = "";
let noteBlocks: Block[] = [{ kind: "text", text: "" }];
let draggingMedia: string | null = null;
let mediaDragged = false;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let caret: { index: number; start: number; end: number } | null = null;

marked.setOptions({ gfm: true, breaks: true });

function requireEl<T>(value: T | null, name: string): T {
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const cardEl = requireEl(card, "card");
const blocksEl = requireEl(blocks, "blocks");
const previewEl = requireEl(preview, "preview");
const notePaneEl = requireEl(notePane, "note pane");
const lightboxEl = requireEl(lightbox, "lightbox");
const lightboxImageEl = requireEl(lightboxImage, "lightbox image");
const markdownToggleEl = requireEl(markdownToggle, "markdown toggle");
const markdownPopEl = requireEl(markdownPop, "markdown pop");
const modeToggleEl = requireEl(modeToggle, "mode toggle");
const themeToggleEl = requireEl(themeToggle, "theme toggle");
const themeIconEl = requireEl(themeIcon, "theme icon");
const colorPopEl = requireEl(colorPop, "color pop");
const hueSliderEl = requireEl(hueSlider, "hue slider");
const hueAddEl = requireEl(hueAdd, "save hue");
const hueSlots = [...document.querySelectorAll<HTMLButtonElement>(".hue-slot")];
const pinToggleEl = requireEl(pinToggle, "pin toggle");
const visibilityLabelEl = requireEl(visibilityLabel, "visibility label");
const audiencePopEl = requireEl(audiencePop, "audience pop");
const visibilityChoicesEl = requireEl(visibilityChoices, "visibility choices");
const spaceBlockEl = requireEl(spaceBlock, "space block");
const spaceChoicesEl = requireEl(spaceChoices, "space choices");
const editedSepEl = requireEl(editedSep, "edited separator");
const deleteConfirmEl = requireEl(deleteConfirm, "delete confirm");
const deleteNoteEl = requireEl(deleteNote, "delete note");
const deleteYesEl = requireEl(deleteYes, "delete yes");
const deleteNoEl = requireEl(deleteNo, "delete no");
const editedAtEl = requireEl(editedAt, "edited at");
const memoListEl = requireEl(memoList, "memo list");
const recentEl = requireEl(recent, "recent");
const recentSearchEl = requireEl(recentSearch, "recent search");
const recentMoreEl = requireEl(recentMore, "recent more");
const conflictEl = requireEl(conflict, "conflict");
const conflictLocalEl = requireEl(conflictLocal, "keep local");
const conflictRemoteEl = requireEl(conflictRemote, "use server");
let conflictId: string | null = null;

const mediaPrefix = "memose-media/";
const mediaLine = /^!\[\]\(memose-media\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)\)$/;
const maxMediaBytes = 25 * 1024 * 1024;

function mediaMarkdown(name: string): string {
  return `![](${mediaPrefix}${name})`;
}

function ensureTextSlots(items: Block[]): Block[] {
  const next: Block[] = [];
  for (const block of items) {
    if (block.kind === "media" && (next.length === 0 || next[next.length - 1].kind === "media")) {
      next.push({ kind: "text", text: "" });
    }
    const previous = next[next.length - 1];
    if (block.kind === "text" && previous?.kind === "text") {
      previous.text = previous.text.length > 0 ? `${previous.text}\n${block.text}` : block.text;
      continue;
    }
    next.push(block.kind === "text" ? { kind: "text", text: block.text } : { kind: "media", name: block.name });
  }
  if (next.length === 0 || next[next.length - 1].kind === "media") {
    next.push({ kind: "text", text: "" });
  }
  if (next[0].kind === "media") {
    next.unshift({ kind: "text", text: "" });
  }
  return next;
}

function parseBlocks(content: string): Block[] {
  const next: Block[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    next.push({ kind: "text", text: buffer.join("\n") });
    buffer = [];
  };
  for (const line of content.split("\n")) {
    const match = line.trim().match(mediaLine);
    if (match?.[1]) {
      flush();
      next.push({ kind: "media", name: match[1] });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return ensureTextSlots(next);
}

function serializeBlocks(items: Block[]): string {
  return items
    .filter((block) => block.kind === "media" || block.text.length > 0)
    .map((block) => (block.kind === "media" ? mediaMarkdown(block.name) : block.text.replace(/\n+$/, "")))
    .join("\n");
}

function publishBlocks(focusName?: string) {
  noteBlocks = ensureTextSlots(noteBlocks);
  noteContent = serializeBlocks(noteBlocks);
  syncNoteTitle();
  renderSurface(focusName);
}

function showStored(content: string) {
  showingPreview = false;
  noteContent = content;
  noteBlocks = parseBlocks(content);
  syncNoteTitle();
  renderSurface();
}

function focusNote() {
  const areas = blocksEl.querySelectorAll("textarea");
  const area = areas.item(areas.length - 1);
  if (area instanceof HTMLTextAreaElement) {
    area.focus();
  }
}

function isVideo(name: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(name);
}

async function mediaSrc(name: string): Promise<string> {
  const path = await invoke<string>("media_path", { name });
  return convertFileSrc(path);
}

function previewShortcut(): string {
  return formatBind(binds.preview);
}

function renderSurface(focusName?: string) {
  const shortcut = previewShortcut();
  modeToggleEl.setAttribute("aria-pressed", String(showingPreview));
  if (showingPreview) {
    blocksEl.hidden = true;
    previewEl.hidden = false;
    modeToggleEl.textContent = "Edit";
    modeToggleEl.setAttribute("aria-label", "Edit");
    modeToggleEl.title = `Edit (${shortcut})`;
    void paintPreview();
    return;
  }
  previewEl.hidden = true;
  blocksEl.hidden = false;
  modeToggleEl.textContent = "Preview";
  modeToggleEl.setAttribute("aria-label", "Preview");
  modeToggleEl.title = `Preview (${shortcut})`;
  renderBlocks(focusName);
}

async function paintPreview() {
  const generation = ++previewGen;
  const parsed = marked.parse(noteContent, { async: false });
  const html = typeof parsed === "string" ? parsed : await parsed;
  if (generation !== previewGen) {
    return;
  }
  previewEl.innerHTML = DOMPurify.sanitize(html);
  for (const box of previewEl.querySelectorAll("input[type='checkbox']")) {
    if (box instanceof HTMLInputElement) {
      box.disabled = false;
    }
  }
  const images = [...previewEl.querySelectorAll("img")];
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src.startsWith(mediaPrefix)) {
        return;
      }
      const name = src.slice(mediaPrefix.length);
      try {
        const url = await mediaSrc(name);
        if (generation !== previewGen) {
          return;
        }
        if (isVideo(name)) {
          const video = document.createElement("video");
          video.controls = true;
          video.src = url;
          video.addEventListener("click", () => {
            void openPreview(name);
          });
          img.replaceWith(video);
          return;
        }
        img.src = url;
        img.addEventListener("click", () => {
          void openPreview(name);
        });
      } catch (error) {
        console.error(error);
      }
    }),
  );
}

previewEl.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    return;
  }
  const boxes = [...previewEl.querySelectorAll("input[type='checkbox']")];
  const index = boxes.indexOf(target);
  if (index < 0) {
    return;
  }
  const next = toggleTask(noteContent, index, target.checked);
  if (next == null || next === noteContent) {
    if (next == null) {
      target.checked = !target.checked;
    }
    return;
  }
  noteContent = next;
  noteBlocks = parseBlocks(next);
  scheduleDraft();
});

let previewClick: { at: number; x: number; y: number } | null = null;

function previewBodyTarget(target: EventTarget | null): target is Element {
  return target instanceof Element && Boolean(target.closest("#note-pane")) && !target.closest("a, input, img, video, button");
}

cardEl.addEventListener(
  "mousedown",
  (event) => {
    if (event.button !== 0 || gestureHeld || modifierDown(binds.gesture, event) || !previewBodyTarget(event.target)) {
      previewClick = null;
      return;
    }
    const now = event.timeStamp;
    const previous = previewClick;
    if (
      showingPreview &&
      previous &&
      now - previous.at < 600 &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 8
    ) {
      previewClick = null;
      event.preventDefault();
      event.stopPropagation();
      togglePreview();
      return;
    }
    previewClick = { at: now, x: event.clientX, y: event.clientY };
  },
  true,
);

function togglePreview() {
  showingPreview = !showingPreview;
  renderSurface();
  if (!showingPreview) {
    focusNote();
  }
}

function createMedia(name: string): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "media";
  figure.dataset.media = name;
  figure.draggable = true;
  const node: HTMLImageElement | HTMLVideoElement = isVideo(name)
    ? document.createElement("video")
    : document.createElement("img");
  if (node instanceof HTMLVideoElement) {
    node.controls = true;
  } else {
    node.alt = "";
  }
  node.draggable = false;
  void mediaSrc(name).then((src) => {
    node.src = src;
  });
  node.addEventListener("click", () => {
    if (mediaDragged) {
      mediaDragged = false;
      return;
    }
    void openPreview(name);
  });
  figure.addEventListener("dragstart", (event) => {
    draggingMedia = name;
    mediaDragged = true;
    event.dataTransfer?.setData("text/plain", name);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  });
  figure.addEventListener("dragend", () => {
    draggingMedia = null;
    blocksEl.querySelectorAll(".drag-over").forEach((node) => {
      node.classList.remove("drag-over");
    });
    window.setTimeout(() => {
      mediaDragged = false;
    }, 0);
  });
  figure.append(node);
  return figure;
}

function renderBlocks(focusName?: string) {
  const reuse = new Map<string, HTMLElement>();
  for (const node of blocksEl.querySelectorAll<HTMLElement>("[data-media]")) {
    const name = node.dataset.media;
    if (name) {
      reuse.set(name, node);
    }
  }
  blocksEl.replaceChildren();
  let lastText = -1;
  noteBlocks.forEach((block, index) => {
    if (block.kind === "text") {
      lastText = index;
    }
  });
  noteBlocks.forEach((block, index) => {
    if (block.kind === "text") {
      const area = document.createElement("textarea");
      area.spellcheck = false;
      area.autocomplete = "off";
      area.autocapitalize = "off";
      area.setAttribute("autocorrect", "off");
      area.setAttribute("writingsuggestions", "false");
      area.dataset.index = String(index);
      area.value = block.text;
      area.placeholder = noteBlocks.length === 1 ? "Write a note…" : "";
      if (index === lastText) {
        area.classList.add("grow");
      }
      const remember = () => {
        caret = { index, start: area.selectionStart, end: area.selectionEnd };
      };
      area.addEventListener("keyup", remember);
      area.addEventListener("mouseup", remember);
      area.addEventListener("select", remember);
      area.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
          return;
        }
        const edit = taskListOnEnter(area.value, area.selectionStart, area.selectionEnd);
        if (!edit) {
          return;
        }
        event.preventDefault();
        applyEdit(area, edit);
      });
      area.addEventListener("input", () => {
        block.text = area.value;
        noteContent = serializeBlocks(noteBlocks);
        remember();
        followEnd(area);
        dismissList();
        scheduleDraft();
      });
      blocksEl.append(area);
      return;
    }
    const figure = reuse.get(block.name) ?? createMedia(block.name);
    figure.dataset.index = String(index);
    blocksEl.append(figure);
  });
  if (!focusName) {
    return;
  }
  const media = blocksEl.querySelector(`[data-media="${CSS.escape(focusName)}"]`);
  const next = media?.nextElementSibling;
  if (next instanceof HTMLTextAreaElement) {
    next.focus();
  }
}

function moveMedia(name: string, to: number) {
  const from = noteBlocks.findIndex((block) => block.kind === "media" && block.name === name);
  if (from < 0) {
    return;
  }
  const clamped = Math.max(0, Math.min(to, noteBlocks.length));
  if (clamped === from || clamped === from + 1) {
    return;
  }
  const [block] = noteBlocks.splice(from, 1);
  const dest = clamped > from ? clamped - 1 : clamped;
  noteBlocks.splice(dest, 0, block);
  publishBlocks();
  scheduleDraft();
}

function insertMedia(name: string) {
  const area = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
  const index = area ? Number(area.dataset.index) : noteBlocks.length - 1;
  const block = noteBlocks[index];
  if (!block || block.kind !== "text") {
    noteBlocks.push({ kind: "media", name });
  } else {
    const start = area?.selectionStart ?? block.text.length;
    const end = area?.selectionEnd ?? start;
    const before = block.text.slice(0, start).replace(/\n+$/, "");
    const after = block.text.slice(end).replace(/^\n+/, "");
    noteBlocks.splice(
      index,
      1,
      { kind: "text", text: before },
      { kind: "media", name },
      { kind: "text", text: after },
    );
  }
  publishBlocks(name);
  scheduleDraft();
}

async function openPreview(name: string) {
  await invoke("open_media_preview", { name });
}

function applyEdit(area: HTMLTextAreaElement, edit: Edit) {
  const index = Number(area.dataset.index);
  const block = noteBlocks[index];
  if (!block || block.kind !== "text") {
    return;
  }
  area.value = edit.value;
  block.text = edit.value;
  noteContent = serializeBlocks(noteBlocks);
  const start = Math.min(edit.start, edit.value.length);
  const end = Math.min(edit.end, edit.value.length);
  area.focus();
  area.setSelectionRange(start, end);
  caret = { index, start, end };
  followEnd(area);
  dismissList();
  scheduleDraft();
}

function followEnd(area: HTMLTextAreaElement) {
  if (area.selectionStart !== area.value.length || area.selectionEnd !== area.value.length) {
    return;
  }
  const pin = () => {
    if (area.selectionEnd === area.value.length) {
      area.scrollTop = area.scrollHeight;
    }
  };
  pin();
  requestAnimationFrame(pin);
}

function areaSelection(area: HTMLTextAreaElement): { start: number; end: number } {
  if (document.activeElement === area) {
    return { start: area.selectionStart, end: area.selectionEnd };
  }
  if (caret && Number(area.dataset.index) === caret.index) {
    return {
      start: Math.min(caret.start, area.value.length),
      end: Math.min(caret.end, area.value.length),
    };
  }
  return { start: area.value.length, end: area.value.length };
}

function targetArea(): HTMLTextAreaElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && blocksEl.contains(active)) {
    return active;
  }
  if (caret) {
    const found = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${caret.index}"]`);
    if (found) {
      return found;
    }
  }
  const areas = blocksEl.querySelectorAll("textarea");
  const last = areas.item(areas.length - 1);
  return last instanceof HTMLTextAreaElement ? last : null;
}

function applyMarkdown(kind: string) {
  if (showingPreview) {
    showingPreview = false;
    renderSurface();
  }
  const area = targetArea();
  if (!area) {
    return;
  }
  const { start, end } = areaSelection(area);
  const value = area.value;
  const edit =
    kind === "bold"
      ? wrapText(value, start, end, "**", "**")
      : kind === "italic"
        ? wrapText(value, start, end, "*", "*")
        : kind === "title"
          ? applyTitle(value, start, end)
          : kind === "task"
            ? applyTask(value, start, end)
            : kind === "code"
              ? applyCode(value, start, end)
              : null;
  if (!edit) {
    return;
  }
  applyEdit(area, edit);
}

function closeMarkdownPop() {
  markdownPopEl.hidden = true;
  markdownToggleEl.setAttribute("aria-expanded", "false");
}

function insertSnippet(snippet: string) {
  const match = snippet.trim().match(mediaLine);
  if (!match?.[1]) {
    return;
  }
  insertMedia(match[1]);
}

async function attachFiles(files: File[]) {
  if (!inTauri()) {
    return;
  }
  for (const file of files) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      console.error("Only images and video can be attached");
      continue;
    }
    if (file.size > maxMediaBytes) {
      console.error("Media is larger than 25 MB");
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const markdown = await invoke<string>("save_media", { bytes });
      insertSnippet(markdown);
    } catch (error) {
      console.error(error);
    }
  }
}

function uniqueFiles(files: File[]): File[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  return [...data.files];
}

function noteTitle(content: string): string {
  const line = content
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith("![](memose-media/"));
  return (line ?? "Image").replace(/^#+\s*/, "");
}

function syncNoteTitle() {
  const title = document.querySelector("#note-title");
  if (title) {
    title.textContent = noteTitle(noteContent) || "Note";
  }
}

function scheduleDraft() {
  if (!inTauri()) {
    return;
  }
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    void persistDraft().catch((error: unknown) => {
      console.error(error);
    });
  }, 300);
}

async function persistDraft() {
  const noteId = editingId || pinnedNoteId || null;
  if (noteId) {
    await invoke("save_edit", { id: noteId, content: noteContent });
    setEditedAt(Date.now());
    if (lookUnsaved || lookTimer !== undefined) {
      await flushLook();
    }
    return;
  }
  const saved = await invoke<Note | null>("upsert_draft", { content: noteContent });
  if (!saved) {
    draftId = null;
    setEditedAt(null);
    return;
  }
  setEditedAt(saved.updatedAt);
  if (audienceDirty) {
    await saveNoteAudience(saved.id);
  }
  const idChanged = draftId !== saved.id;
  draftId = saved.id;
  if (idChanged || lookUnsaved || lookTimer !== undefined) {
    clearTimeout(lookTimer);
    lookTimer = undefined;
    lookUnsaved = false;
    await enqueueLook(saved.id);
  }
}

async function openRecent(item: Note) {
  if (editingId === item.id) {
    focusNote();
    return;
  }
  clearTimeout(draftTimer);
  const typed = noteContent;
  const savingNewMemo = editingId === null && typed.trim().length > 0;
  if (inTauri() && savingNewMemo) {
    await attachPendingLook();
    await invoke("commit_note", { content: typed });
  } else {
    await flushLook();
  }
  let opened = item;
  if (inTauri() && (item.syncState === "remote" || item.syncState === "conflict")) {
    try {
      opened = await invoke<Note>("get_note", { id: item.id });
    } catch (error) {
      console.error(error);
      return;
    }
  }
  editingId = opened.id;
  draftId = null;
  showStored(opened.content);
  adoptLook(lookFromNote(opened));
  setConflict(opened.syncState === "conflict" ? opened.id : null);
  setPinPressed(opened.pinned);
  setEditedAt(opened.updatedAt);
  paintAudience(opened);
  markSelectedNote();
  focusNote();
  if (savingNewMemo || opened.syncState !== item.syncState) {
    await refreshRecent();
  }
}

function relativeTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const date = new Date(ms);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= start) {
    return `today at ${time}`;
  }
  if (ms >= start - 86_400_000) {
    return `yesterday at ${time}`;
  }
  const days = Math.round((start - ms) / 86_400_000);
  if (days < 7) {
    return `${days} days ago`;
  }
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} at ${time}`;
}

function exactStamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function syncIcon(state: string): { svg: string; label: string } {
  if (state === "synced") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6.2 11.3 3.3 8.4l1.1-1.1 1.8 1.8 4.5-4.5 1.1 1.1z"/></svg>`,
      label: "Synced",
    };
  }
  if (state === "pending") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>`,
      label: "Waiting to sync",
    };
  }
  if (state === "conflict") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M7.2 3h1.6v6.2H7.2zM7.2 11h1.6V12.6H7.2z"/></svg>`,
      label: "Choose a version",
    };
  }
  if (state === "remote") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
      label: "On server",
    };
  }
  if (state === "error") {
    return {
      svg: `<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M7.2 3h1.6v6.2H7.2zM7.2 11h1.6V12.6H7.2z"/></svg>`,
      label: "Sync failed",
    };
  }
  return {
    svg: `<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
    label: "Local",
  };
}

function setConflict(id: string | null) {
  conflictId = id;
  conflictEl.hidden = id === null;
}

function setPinPressed(on: boolean) {
  pinToggleEl.setAttribute("aria-pressed", String(on));
}

type MemoSpace = { name: string; title: string };

let syncEnabled = false;
let defaultVisibility = "PRIVATE";
let defaultSpace = "";
let knownSpaces: MemoSpace[] = [];
let audienceDirty = false;
let audiencePainted = false;
let chosenVisibility = "PRIVATE";
let chosenSpace = "";

const visibilityOptions = [
  { value: "PRIVATE", label: "Private", short: "Private", hint: "Only you" },
  { value: "PROTECTED", label: "Signed-in users", short: "Signed-in", hint: "Anyone with an account" },
  { value: "PUBLIC", label: "Public", short: "Public", hint: "Anyone with the link" },
  { value: "SPACE", label: "Space members", short: "Space", hint: "People in one space" },
];

function visibilityShort(value: string, space: string): string {
  if (value === "SPACE") {
    return knownSpaces.find((item) => item.name === space)?.title || "Space";
  }
  return visibilityOptions.find((item) => item.value === value)?.short ?? "Private";
}

function refreshMetaSep() {
  editedSepEl.hidden = visibilityLabelEl.hidden || editedAtEl.hidden;
}

function audienceChoice(title: string, hint: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "audience-choice";
  button.setAttribute("aria-pressed", String(pressed));
  const copy = document.createElement("span");
  copy.className = "audience-choice-copy";
  const titleEl = document.createElement("span");
  titleEl.className = "audience-choice-title";
  titleEl.textContent = title;
  copy.append(titleEl);
  if (hint) {
    const hintEl = document.createElement("span");
    hintEl.className = "audience-choice-hint";
    hintEl.textContent = hint;
    copy.append(hintEl);
  }
  const mark = document.createElement("span");
  mark.className = "audience-check";
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.append(copy, mark);
  button.addEventListener("click", onClick);
  return button;
}

function paintAudienceMenu() {
  visibilityChoicesEl.replaceChildren();
  for (const option of visibilityOptions) {
    if (option.value === "SPACE" && knownSpaces.length === 0) {
      continue;
    }
    visibilityChoicesEl.append(
      audienceChoice(option.label, option.hint, chosenVisibility === option.value, () => {
        chooseVisibility(option.value);
      }),
    );
  }
  spaceChoicesEl.replaceChildren();
  spaceBlockEl.hidden = knownSpaces.length === 0;
  if (knownSpaces.length === 0) {
    return;
  }
  spaceChoicesEl.append(
    audienceChoice("Unassigned", "", chosenSpace === "", () => {
      chooseSpace("");
    }),
  );
  for (const space of knownSpaces) {
    spaceChoicesEl.append(
      audienceChoice(space.title, "", chosenSpace === space.name, () => {
        chooseSpace(space.name);
      }),
    );
  }
  if (!audiencePopEl.hidden) {
    revealPressedChoice(spaceChoicesEl);
  }
}

function revealPressedChoice(container: HTMLElement) {
  const selected = container.querySelector<HTMLElement>('[aria-pressed="true"]');
  if (!selected) {
    return;
  }
  const delta = selected.getBoundingClientRect().top - container.getBoundingClientRect().top;
  if (delta < 0) {
    container.scrollTop += delta;
  } else if (delta + selected.offsetHeight > container.clientHeight) {
    container.scrollTop += delta + selected.offsetHeight - container.clientHeight;
  }
}

function paintAudience(note: { visibility?: string | null; space?: string | null } | null) {
  audiencePainted = true;
  let visibility = note?.visibility || defaultVisibility || "PRIVATE";
  if (!visibilityOptions.some((option) => option.value === visibility)) {
    visibility = "PRIVATE";
  }
  if (visibility === "SPACE" && knownSpaces.length === 0 && !note?.visibility) {
    visibility = "PRIVATE";
  }
  chosenVisibility = visibility;
  chosenSpace = note?.space ?? (note?.visibility ? "" : defaultSpace);
  if (chosenSpace && !knownSpaces.some((space) => space.name === chosenSpace)) {
    chosenSpace = "";
  }
  visibilityLabelEl.hidden = !syncEnabled;
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace);
  paintAudienceMenu();
  refreshMetaSep();
  audienceDirty = false;
}

function chooseVisibility(value: string) {
  chosenVisibility = value;
  if (value === "SPACE" && chosenSpace === "" && knownSpaces[0]) {
    chosenSpace = knownSpaces[0].name;
  }
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace);
  paintAudienceMenu();
  persistAudience();
}

function chooseSpace(value: string) {
  chosenSpace = value;
  if (value === "" && chosenVisibility === "SPACE") {
    chosenVisibility = "PRIVATE";
  }
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace);
  paintAudienceMenu();
  persistAudience();
}

function persistAudience() {
  audienceDirty = true;
  const id = currentNoteId();
  if (!id) {
    return;
  }
  void saveNoteAudience(id).catch((error: unknown) => {
    console.error(error);
  });
}

async function loadAudience() {
  if (!inTauri()) {
    return;
  }
  try {
    const settings = await invoke<{ baseUrl: string; visibility: string; space: string }>("get_settings");
    syncEnabled = settings.baseUrl.trim() !== "";
    defaultVisibility = settings.visibility || "PRIVATE";
    defaultSpace = settings.space || "";
    knownSpaces = syncEnabled ? await invoke<MemoSpace[]>("list_memo_spaces") : [];
  } catch (error) {
    console.error(error);
    syncEnabled = false;
    knownSpaces = [];
  }
  if (!audiencePainted) {
    paintAudience(null);
    return;
  }
  visibilityLabelEl.hidden = !syncEnabled;
  visibilityLabelEl.textContent = visibilityShort(chosenVisibility, chosenSpace);
  paintAudienceMenu();
  refreshMetaSep();
}

async function saveNoteAudience(id: string) {
  audienceDirty = false;
  await invoke("set_note_audience", {
    id,
    visibility: chosenVisibility,
    space: chosenSpace,
  });
}

function setEditedAt(ms: number | null) {
  if (ms == null || ms <= 0) {
    editedAtEl.hidden = true;
    editedAtEl.textContent = "";
    editedAtEl.removeAttribute("title");
    refreshMetaSep();
    return;
  }
  editedAtEl.hidden = false;
  editedAtEl.textContent = relativeTime(ms);
  editedAtEl.title = exactStamp(ms);
  refreshMetaSep();
}

function clearMemoQuery() {
  memoQuery = "";
  recentSearchEl.value = "";
}

function showMemoSearch(on: boolean) {
  recentSearchEl.hidden = !on;
  if (!on) {
    clearMemoQuery();
  }
}

function dismissList() {
  if (pinnedNoteId || listHidden) {
    return;
  }
  recentExpanded = false;
  listHidden = true;
  memoListEl.hidden = true;
  recentEl.hidden = true;
  recentEl.classList.remove("expanded");
  showMemoSearch(false);
  recentMoreEl.hidden = false;
  recentMoreEl.textContent = "More";
  recentMoreEl.setAttribute("aria-expanded", "false");
  void refreshRecent().catch((error: unknown) => {
    console.error(error);
  });
}

let recentFlight: Promise<void> | null = null;
let recentAgain = false;
let recentTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRecent() {
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => {
    void refreshRecent();
  }, 200);
}

async function refreshRecent() {
  if (pinnedNoteId) {
    return;
  }
  if (recentFlight) {
    recentAgain = true;
    return recentFlight;
  }
  recentFlight = refreshRecentNow().finally(() => {
    recentFlight = null;
    if (recentAgain) {
      recentAgain = false;
      void refreshRecent();
    }
  });
  return recentFlight;
}

async function refreshRecentNow() {
  const notes = await invoke<Note[]>("list_recent", { limit: recentFetchLimit });
  if (notes.length === 0) {
    memoListEl.hidden = true;
    recentEl.replaceChildren();
    recentEl.hidden = true;
    showMemoSearch(false);
    recentMoreEl.hidden = true;
    return;
  }
  if (listHidden) {
    memoListEl.hidden = true;
    recentEl.replaceChildren();
    recentEl.hidden = true;
    recentEl.classList.remove("expanded");
    showMemoSearch(false);
    recentMoreEl.hidden = false;
    recentMoreEl.textContent = "More";
    recentMoreEl.setAttribute("aria-expanded", "false");
    return;
  }
  if (notes.length <= collapsedCount) {
    recentExpanded = false;
  }
  memoListEl.hidden = false;
  recentEl.hidden = false;
  showMemoSearch(recentExpanded);
  const visible = recentExpanded
    ? notes.filter((item) => item.content.toLowerCase().includes(memoQuery))
    : notes.slice(0, collapsedCount);
  recentEl.classList.toggle("expanded", recentExpanded);
  recentEl.replaceChildren();
  if (visible.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No matches";
    recentEl.append(empty);
  }
  for (const item of visible) {
    const row = document.createElement("li");
    row.dataset.id = item.id;
    if (item.id === editingId) {
      row.classList.add("selected");
    }
    const title = document.createElement("button");
    title.type = "button";
    title.className = "title";
    title.textContent = noteTitle(item.content);
    title.addEventListener("click", () => {
      void openRecent(item).catch((error: unknown) => {
        console.error(error);
      });
    });
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = relativeTime(item.updatedAt);
    when.title = exactStamp(item.updatedAt);
    const sync = document.createElement("span");
    sync.className = "sync";
    const icon = syncIcon(item.syncState);
    sync.innerHTML = icon.svg;
    sync.title = item.lastError ?? icon.label;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin icon-button";
    pin.innerHTML = pinToggleEl.innerHTML;
    pin.setAttribute("aria-label", item.pinned ? "Unpin" : "Pin");
    pin.setAttribute("aria-pressed", String(item.pinned));
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      void invoke("set_pinned", { id: item.id, pinned: !item.pinned, fromComposer: false })
        .then(() => refreshRecent())
        .catch((error: unknown) => {
          console.error(error);
        });
    });
    const label = document.createElement("div");
    label.className = "label";
    label.append(title, when);
    row.append(label, sync, pin);
    recentEl.append(row);
  }
  recentMoreEl.hidden = notes.length <= collapsedCount;
  recentMoreEl.textContent = recentExpanded ? "Less" : "More";
  recentMoreEl.setAttribute("aria-expanded", String(recentExpanded));
}

async function loadDraft() {
  await flushLook();
  const draft = await invoke<Note | null>("load_draft");
  draftId = draft?.id ?? null;
  showStored(draft?.content ?? "");
  editingId = null;
  setEditedAt(draft?.updatedAt ?? null);
  paintAudience(draft);
  adoptLook(draft ? lookFromNote(draft) : defaultLook());
}

type Look = {
  opacity: number;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  theme: ThemeName | null;
};

const lightHue = 48;
const darkHue = 32;
const tinted = [
  "--paper",
  "--ink",
  "--muted",
  "--button",
  "--button-hover",
  "--line",
  "--rule",
  "--shadow",
  "--field",
  "--pin-on",
];

let look: Look = { opacity: 100, hueLight: null, hueDark: null, swatches: [], theme: null };
let appTheme: ThemeName = "light";
let lookTimer: ReturnType<typeof setTimeout> | undefined;
let lookWrite: Promise<void> = Promise.resolve();
let lookUnsaved = false;
let opacityCarry = 100;

function currentTheme(): ThemeName {
  return look.theme ?? pinnedThemeHint ?? appTheme;
}

function namedTheme(value: string | null | undefined): ThemeName | null {
  if (value === "dark" || value === "light") {
    return value;
  }
  return null;
}

function currentLookId(): string | null {
  if (pinnedNoteId) {
    return pinnedNoteId;
  }
  return editingId || draftId;
}

function defaultLook(): Look {
  return { opacity: 100, hueLight: null, hueDark: null, swatches: [], theme: null };
}

function lookFromNote(note: Note): Look {
  const swatches = Array.isArray(note.swatches) ? note.swatches : [];
  return {
    opacity: Math.min(100, Math.max(0, Math.round(note.opacity ?? 100))),
    hueLight: note.hueLight ?? null,
    hueDark: note.hueDark ?? null,
    swatches: swatches.filter((hue) => hue >= 0 && hue <= 359).slice(0, 6),
    theme: namedTheme(note.theme),
  };
}

function adoptLook(next: Look) {
  look = {
    opacity: next.opacity,
    hueLight: next.hueLight,
    hueDark: next.hueDark,
    swatches: [...next.swatches],
    theme: next.theme,
  };
  opacityCarry = look.opacity;
  lookUnsaved = false;
  paintLook();
  syncSlider();
}

function themeHue(): number | null {
  return currentTheme() === "dark" ? look.hueDark : look.hueLight;
}

function activeHue(): number {
  return themeHue() ?? (currentTheme() === "dark" ? darkHue : lightHue);
}

function chipColor(): string {
  const theme = currentTheme();
  const hue = theme === "dark" ? look.hueDark : look.hueLight;
  if (hue == null) {
    return theme === "dark" ? "#25282c" : "#fff4b8";
  }
  return paperAt(theme, hue);
}

function paintThemeIcon() {
  paintThemeButton(themeToggleEl, themeIconEl, currentTheme(), altHeld || hostBarOnly(), chipColor());
  repaintStackColors();
}

function paintLook() {
  const theme = currentTheme();
  const hue = theme === "dark" ? look.hueDark : look.hueLight;
  paintSurface(cardEl, theme, hue, look.opacity);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.setProperty("--paper-alpha", `${look.opacity}%`);
  const colors = hue == null ? null : palette(theme, hue);
  for (const name of tinted) {
    if (colors) {
      root.style.setProperty(name, colors[name]);
    } else {
      root.style.removeProperty(name);
    }
  }
  if (altHeld) {
    paintThemeIcon();
  }
  repaintStackColors();
}

function paintSlots() {
  const theme = currentTheme();
  const current = themeHue();
  hueSlots.forEach((slot, index) => {
    const hue = look.swatches[index];
    if (hue == null) {
      slot.style.background = "";
      delete slot.dataset.hue;
      slot.setAttribute("aria-pressed", "false");
      return;
    }
    slot.dataset.hue = String(hue);
    slot.style.background = paperAt(theme, hue);
    slot.setAttribute("aria-pressed", String(hue === current));
  });
  const hue = Number(hueSliderEl.value);
  hueAddEl.disabled = look.swatches.length >= 6 || look.swatches.includes(hue);
}

function syncSlider() {
  const hue = activeHue();
  hueSliderEl.value = String(hue);
  hueSliderEl.style.setProperty("--thumb", paperAt(currentTheme(), hue));
  paintSlots();
}

function applyTheme(theme: ThemeName) {
  appTheme = theme;
  paintThemeIcon();
  paintLook();
  syncSlider();
}

function enqueueLook(id: string): Promise<void> {
  const payload = {
    id,
    opacity: look.opacity,
    hueLight: look.hueLight,
    hueDark: look.hueDark,
    swatches: [...look.swatches],
    theme: look.theme,
  };
  lookWrite = lookWrite
    .then(() => invoke("save_look", payload))
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error(error);
    });
  return lookWrite;
}

let pinnedOpacityTimer: ReturnType<typeof setTimeout> | undefined;

function showingPinned(): boolean {
  return pinnedNoteId !== "" || pinToggleEl.getAttribute("aria-pressed") === "true";
}

let pinnedOpacityFrame = 0;
let pinnedOpacityLive = 0;

function schedulePinnedOpacity(opacity: number) {
  pinnedOpacityLive = opacity;
  if (pinnedOpacityFrame === 0) {
    pinnedOpacityFrame = requestAnimationFrame(() => {
      pinnedOpacityFrame = 0;
      const value = pinnedOpacityLive;
      void invoke("set_pinned_opacity", { opacity: value, persist: false }).catch((error: unknown) => {
        console.error(error);
      });
    });
  }
  clearTimeout(pinnedOpacityTimer);
  pinnedOpacityTimer = setTimeout(() => {
    pinnedOpacityTimer = undefined;
    void invoke("set_pinned_opacity", { opacity: pinnedOpacityLive }).catch((error: unknown) => {
      console.error(error);
    });
  }, 160);
}

function scheduleLook() {
  clearTimeout(lookTimer);
  const id = currentLookId();
  if (!id || !inTauri()) {
    lookUnsaved = true;
    return;
  }
  lookUnsaved = false;
  lookTimer = setTimeout(() => {
    lookTimer = undefined;
    void enqueueLook(id);
  }, 80);
}

function flushLook(): Promise<void> {
  const pending = lookTimer !== undefined || lookUnsaved;
  clearTimeout(lookTimer);
  lookTimer = undefined;
  const id = currentLookId();
  if (!pending || !id || !inTauri()) {
    return Promise.resolve();
  }
  lookUnsaved = false;
  return enqueueLook(id);
}

async function attachPendingLook() {
  if (!pinnedNoteId && !editingId && (lookUnsaved || lookTimer !== undefined) && !draftId && noteContent.trim()) {
    const saved = await invoke<Note | null>("upsert_draft", { content: noteContent });
    if (saved) {
      draftId = saved.id;
    }
  }
  await flushLook();
}

function markSelectedNote() {
  for (const row of recentEl.querySelectorAll<HTMLElement>("li[data-id]")) {
    row.classList.toggle("selected", row.dataset.id === editingId);
  }
}

function randomHue() {
  const current = themeHue() ?? activeHue();
  let hue = Math.floor(Math.random() * 360);
  if (hue === current) {
    hue = (hue + 137) % 360;
  }
  setThemeHue(hue);
}

function setThemeHue(hue: number) {
  if (currentTheme() === "dark") {
    look.hueDark = hue;
  } else {
    look.hueLight = hue;
  }
  paintLook();
  syncSlider();
  scheduleLook();
}

async function loadTheme() {
  if (!inTauri()) {
    return;
  }
  const theme = await invoke<string>("get_theme");
  applyTheme(theme === "dark" ? "dark" : "light");
}

async function focusComposer(generation: number) {
  openGen = generation;
  setConflict(null);
  listHidden = false;
  await loadDraft();
  setPinPressed(false);
  await refreshRecent();
  focusNote();
}

async function cycleComposer(generation: number) {
  openGen = generation;
  if (editingId === null) {
    await openLastModified();
    return;
  }
  await returnToNewMemo(generation);
}

async function openLastModified() {
  clearTimeout(draftTimer);
  const notes = await invoke<Note[]>("list_recent", { limit: 1 });
  const latest = notes.find((note) => note.id !== draftId);
  if (!latest) {
    focusNote();
    return;
  }
  const typed = noteContent;
  if (typed.trim().length > 0) {
    await attachPendingLook();
    await invoke("commit_note", { content: typed });
    showStored("");
  }
  await openRecent(latest);
}

async function returnToNewMemo(generation: number) {
  openGen = generation;
  setConflict(null);
  listHidden = false;
  recentExpanded = false;
  clearTimeout(draftTimer);
  const noteId = editingId;
  if (noteId && noteContent.trim().length > 0) {
    await invoke("save_edit", { id: noteId, content: noteContent });
  }
  await flushLook();
  editingId = null;
  draftId = null;
  showStored("");
  adoptLook(defaultLook());
  setPinPressed(false);
  setEditedAt(null);
  paintAudience(null);
  await refreshRecent();
  focusNote();
}

async function startFresh(generation: number) {
  openGen = generation;
  setConflict(null);
  listHidden = false;
  recentExpanded = false;
  await attachPendingLook();
  if (noteContent.trim().length > 0 && !pinnedNoteId) {
    await invoke("commit_note", { content: noteContent });
  }
  editingId = null;
  draftId = null;
  showStored("");
  adoptLook(defaultLook());
  setPinPressed(false);
  setEditedAt(null);
  paintAudience(null);
  await refreshRecent();
  focusNote();
}

recentSearchEl.addEventListener("input", () => {
  memoQuery = recentSearchEl.value.trim().toLowerCase();
  void refreshRecent().catch((error: unknown) => {
    console.error(error);
  });
});

recentMoreEl.addEventListener("click", () => {
  if (listHidden) {
    listHidden = false;
  } else {
    recentExpanded = !recentExpanded;
  }
  void refreshRecent().catch((error: unknown) => {
    console.error(error);
  });
});

notePaneEl.addEventListener("mousedown", () => {
  dismissList();
});

cardEl.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
    return;
  }
  const target = event.target;
  if (gestureHeld || modifierDown(binds.gesture, event)) {
    if (target instanceof Element && target.closest("#theme-toggle, #color-pop, #audience-pop, #visibility-label, #markdown-toggle, #markdown-pop, #resize-grip")) {
      return;
    }
    startWindowDrag(event);
    return;
  }
  if (!(target instanceof Element)) {
    return;
  }
  if (dragBlocked(target)) {
    return;
  }
  startWindowDrag(event);
});

blocksEl.addEventListener("paste", (event) => {
  if (isPreviewWindow()) {
    return;
  }
  const files = filesFromTransfer(event.clipboardData);
  const items = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const media = uniqueFiles([...files, ...items]).filter(
    (file) => file.type.startsWith("image/") || file.type.startsWith("video/"),
  );
  if (media.length === 0) {
    return;
  }
  event.preventDefault();
  void attachFiles(media);
});

blocksEl.addEventListener("dragover", (event) => {
  if (!draggingMedia) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const row = event.target instanceof Element ? event.target.closest("[data-index]") : null;
  blocksEl.querySelectorAll(".drag-over").forEach((node) => {
    node.classList.remove("drag-over");
  });
  row?.classList.add("drag-over");
});

blocksEl.addEventListener("drop", (event) => {
  if (!draggingMedia) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  mediaDragged = true;
  const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-index]") : null;
  const index = row ? Number(row.dataset.index) : noteBlocks.length;
  const rect = row?.getBoundingClientRect();
  const after = rect ? event.clientY > rect.top + rect.height / 2 : true;
  const name = draggingMedia;
  draggingMedia = null;
  moveMedia(name, after ? index + 1 : index);
});

cardEl.addEventListener("dragover", (event) => {
  if (draggingMedia || ![...(event.dataTransfer?.types ?? [])].includes("Files")) {
    return;
  }
  event.preventDefault();
  cardEl.classList.add("dropping");
});

cardEl.addEventListener("dragleave", () => {
  cardEl.classList.remove("dropping");
});

cardEl.addEventListener("drop", (event) => {
  if (isPreviewWindow() || draggingMedia) {
    return;
  }
  event.preventDefault();
  cardEl.classList.remove("dropping");
  void attachFiles(filesFromTransfer(event.dataTransfer));
});

modeToggleEl.addEventListener("click", () => {
  togglePreview();
});

markdownToggleEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

markdownPopEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

markdownToggleEl.addEventListener("click", () => {
  const open = markdownPopEl.hidden;
  markdownPopEl.hidden = !open;
  markdownToggleEl.setAttribute("aria-expanded", String(open));
});

markdownPopEl.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button") : null;
  const kind = button?.dataset.markdown;
  if (!kind) {
    return;
  }
  applyMarkdown(kind);
});

document.addEventListener("mousedown", (event) => {
  if (markdownPopEl.hidden) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (markdownPopEl.contains(target) || markdownToggleEl.contains(target)) {
    return;
  }
  closeMarkdownPop();
});

function currentNoteId(): string | null {
  return pinnedNoteId || editingId || draftId;
}

function resetDeleteConfirm() {
  deleteNoteEl.hidden = false;
  deleteConfirmEl.hidden = true;
  deleteYesEl.textContent = "Delete";
}

function closeAudiencePop() {
  audiencePopEl.hidden = true;
  visibilityLabelEl.setAttribute("aria-expanded", "false");
  resetDeleteConfirm();
}

visibilityLabelEl.addEventListener("click", () => {
  if (audiencePopEl.hidden) {
    resetDeleteConfirm();
    audiencePopEl.hidden = false;
    visibilityLabelEl.setAttribute("aria-expanded", "true");
    revealPressedChoice(spaceChoicesEl);
    return;
  }
  closeAudiencePop();
});

deleteNoteEl.addEventListener("click", () => {
  if (!currentNoteId() && !noteContent.trim()) {
    return;
  }
  deleteNoteEl.hidden = true;
  deleteConfirmEl.hidden = false;
});

deleteNoEl.addEventListener("click", () => {
  resetDeleteConfirm();
});

deleteYesEl.addEventListener("click", () => {
  void (async () => {
    const id = currentNoteId();
    if (!id && !noteContent.trim()) {
      closeAudiencePop();
      return;
    }
    clearTimeout(draftTimer);
    deleteYesEl.textContent = "Deleting…";
    if (id && inTauri()) {
      await invoke("delete_note", { id });
    }
    closeAudiencePop();
    if (pinnedNoteId) {
      return;
    }
    editingId = null;
    draftId = null;
    showStored("");
    setPinPressed(false);
    setEditedAt(null);
    paintAudience(null);
    await refreshRecent();
  })().catch((error: unknown) => {
    deleteYesEl.textContent = "Could not delete";
    console.error(error);
  });
});

pinToggleEl.addEventListener("click", () => {
  void (async () => {
    const pressed = pinToggleEl.getAttribute("aria-pressed") === "true";
    const id = pinnedNoteId || editingId;
    if (pressed) {
      if (!id) {
        return;
      }
      await invoke("set_pinned", { id, pinned: false, fromComposer: false });
      setPinPressed(false);
      await refreshRecent();
      return;
    }
    const note = await invoke<Note>("publish_note", { id: editingId || draftId || null, content: noteContent });
    clearTimeout(lookTimer);
    lookTimer = undefined;
    lookUnsaved = false;
    await enqueueLook(note.id);
    await invoke("set_pinned", { id: note.id, pinned: true, fromComposer: !pinnedNoteId });
    if (!pinnedNoteId) {
      editingId = null;
      showStored("");
      setPinPressed(false);
      await invoke("hide_composer");
    } else {
      setPinPressed(true);
      setEditedAt(note.updatedAt);
    }
    await refreshRecent();
  })().catch((error: unknown) => {
    console.error(error);
  });
});

themeToggleEl.addEventListener("click", (event) => {
  if (event.altKey || altHeld || hostBarOnly()) {
    colorPopEl.hidden = !colorPopEl.hidden;
    if (!colorPopEl.hidden) {
      syncSlider();
    }
    return;
  }
  look.theme = currentTheme() === "dark" ? "light" : "dark";
  paintThemeIcon();
  paintLook();
  syncSlider();
  scheduleLook();
});

hueSliderEl.addEventListener("input", () => {
  setThemeHue(Number(hueSliderEl.value));
});

function pointIn(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function saveHue() {
  const hue = Number(hueSliderEl.value);
  if (look.swatches.includes(hue) || look.swatches.length >= 6) {
    return;
  }
  look.swatches.push(hue);
  setThemeHue(hue);
}

for (const slot of hueSlots) {
  slot.addEventListener("click", () => {
    const raw = slot.dataset.hue;
    if (raw == null || raw === "") {
      return;
    }
    setThemeHue(Number(raw));
  });
}

colorPopEl.addEventListener(
  "mousedown",
  (event) => {
    const slot = hueSlots.find((item) => pointIn(item.getBoundingClientRect(), event.clientX, event.clientY));
    const overAdd = pointIn(hueAddEl.getBoundingClientRect(), event.clientX, event.clientY);
    if (!slot && !overAdd) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (slot) {
      const raw = slot.dataset.hue;
      if (raw == null || raw === "") {
        return;
      }
      setThemeHue(Number(raw));
      return;
    }
    saveHue();
  },
  true,
);

hueAddEl.addEventListener("click", () => {
  saveHue();
});

document.addEventListener("mousedown", (event) => {
  if (colorPopEl.hidden) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (colorPopEl.contains(target) || themeToggleEl.contains(target)) {
    return;
  }
  colorPopEl.hidden = true;
});

document.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  for (const pop of document.querySelectorAll<HTMLElement>(".stack-note .color-pop, .stack-note .markdown-pop")) {
    if (pop.hidden || pop.contains(target)) {
      continue;
    }
    const anchor = pop.parentElement;
    if (anchor?.contains(target)) {
      continue;
    }
    pop.hidden = true;
  }
});

document.addEventListener("mousedown", (event) => {
  if (audiencePopEl.hidden) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (audiencePopEl.contains(target) || visibilityLabelEl.contains(target)) {
    return;
  }
  closeAudiencePop();
});

cardEl.addEventListener(
  "wheel",
  (event) => {
    if ((!gestureHeld && !modifierDown(binds.gesture, event)) || isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("#color-pop, #audience-pop, #markdown-pop")) {
      return;
    }
    event.preventDefault();
    const pixels =
      event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 120 : event.deltaY;
    if (pixels === 0) {
      return;
    }
    opacityCarry = Math.min(100, Math.max(0, opacityCarry - pixels * 0.1));
    const next = Math.round(opacityCarry);
    if (next === look.opacity) {
      return;
    }
    look.opacity = next;
    paintLook();
    if (event.metaKey) {
      schedulePinnedOpacity(next);
      if (!showingPinned()) {
        scheduleLook();
      }
      return;
    }
    scheduleLook();
  },
  { passive: false, capture: true },
);

function inTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

const NOTE_BAR = 52;
const WINDOW_BAR = 108;
const SECTION_OPEN = 420;
const frameEl = document.querySelector<HTMLElement>("#frame");
const stackEl = document.querySelector<HTMLElement>("#stack");

type StackState = {
  collapsed: boolean;
  hover: boolean;
  loaded: string;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  opacity: number;
  theme: ThemeName | null;
};

const stackState = new Map<string, StackState>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

let hostCollapsed = false;
let hostHover = false;
let hostWasOpen = true;
let pressTravel = 0;
let pressAt: { x: number; y: number } | null = null;
let openNoteHeight = SECTION_OPEN;
let stackGrow = 0;
let keepNoteHeight = false;
let savedHostHeight = 476;
let heightTween = 0;
let sizingWindow = false;
let chromeBar: boolean | null = null;

function hostBarOnly(): boolean {
  return hostCollapsed && !hostHover;
}

function hasStack(): boolean {
  return stackEl != null && stackEl.childElementCount > 0;
}

function anyNoteBar(): boolean {
  if (hasStack() && hostBarOnly()) {
    return true;
  }
  for (const state of stackState.values()) {
    if (state.collapsed && !state.hover) {
      return true;
    }
  }
  return false;
}

function applyOpenHeight() {
  document.documentElement.style.setProperty("--open-h", `${Math.round(openNoteHeight)}px`);
  document.documentElement.style.setProperty("--bar-h", `${NOTE_BAR}px`);
}

function rememberOpenSlice() {
  const box = frameEl?.clientHeight ?? 0;
  if (box < NOTE_BAR || sizingWindow) {
    return;
  }
  const count = 1 + (stackEl?.childElementCount ?? 0);
  if (anyNoteBar()) {
    return;
  }
  const slice = Math.max(160, Math.round(box / count));
  if (keepNoteHeight && slice + 32 < openNoteHeight) {
    return;
  }
  openNoteHeight = slice;
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    section.style.height = "";
  });
  document.documentElement.classList.add("fitting");
  applyOpenHeight();
  requestAnimationFrame(() => {
    document.documentElement.classList.remove("fitting");
  });
}

async function logicalHeight(): Promise<number> {
  const win = getCurrentWindow();
  const factor = await win.scaleFactor();
  const size = await win.innerSize();
  return Math.round(size.height / factor);
}

async function setLogicalHeight(height: number) {
  const win = getCurrentWindow();
  const factor = await win.scaleFactor();
  const size = await win.innerSize();
  const width = Math.max(220, Math.round(size.width / factor));
  sizingWindow = true;
  await win.setSize(new LogicalSize(width, Math.max(96, height)));
  window.setTimeout(() => {
    sizingWindow = false;
  }, 250);
}

function tweenWindowHeight(target: number) {
  cancelAnimationFrame(heightTween);
  void logicalHeight().then((from) => {
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 180);
      const eased = 1 - (1 - t) ** 3;
      void setLogicalHeight(Math.round(from + (target - from) * eased));
      if (t < 1) {
        heightTween = requestAnimationFrame(step);
      }
    };
    heightTween = requestAnimationFrame(step);
  });
}

function sectionTheme(state: StackState): ThemeName {
  return state.theme ?? currentTheme();
}

function sectionHue(state: StackState): number | null {
  const theme = sectionTheme(state);
  return theme === "dark" ? state.hueDark : state.hueLight;
}

function sectionChip(state: StackState): string {
  const theme = sectionTheme(state);
  const hue = sectionHue(state);
  if (hue == null) {
    return theme === "dark" ? "#25282c" : "#fff4b8";
  }
  return paperAt(theme, hue);
}

function paintSectionColor(section: HTMLElement, state: StackState) {
  const theme = sectionTheme(state);
  paintSurface(section, theme, sectionHue(state), state.opacity);
  const button = section.querySelector<HTMLElement>(".theme-toggle");
  const icon = section.querySelector(".theme-icon");
  if (button && icon) {
    paintThemeButton(button, icon, theme, altHeld || section.classList.contains("is-bar"), sectionChip(state));
  }
}

function repaintStackColors() {
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (state) {
      paintSectionColor(section, state);
    }
  });
}

function syncSection(section: HTMLElement, note: Note) {
  const state = stackState.get(note.id);
  if (!state) {
    return;
  }
  section.classList.toggle("is-bar", state.collapsed && !state.hover);
  const title = section.querySelector(".note-title");
  if (title) {
    title.textContent = noteTitle(note.content) || "Note";
  }
  const visibility = section.querySelector<HTMLElement>(".visibility-label");
  if (visibility) {
    visibility.hidden = false;
    visibility.textContent = visibilityShort(note.visibility || "PRIVATE", note.space || "");
  }
  const edited = section.querySelector<HTMLElement>(".edited-at");
  const sep = section.querySelector<HTMLElement>(".edited-sep");
  if (edited && sep) {
    if (note.updatedAt > 0) {
      edited.hidden = false;
      sep.hidden = false;
      edited.textContent = relativeTime(note.updatedAt);
      edited.title = exactStamp(note.updatedAt);
    } else {
      edited.hidden = true;
      sep.hidden = true;
    }
  }
  const body = section.querySelector("textarea");
  if (body && document.activeElement !== body && (body.value === state.loaded || body.value === note.content)) {
    body.value = note.content;
    state.loaded = note.content;
  }
  const hue = section.querySelector<HTMLInputElement>(".hue-slider");
  if (hue && document.activeElement !== hue) {
    hue.value = String(sectionHue(state) ?? 48);
  }
  paintSectionSlots(section, state);
  paintSectionColor(section, state);
}

type SectionLift = {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  started: boolean;
};

let sectionLift: SectionLift | null = null;

function beginSectionLift(section: HTMLElement, title: HTMLElement, event: PointerEvent) {
  const id = section.dataset.id;
  if (!id) {
    return;
  }
  sectionLift = {
    id,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    started: false,
  };
  title.setPointerCapture(event.pointerId);
}

function moveSectionLift(section: HTMLElement, title: HTMLElement, event: PointerEvent) {
  const lift = sectionLift;
  if (!lift || lift.started || event.pointerId !== lift.pointerId) {
    return;
  }
  const dx = event.clientX - lift.x;
  const dy = event.clientY - lift.y;
  if (dx * dx + dy * dy < 36) {
    return;
  }
  lift.started = true;
  title.dataset.moved = "1";
  const sources: HTMLElement[] = [section];
  let next = section.nextElementSibling;
  while (next instanceof HTMLElement && next.classList.contains("stack-note")) {
    sources.push(next);
    next = next.nextElementSibling;
  }
  for (const source of sources) {
    source.classList.add("lifting");
  }
  const first = section.getBoundingClientRect();
  const last = sources[sources.length - 1].getBoundingClientRect();
  const factor = window.devicePixelRatio || 1;
  const x = Math.round((event.screenX - (event.clientX - first.left) - 24) * factor);
  const y = Math.round((event.screenY - (event.clientY - first.top) - 24) * factor);
  const w = Math.round((first.width + 48) * factor);
  const h = Math.round((last.bottom - first.top + 56) * factor);
  const grabX = Math.round(event.screenX * factor) - x;
  const grabY = Math.round(event.screenY * factor) - y;
  const state = stackState.get(lift.id);
  void invoke("detach_stack", {
    guestId: lift.id,
    x,
    y,
    w,
    h,
    theme: state ? sectionTheme(state) : currentTheme(),
    grabX,
    grabY,
    pull: Math.round(64 * factor),
  }).catch((error: unknown) => {
    console.error(error);
    for (const source of sources) {
      source.classList.remove("lifting");
    }
  });
}

function endSectionLift(title: HTMLElement, event: PointerEvent, _commit: boolean) {
  const lift = sectionLift;
  if (!lift || event.pointerId !== lift.pointerId) {
    return;
  }
  sectionLift = null;
  if (title.hasPointerCapture(event.pointerId)) {
    title.releasePointerCapture(event.pointerId);
  }
}

function saveSectionLook(id: string, state: StackState) {
  void invoke("save_look", {
    id,
    opacity: state.opacity,
    hueLight: state.hueLight,
    hueDark: state.hueDark,
    swatches: state.swatches,
    theme: state.theme,
  }).catch((error: unknown) => {
    console.error(error);
  });
}

function setSectionHue(section: HTMLElement, state: StackState, hue: number) {
  if (sectionTheme(state) === "dark") {
    state.hueDark = hue;
  } else {
    state.hueLight = hue;
  }
  paintSectionColor(section, state);
  paintSectionSlots(section, state);
  const id = section.dataset.id;
  if (id) {
    saveSectionLook(id, state);
  }
}

function paintSectionSlots(section: HTMLElement, state: StackState) {
  const theme = sectionTheme(state);
  const current = sectionHue(state);
  const slots = [...section.querySelectorAll<HTMLButtonElement>(".hue-slot")];
  slots.forEach((slot, index) => {
    const hue = state.swatches[index];
    if (hue == null) {
      slot.style.background = "";
      delete slot.dataset.hue;
      slot.setAttribute("aria-pressed", "false");
      return;
    }
    slot.dataset.hue = String(hue);
    slot.style.background = paperAt(theme, hue);
    slot.setAttribute("aria-pressed", String(hue === current));
  });
  const add = section.querySelector<HTMLButtonElement>(".hue-add");
  const slider = section.querySelector<HTMLInputElement>(".hue-slider");
  if (add && slider) {
    const hue = Number(slider.value);
    add.disabled = state.swatches.length >= 6 || state.swatches.includes(hue);
    slider.style.setProperty("--thumb", paperAt(theme, current ?? hue));
  }
}

function buildSection(note: Note): HTMLElement {
  const section = document.createElement("section");
  section.className = "stack-note";
  section.dataset.id = note.id;
  section.innerHTML = `${stackHeaderHtml()}
    <textarea class="stack-body" spellcheck="false" writingsuggestions="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
    <div class="stack-preview" hidden></div>
  `;
  const field = section.querySelector<HTMLTextAreaElement>("textarea");
  if (field) {
    field.value = note.content;
  }
  const header = section.querySelector<HTMLElement>("header");
  let openedAtPress = true;
  if (!header) {
    return section;
  }
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (dragBlocked(target)) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    openedAtPress = !stackState.get(note.id)?.collapsed;
    if (gestureHeld || modifierDown(binds.gesture, event)) {
      header.dataset.moved = "0";
      beginSectionLift(section, header, event);
      return;
    }
    const pointerId = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;
    let held = false;
    header.setPointerCapture(pointerId);
    const timer = window.setTimeout(() => {
      held = true;
      header.classList.add("detach-hold");
      header.dataset.moved = "0";
      beginSectionLift(section, header, event);
    }, 420);
    const stopWait = () => {
      window.clearTimeout(timer);
      header.classList.remove("detach-hold");
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
      header.removeEventListener("pointercancel", onUp);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || held) {
        return;
      }
      const dx = ev.clientX - originX;
      const dy = ev.clientY - originY;
      if (dx * dx + dy * dy < 36) {
        return;
      }
      stopWait();
      if (header.hasPointerCapture(pointerId)) {
        header.releasePointerCapture(pointerId);
      }
      startWindowDrag(ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) {
        return;
      }
      stopWait();
    };
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
    header.addEventListener("pointercancel", onUp);
  });
  header.addEventListener("pointermove", (event) => {
    moveSectionLift(section, header, event);
  });
  header.addEventListener("pointerup", (event) => {
    endSectionLift(header, event, true);
  });
  header.addEventListener("pointercancel", (event) => {
    endSectionLift(header, event, false);
  });
  header.addEventListener("dblclick", () => {
    if (header.dataset.moved === "1" || !openedAtPress) {
      header.dataset.moved = "0";
      return;
    }
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (id && state && !state.collapsed) {
      void toggleSection(id);
    }
  });
  section.addEventListener("click", () => {
    const state = stackState.get(note.id);
    if (!state?.collapsed || pressTravel > 8 || header.dataset.moved === "1") {
      return;
    }
    state.collapsed = false;
    state.hover = false;
    section.classList.remove("is-bar");
    paintSectionColor(section, state);
    void invoke("set_collapsed", { id: note.id, collapsed: false }).catch((error: unknown) => {
      console.error(error);
    });
  });
  section.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest("header, button, input, textarea, .color-pop, .markdown-pop, #resize-grip")) {
      return;
    }
    startWindowDrag(event);
  });
  section.addEventListener("mouseenter", () => {
    syncCollapsedPeek();
  });
  section.addEventListener("mouseleave", () => {
    syncCollapsedPeek();
  });
  const body = section.querySelector<HTMLTextAreaElement>("textarea");
  body?.addEventListener("input", () => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!id || !state || !body) {
      return;
    }
    const titleEl = section.querySelector(".note-title");
    if (titleEl) {
      titleEl.textContent = noteTitle(body.value) || "Note";
    }
    const content = body.value;
    const pending = saveTimers.get(id);
    if (pending) {
      clearTimeout(pending);
    }
    saveTimers.set(
      id,
      setTimeout(() => {
        state.loaded = content;
        void invoke("save_edit", { id, content }).catch((error: unknown) => {
          console.error(error);
        });
      }, 300),
    );
  });
  const themeButton = section.querySelector<HTMLButtonElement>(".theme-toggle");
  const pop = section.querySelector<HTMLElement>(".color-pop");
  const hue = section.querySelector<HTMLInputElement>(".hue-slider");
  themeButton?.addEventListener("click", (event) => {
    const state = stackState.get(note.id);
    if (!state || !pop) {
      return;
    }
    if (event.altKey || altHeld || section.classList.contains("is-bar")) {
      pop.hidden = !pop.hidden;
      return;
    }
    state.theme = sectionTheme(state) === "dark" ? "light" : "dark";
    paintSectionColor(section, state);
    paintSectionSlots(section, state);
    saveSectionLook(note.id, state);
  });
  hue?.addEventListener("input", () => {
    const state = stackState.get(note.id);
    if (!state || !hue) {
      return;
    }
    setSectionHue(section, state, Number(hue.value));
  });
  section.querySelectorAll<HTMLButtonElement>(".hue-slot").forEach((slot) => {
    slot.addEventListener("click", () => {
      const state = stackState.get(note.id);
      const raw = slot.dataset.hue;
      if (!state || raw == null || raw === "") {
        return;
      }
      setSectionHue(section, state, Number(raw));
    });
  });
  section.querySelector<HTMLButtonElement>(".hue-add")?.addEventListener("click", () => {
    const state = stackState.get(note.id);
    if (!state || !hue || state.swatches.length >= 6) {
      return;
    }
    const value = Number(hue.value);
    if (state.swatches.includes(value)) {
      return;
    }
    state.swatches.push(value);
    setSectionHue(section, state, value);
  });
  const markdownPop = section.querySelector<HTMLElement>(".markdown-pop");
  const markdownToggle = section.querySelector<HTMLButtonElement>(".markdown-toggle");
  markdownToggle?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  markdownToggle?.addEventListener("click", () => {
    if (!markdownPop || !markdownToggle) {
      return;
    }
    markdownPop.hidden = !markdownPop.hidden;
    markdownToggle.setAttribute("aria-expanded", String(!markdownPop.hidden));
  });
  markdownPop?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const kind = button?.dataset.markdown;
    const field = section.querySelector("textarea");
    if (!kind || !(field instanceof HTMLTextAreaElement)) {
      return;
    }
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const value = field.value;
    const edit =
      kind === "bold"
        ? wrapText(value, start, end, "**", "**")
        : kind === "italic"
          ? wrapText(value, start, end, "*", "*")
          : kind === "title"
            ? applyTitle(value, start, end)
            : kind === "task"
              ? applyTask(value, start, end)
              : kind === "code"
                ? applyCode(value, start, end)
                : null;
    if (!edit) {
      return;
    }
    field.value = edit.value;
    field.setSelectionRange(edit.start, edit.end);
    field.dispatchEvent(new Event("input"));
    if (markdownPop) {
      markdownPop.hidden = true;
    }
  });
  const mode = section.querySelector<HTMLButtonElement>(".mode-toggle");
  const preview = section.querySelector<HTMLElement>(".stack-preview");
  mode?.addEventListener("click", () => {
    const field = section.querySelector("textarea");
    if (!mode || !preview || !(field instanceof HTMLTextAreaElement)) {
      return;
    }
    const open = preview.hidden;
    preview.hidden = !open;
    field.hidden = open;
    mode.textContent = open ? "Edit" : "Preview";
    mode.setAttribute("aria-pressed", String(open));
    if (open) {
      const parsed = marked.parse(field.value, { async: false });
      preview.innerHTML = DOMPurify.sanitize(parsed);
    }
  });
  section.querySelector<HTMLButtonElement>(".pin-toggle")?.addEventListener("click", () => {
    void invoke("set_pinned", { id: note.id, pinned: false, fromComposer: false }).catch((error: unknown) => {
      console.error(error);
    });
  });
  return section;
}

async function loadStack() {
  if (!stackEl) {
    return;
  }
  if (!pinnedNoteId || !inTauri()) {
    stackState.clear();
    stackEl.replaceChildren();
    frameEl?.classList.remove("has-stack");
    cardEl.classList.remove("stacked-host", "is-bar");
    return;
  }
  const notes = await invoke<Note[]>("stack_chain", { hostId: pinnedNoteId });
  const ids = new Set(notes.map((note) => note.id));
  for (const id of [...stackState.keys()]) {
    if (!ids.has(id)) {
      stackState.delete(id);
    }
  }
  for (const note of notes) {
    const prev = stackState.get(note.id);
    stackState.set(note.id, {
      collapsed: prev?.collapsed ?? Boolean(note.collapsed),
      hover: prev?.hover ?? false,
      loaded: prev?.loaded ?? note.content,
      hueLight: note.hueLight,
      hueDark: note.hueDark,
      swatches: [...note.swatches],
      opacity: note.opacity,
      theme: prev?.theme ?? namedTheme(note.theme),
    });
  }
  const existing = [...stackEl.children].map((node) => (node as HTMLElement).dataset.id);
  const previous = new Set(existing.filter((id): id is string => Boolean(id)));
  const nextIds = notes.map((note) => note.id);
  const same = existing.length === nextIds.length && existing.every((id, index) => id === nextIds[index]);
  if (!same) {
    const sections = notes.map((note) => buildSection(note));
    stackEl.replaceChildren(...sections);
    for (const section of sections) {
      const id = section.dataset.id || "";
      if (!previous.has(id) && !stackState.get(id)?.collapsed) {
        section.classList.add("joining");
      }
    }
    stackGrow = 0;
    frameEl?.classList.toggle("has-stack", notes.length > 0);
    cardEl.classList.toggle("stacked-host", notes.length > 0);
    applyOpenHeight();
    const openGuests = notes.filter((note) => !stackState.get(note.id)?.collapsed).length;
    const bars = (hostBarOnly() ? 1 : 0) + (notes.length - openGuests);
    const opens = (hostBarOnly() ? 0 : 1) + openGuests;
    const chrome = 56;
    const target = chrome + openNoteHeight * opens + NOTE_BAR * bars;
    keepNoteHeight = true;
    sizingWindow = true;
    const current = await logicalHeight();
    if (target > current + 24) {
      await setLogicalHeight(target);
    }
    window.setTimeout(() => {
      keepNoteHeight = false;
    }, 400);
  }
  notes.forEach((note, index) => {
    const section = stackEl.children[index];
    if (section instanceof HTMLElement) {
      syncSection(section, note);
    }
  });
  frameEl?.classList.toggle("has-stack", notes.length > 0);
  cardEl.classList.toggle("stacked-host", notes.length > 0);
  cardEl.classList.toggle("is-bar", notes.length > 0 && hostBarOnly());
  applyOpenHeight();
}

async function toggleSection(id: string) {
  const state = stackState.get(id);
  if (!state) {
    return;
  }
  state.collapsed = !state.collapsed;
  state.hover = false;
  const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${id}"]`);
  section?.classList.toggle("is-bar", state.collapsed);
  await invoke("set_collapsed", { id, collapsed: state.collapsed }).catch((error: unknown) => {
    console.error(error);
  });
}

function paintChrome() {
  document.documentElement.classList.toggle("collapsed", hostCollapsed);
  document.documentElement.classList.toggle("hover-open", hostCollapsed && hostHover);
  frameEl?.classList.toggle("has-stack", hasStack());
  cardEl.classList.toggle("is-bar", hasStack() && hostBarOnly());
  syncNoteTitle();
  paintThemeIcon();
  applyOpenHeight();
  if (!inTauri() || isPreviewWindow() || hasStack()) {
    return;
  }
  const bar = hostBarOnly();
  const first = chromeBar === null;
  if (chromeBar === bar) {
    return;
  }
  chromeBar = bar;
  if (first) {
    return;
  }
  tweenWindowHeight(bar ? WINDOW_BAR : savedHostHeight);
}

async function setHostCollapsed(collapsed: boolean) {
  if (hostCollapsed === collapsed) {
    return;
  }
  if (collapsed && !hasStack()) {
    savedHostHeight = await logicalHeight();
    rememberOpenSlice();
  }
  hostCollapsed = collapsed;
  hostHover = false;
  const id = pinnedNoteId || editingId;
  if (id && inTauri()) {
    await invoke("set_collapsed", { id, collapsed: hostCollapsed }).catch((error: unknown) => {
      console.error(error);
    });
  }
  paintChrome();
}

function syncCollapsedPeek() {
  const peek = gestureHeld;
  if (hostCollapsed) {
    const over = cardEl.matches(":hover");
    const next = peek && over;
    if (next !== hostHover) {
      hostHover = next;
      paintChrome();
    }
  } else if (hostHover) {
    hostHover = false;
    paintChrome();
  }
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!state?.collapsed) {
      return;
    }
    const next = peek && section.matches(":hover");
    if (next === state.hover) {
      return;
    }
    state.hover = next;
    section.classList.toggle("is-bar", !next);
  });
}

function dragBlocked(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, a, input, textarea, select, #resize-grip, #color-pop, #audience-pop, #markdown-pop, .color-pop, .markdown-pop",
      ),
    )
  );
}

function inResizeCorner(event: MouseEvent): boolean {
  return window.innerWidth - event.clientX <= 64 && window.innerHeight - event.clientY <= 72;
}

let resizing = false;

function startResize(event: MouseEvent) {
  if (resizing || !inTauri() || isPreviewWindow()) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  resizing = true;
  void invoke("begin_corner_resize", { label: getCurrentWindow().label })
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => {
      resizing = false;
    });
}

function startWindowDrag(event: MouseEvent) {
  if (!inTauri() || isPreviewWindow()) {
    return;
  }
  if (inResizeCorner(event)) {
    startResize(event);
    return;
  }
  event.preventDefault();
  void getCurrentWindow().startDragging();
  void invoke("begin_memo_drag", { label: getCurrentWindow().label });
}

function typingNote(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

function slideOut() {
  if (!inTauri() || isPreviewWindow() || resizing) {
    return;
  }
  void invoke("slide_into_view", { label: getCurrentWindow().label }).catch((error: unknown) => {
    console.error(error);
  });
}

function slideHome() {
  if (!inTauri() || isPreviewWindow() || resizing || typingNote()) {
    return;
  }
  void invoke("slide_back", { label: getCurrentWindow().label }).catch((error: unknown) => {
    console.error(error);
  });
}

function finishSnapDrag() {
  if (!inTauri()) {
    return;
  }
  void invoke("end_memo_drag", { label: getCurrentWindow().label });
}

function wireChrome() {
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || !inResizeCorner(event)) {
        return;
      }
      startResize(event);
    },
    true,
  );
  window.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0 || !inResizeCorner(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      startResize(event);
    },
    true,
  );

  const hostHeader = document.querySelector<HTMLElement>("#card header");
  hostHeader?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragBlocked(event.target)) {
      return;
    }
    hostWasOpen = !hostCollapsed;
    startWindowDrag(event);
  });
  const hostBrand = document.querySelector<HTMLElement>("#card .brand");
  hostBrand?.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button, input, #audience-pop, #color-pop")) {
      return;
    }
    if (!hostWasOpen) {
      return;
    }
    void setHostCollapsed(true);
  });

  cardEl.addEventListener("click", () => {
    if (!hostCollapsed || pressTravel > 8) {
      return;
    }
    void setHostCollapsed(false);
  });
  cardEl.addEventListener("mouseenter", () => {
    syncCollapsedPeek();
  });
  document.documentElement.addEventListener("mouseenter", slideOut);
  document.documentElement.addEventListener("mouseleave", slideHome);
  document.addEventListener("focusin", () => {
    if (typingNote()) {
      slideOut();
    }
  });
  document.addEventListener("focusout", () => {
    window.setTimeout(slideHome, 0);
  });
  cardEl.addEventListener("mouseleave", () => {
    syncCollapsedPeek();
  });

  window.addEventListener("pointerdown", (event) => {
    pressAt = { x: event.clientX, y: event.clientY };
    pressTravel = 0;
  });
  window.addEventListener("pointermove", (event) => {
    if (pressAt && event.buttons % 2 === 1) {
      const dx = event.clientX - pressAt.x;
      const dy = event.clientY - pressAt.y;
      pressTravel = Math.max(pressTravel, Math.hypot(dx, dy));
    }
    if (hostCollapsed || stackEl) {
      syncCollapsedPeek();
    }
  });
  window.addEventListener("pointerup", () => {
    finishSnapDrag();
  });
  window.addEventListener("pointercancel", () => {
    finishSnapDrag();
  });

  if (frameEl && typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (sizingWindow || anyNoteBar()) {
        return;
      }
      rememberOpenSlice();
    });
    observer.observe(frameEl);
  }

}

wireChrome();

function isPreviewWindow(): boolean {
  return inTauri() && getCurrentWindow().label === "media-preview";
}

async function showLightbox(name: string) {
  const src = await mediaSrc(name);
  const existing = lightboxEl.querySelector("video");
  if (isVideo(name)) {
    lightboxImageEl.hidden = true;
    const video = existing ?? document.createElement("video");
    video.controls = true;
    video.src = src;
    if (!existing) {
      lightboxEl.append(video);
    }
    return;
  }
  existing?.remove();
  lightboxImageEl.hidden = false;
  lightboxImageEl.src = src;
}

async function initLightbox() {
  document.documentElement.classList.add("lightbox-window");
  const current = await invoke<string | null>("current_media_preview");
  if (current) {
    await showLightbox(current);
  }
  await listen<string>("show-media", (event) => {
    void showLightbox(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });
  lightboxEl.addEventListener("click", (event) => {
    if (event.target === lightboxEl) {
      void invoke("close_media_preview");
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      void invoke("close_media_preview");
    }
  });
}

if (!isPreviewWindow()) {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Alt") {
        if (!event.repeat) {
          altHeld = true;
          paintThemeIcon();
        }
        event.preventDefault();
      }
      if (isModifierKey(binds.gesture, event.key)) {
        if (!event.repeat) {
          gestureHeld = true;
          syncCollapsedPeek();
        }
        return;
      }
      if (event.key === "Alt") {
        return;
      }
      if (event.key === "Escape" && (!colorPopEl.hidden || !audiencePopEl.hidden || !markdownPopEl.hidden)) {
        colorPopEl.hidden = true;
        closeAudiencePop();
        closeMarkdownPop();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (matchBind(event, binds.randomHue)) {
        event.preventDefault();
        randomHue();
        return;
      }
      if (matchBind(event, binds.preview)) {
        event.preventDefault();
        togglePreview();
        return;
      }
      if (!inTauri() || !matchBind(event, binds.hide)) {
        return;
      }
      event.preventDefault();
      void invoke("hide_memos").catch((error: unknown) => {
        console.error(error);
      });
    },
    true,
  );
  window.addEventListener("keyup", (event) => {
    if (event.key === "Alt") {
      altHeld = false;
      paintThemeIcon();
    }
    if (isModifierKey(binds.gesture, event.key)) {
      gestureHeld = false;
      syncCollapsedPeek();
    }
  });
  window.addEventListener("blur", () => {
    gestureHeld = false;
    syncCollapsedPeek();
    if (!altHeld) {
      return;
    }
    altHeld = false;
    paintThemeIcon();
  });
  if (inTauri()) {
    const applyBinds = (next: ShortcutBinds) => {
      binds = next;
      const shortcut = previewShortcut();
      modeToggleEl.title = showingPreview ? `Edit (${shortcut})` : `Preview (${shortcut})`;
    };
    void invoke<ShortcutBinds>("get_shortcuts")
      .then(applyBinds)
      .catch((error: unknown) => {
        console.error(error);
      });
    void listen<ShortcutBinds>("shortcuts-changed", (event) => {
      applyBinds(event.payload);
    });
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button < 1 || event.button === 2) {
          return;
        }
        const matched = [binds.newMemo, binds.togglePinned, binds.preview, binds.hide, binds.randomHue].some((binding) =>
          matchMouse(event, binding),
        );
        if (!matched) {
          return;
        }
        event.preventDefault();
        void invoke("mouse_chord", {
          button: event.button + 1,
          alt: event.altKey,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          meta: event.metaKey,
        }).catch((error: unknown) => {
          console.error(error);
        });
      },
      true,
    );
    void listen<{ button: number; alt: boolean; ctrl: boolean; shift: boolean; meta: boolean }>("mouse-chord", (event) => {
      const chord = {
        button: event.payload.button - 1,
        altKey: event.payload.alt,
        ctrlKey: event.payload.ctrl,
        shiftKey: event.payload.shift,
        metaKey: event.payload.meta,
      };
      if (matchMouse(chord, binds.randomHue)) {
        randomHue();
        return;
      }
      if (matchMouse(chord, binds.preview)) {
        togglePreview();
        return;
      }
      if (matchMouse(chord, binds.hide)) {
        void invoke("hide_memos").catch((error: unknown) => {
          console.error(error);
        });
      }
    });
  }
}

if (pinnedThemeHint) {
  look.theme = pinnedThemeHint;
  paintLook();
}

renderSurface();

let pinLoad = 0;

function applyPinned(note: Note) {
  const dirty = loadedContent.length > 0 && noteContent !== loadedContent;
  if (!dirty && (editingId !== note.id || loadedContent !== note.content)) {
    editingId = note.id;
    showStored(note.content);
    loadedContent = note.content;
  }
  setConflict(note.syncState === "conflict" ? note.id : null);
  setPinPressed(note.pinned);
  setEditedAt(note.updatedAt);
  hostCollapsed = Boolean(note.collapsed);
  paintAudience(note);
  void paintChrome();
  if (lookTimer === undefined) {
    adoptLook(lookFromNote(note));
  }
}

async function loadPinned(id: string) {
  if (id !== pinnedNoteId) {
    return;
  }
  const ticket = ++pinLoad;
  const stored = await invoke<Note>("get_note", { id: pinnedNoteId, materialize: false });
  if (ticket !== pinLoad || stored.id !== pinnedNoteId) {
    return;
  }
  applyPinned(stored);
  await loadStack();
  await loadTheme();
  if (stored.syncState !== "remote") {
    return;
  }
  const note = await invoke<Note>("get_note", { id: pinnedNoteId });
  if (ticket !== pinLoad || note.id !== pinnedNoteId) {
    return;
  }
  applyPinned(note);
}

conflictLocalEl.addEventListener("click", () => {
  if (!conflictId) {
    return;
  }
  void resolveConflict(conflictId, "local");
});

conflictRemoteEl.addEventListener("click", () => {
  if (!conflictId) {
    return;
  }
  void resolveConflict(conflictId, "remote");
});

async function resolveConflict(id: string, choice: "local" | "remote") {
  try {
    const note = await invoke<Note>("resolve_conflict", { id, choice });
    if (editingId === note.id || pinnedNoteId === note.id) {
      editingId = note.id;
      showStored(note.content);
      setConflict(null);
      setPinPressed(note.pinned);
      setEditedAt(note.updatedAt);
    }
    await refreshRecent();
  } catch (error) {
    console.error(error);
  }
}

if (inTauri() && !isPreviewWindow()) {
  void listen<number>("pinned-opacity", (event) => {
    if (pinnedOpacityTimer !== undefined || !showingPinned()) {
      return;
    }
    const next = Math.min(100, Math.max(0, Math.round(event.payload)));
    if (next === look.opacity) {
      return;
    }
    look.opacity = next;
    opacityCarry = next;
    paintLook();
  });
}

if (isPreviewWindow()) {
  void initLightbox().catch((error: unknown) => {
    console.error(error);
  });
} else if (pinnedNoteId && inTauri()) {
  void loadAudience().catch((error: unknown) => {
    console.error(error);
  });
  void loadPinned(pinnedNoteId).catch((error: unknown) => {
    console.error(error);
  });
  void getCurrentWindow().listen<string>("show-pin", (event) => {
    if (event.payload !== pinnedNoteId) {
      return;
    }
    void loadPinned(pinnedNoteId).catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen("notes-changed", () => {
    void loadPinned(pinnedNoteId).catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen("stack-changed", (event) => {
    const extra = typeof event.payload === "number" ? event.payload : 0;
    if (extra > 0) {
      stackGrow += extra;
    }
    void loadStack().catch((error: unknown) => {
      console.error(error);
    });
  });
  void listen<string>("stack-aim", (event) => {
    const notes = document.getElementById("notes");
    const mode = event.payload;
    notes?.classList.toggle("stack-aim", mode === "hold" || mode === "ready");
    notes?.classList.toggle("stack-ready", mode === "ready");
  });
} else if (inTauri()) {
  void listen<number>("composer-focus", (event) => {
    void focusComposer(event.payload);
  });

  void listen("notes-changed", () => {
    scheduleRecent();
  });

  void listen<number>("composer-fresh", (event) => {
    void startFresh(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen<number>("composer-cycle", (event) => {
    void cycleComposer(event.payload).catch((error: unknown) => {
      console.error(error);
    });
  });

  void listen<number>("composer-flush", (event) => {
    clearTimeout(draftTimer);
    const generation = event.payload;
    const content = noteContent;
    const noteId = editingId;
    recentExpanded = false;
    listHidden = false;
    if (generation === openGen) {
      showStored("");
      editingId = null;
      setPinPressed(false);
      setEditedAt(null);
    }
    void invoke("finalize_composer", { generation, content, noteId })
      .then(() => refreshRecent())
      .catch((error: unknown) => {
        console.error(error);
      });
  });

  void loadTheme().catch((error: unknown) => {
    console.error(error);
  });
  void loadAudience().catch((error: unknown) => {
    console.error(error);
  });
}
