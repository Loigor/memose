import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { defaultBinds, formatBind, isModifierKey, matchBind, modifierDown, type ShortcutBinds } from "./shortcuts";

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
};

type ThemeName = "light" | "dark";
type TextBlock = { kind: "text"; text: string };
type MediaBlock = { kind: "media"; name: string };
type Block = TextBlock | MediaBlock;

const card = document.querySelector<HTMLElement>("#card");
const blocks = document.querySelector<HTMLDivElement>("#blocks");
const preview = document.querySelector<HTMLDivElement>("#preview");
const notePane = document.querySelector<HTMLElement>("#note-pane");
const lightbox = document.querySelector<HTMLDivElement>("#lightbox");
const lightboxImage = document.querySelector<HTMLImageElement>("#lightbox-image");
const modeToggle = document.querySelector<HTMLButtonElement>("#mode-toggle");
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
const themeIcon = document.querySelector<SVGElement>("#theme-icon");
const colorPop = document.querySelector<HTMLDivElement>("#color-pop");
const hueSlider = document.querySelector<HTMLInputElement>("#hue-slider");
const hueAdd = document.querySelector<HTMLButtonElement>("#hue-add");
const pinToggle = document.querySelector<HTMLButtonElement>("#pin-toggle");
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
const modeToggleEl = requireEl(modeToggle, "mode toggle");
const themeToggleEl = requireEl(themeToggle, "theme toggle");
const themeIconEl = requireEl(themeIcon, "theme icon");
const colorPopEl = requireEl(colorPop, "color pop");
const hueSliderEl = requireEl(hueSlider, "hue slider");
const hueAddEl = requireEl(hueAdd, "save hue");
const hueSlots = [...document.querySelectorAll<HTMLButtonElement>(".hue-slot")];
const pinToggleEl = requireEl(pinToggle, "pin toggle");
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
  renderSurface(focusName);
}

function showStored(content: string) {
  showingPreview = false;
  noteContent = content;
  noteBlocks = parseBlocks(content);
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
      area.dataset.index = String(index);
      area.value = block.text;
      area.placeholder = noteBlocks.length === 1 ? "Write a note…" : "";
      if (index === lastText) {
        area.classList.add("grow");
      }
      area.addEventListener("input", () => {
        block.text = area.value;
        noteContent = serializeBlocks(noteBlocks);
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

function setEditedAt(ms: number | null) {
  if (ms == null || ms <= 0) {
    editedAtEl.hidden = true;
    editedAtEl.textContent = "";
    editedAtEl.removeAttribute("title");
    return;
  }
  editedAtEl.hidden = false;
  editedAtEl.textContent = relativeTime(ms);
  editedAtEl.title = exactStamp(ms);
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
    row.append(title, when, sync, pin);
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
  adoptLook(draft ? lookFromNote(draft) : defaultLook());
}

type Look = {
  opacity: number;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
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

let look: Look = { opacity: 100, hueLight: null, hueDark: null, swatches: [] };
let lookTimer: ReturnType<typeof setTimeout> | undefined;
let lookWrite: Promise<void> = Promise.resolve();
let lookUnsaved = false;
let opacityCarry = 100;

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function currentLookId(): string | null {
  if (pinnedNoteId) {
    return pinnedNoteId;
  }
  return editingId || draftId;
}

function defaultLook(): Look {
  return { opacity: 100, hueLight: null, hueDark: null, swatches: [] };
}

function lookFromNote(note: Note): Look {
  const swatches = Array.isArray(note.swatches) ? note.swatches : [];
  return {
    opacity: Math.min(100, Math.max(0, Math.round(note.opacity ?? 100))),
    hueLight: note.hueLight ?? null,
    hueDark: note.hueDark ?? null,
    swatches: swatches.filter((hue) => hue >= 0 && hue <= 359).slice(0, 6),
  };
}

function adoptLook(next: Look) {
  look = {
    opacity: next.opacity,
    hueLight: next.hueLight,
    hueDark: next.hueDark,
    swatches: [...next.swatches],
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

function paperAt(theme: ThemeName, hue: number): string {
  return theme === "dark" ? `hsl(${hue} 22% 16%)` : `hsl(${hue} 100% 86%)`;
}

function chipColor(): string {
  const theme = currentTheme();
  const hue = theme === "dark" ? look.hueDark : look.hueLight;
  if (hue == null) {
    return theme === "dark" ? "#23211f" : "#fff4b8";
  }
  return paperAt(theme, hue);
}

function palette(theme: ThemeName, hue: number): Record<string, string> {
  if (theme === "dark") {
    return {
      "--paper": paperAt(theme, hue),
      "--ink": `hsl(${hue} 28% 93%)`,
      "--muted": `hsl(${hue} 14% 70%)`,
      "--button": `hsl(${hue} 30% 93% / 0.12)`,
      "--button-hover": `hsl(${hue} 30% 93% / 0.2)`,
      "--line": `hsl(${hue} 30% 93% / 0.14)`,
      "--rule": `hsl(${hue} 18% 90% / 0.42)`,
      "--shadow": "hsl(0 0% 0% / 0.55)",
      "--field": "hsl(0 0% 100% / 0.06)",
      "--pin-on": `hsl(${hue} 40% 96%)`,
    };
  }
  return {
    "--paper": paperAt(theme, hue),
    "--ink": `hsl(${hue} 34% 18%)`,
    "--muted": `hsl(${hue} 32% 36%)`,
    "--button": `hsl(${hue} 50% 18% / 0.08)`,
    "--button-hover": `hsl(${hue} 50% 18% / 0.16)`,
    "--line": `hsl(${hue} 50% 18% / 0.12)`,
    "--rule": `hsl(${hue} 40% 24% / 0.38)`,
    "--shadow": `hsl(${hue} 70% 14% / 0.34)`,
    "--field": "hsl(0 0% 100% / 0.65)",
    "--pin-on": `hsl(${hue} 18% 14%)`,
  };
}

function paintThemeIcon() {
  const dark = currentTheme() === "dark";
  if (altHeld) {
    themeIconEl.innerHTML = `<circle cx="8" cy="8" r="5" fill="${chipColor()}" stroke="currentColor" stroke-width="1.2"/>`;
    themeToggleEl.setAttribute("aria-label", "Memo color");
    themeToggleEl.title = "Memo color";
    return;
  }
  themeToggleEl.setAttribute("aria-label", dark ? "Light theme" : "Dark theme");
  themeToggleEl.title = dark ? "Light theme" : "Dark theme";
  themeIconEl.innerHTML = dark
    ? `<circle cx="8" cy="8" r="2.4" fill="currentColor"/><path stroke="currentColor" stroke-width="1.3" d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3"/>`
    : `<path fill="currentColor" d="M8 1.6a6.2 6.2 0 1 0 5.6 8.7A4.7 4.7 0 0 1 8 1.6z"/>`;
}

function paintLook() {
  const theme = currentTheme();
  const hue = theme === "dark" ? look.hueDark : look.hueLight;
  const root = document.documentElement;
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
  document.documentElement.dataset.theme = theme;
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
    if (target instanceof Element && target.closest("#theme-toggle, #color-pop")) {
      return;
    }
    event.preventDefault();
    void getCurrentWindow().startDragging();
    return;
  }
  if (!(target instanceof Element)) {
    return;
  }
  if (target.closest("button, a, input, textarea, img, video, .media, label, #color-pop")) {
    return;
  }
  event.preventDefault();
  void getCurrentWindow().startDragging();
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
    if (!noteContent.trim()) {
      return;
    }
    const note = await invoke<Note>("publish_note", { id: editingId || null, content: noteContent });
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
  if (event.altKey || altHeld) {
    colorPopEl.hidden = !colorPopEl.hidden;
    if (!colorPopEl.hidden) {
      syncSlider();
    }
    return;
  }
  const next: ThemeName = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  if (!inTauri()) {
    return;
  }
  void invoke("set_theme", { theme: next }).catch((error: unknown) => {
    console.error(error);
  });
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

cardEl.addEventListener(
  "wheel",
  (event) => {
    if ((!gestureHeld && !modifierDown(binds.gesture, event)) || isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("#color-pop")) {
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
        }
        return;
      }
      if (event.key === "Alt") {
        return;
      }
      if (event.key === "Escape" && !colorPopEl.hidden) {
        colorPopEl.hidden = true;
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
    }
  });
  window.addEventListener("blur", () => {
    gestureHeld = false;
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
  }
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
}
