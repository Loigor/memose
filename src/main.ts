import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DOMPurify from "dompurify";
import { marked } from "marked";

type Note = {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  syncState: string;
  remoteName: string | null;
  lastError: string | null;
  pinned: boolean;
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
const pinToggle = document.querySelector<HTMLButtonElement>("#pin-toggle");
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
let showingPreview = false;
let previewGen = 0;
const pinnedNoteId = document.documentElement.dataset.noteId ?? "";
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
const pinToggleEl = requireEl(pinToggle, "pin toggle");
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

function renderSurface(focusName?: string) {
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↩" : "Ctrl+Enter";
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
    const noteId = editingId || pinnedNoteId || null;
    const save = noteId
      ? invoke("save_edit", { id: noteId, content: noteContent })
      : invoke("upsert_draft", { content: noteContent });
    void save.catch((error: unknown) => {
      console.error(error);
    });
  }, 300);
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
    await invoke("commit_note", { content: typed });
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
  showStored(opened.content);
  setConflict(opened.syncState === "conflict" ? opened.id : null);
  setPinPressed(opened.pinned);
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
  const draft = await invoke<Note | null>("load_draft");
  showStored(draft?.content ?? "");
  editingId = null;
}

function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === "dark";
  themeToggleEl.setAttribute("aria-label", dark ? "Light theme" : "Dark theme");
  themeIconEl.innerHTML = dark
    ? `<circle cx="8" cy="8" r="2.4" fill="currentColor"/><path stroke="currentColor" stroke-width="1.3" d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3"/>`
    : `<path fill="currentColor" d="M8 1.6a6.2 6.2 0 1 0 5.6 8.7A4.7 4.7 0 0 1 8 1.6z"/>`;
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

async function startFresh(generation: number) {
  openGen = generation;
  setConflict(null);
  listHidden = false;
  recentExpanded = false;
  if (noteContent.trim().length > 0 && !pinnedNoteId) {
    await invoke("commit_note", { content: noteContent });
  }
  editingId = null;
  showStored("");
  setPinPressed(false);
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
  if (event.altKey) {
    event.preventDefault();
    void getCurrentWindow().startDragging();
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (target.closest("button, a, input, textarea, img, video, .media, label")) {
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
    await invoke("set_pinned", { id: note.id, pinned: true, fromComposer: !pinnedNoteId });
    if (!pinnedNoteId) {
      editingId = null;
      showStored("");
      setPinPressed(false);
      await invoke("hide_composer");
    } else {
      setPinPressed(true);
    }
    await refreshRecent();
  })().catch((error: unknown) => {
    console.error(error);
  });
});

themeToggleEl.addEventListener("click", () => {
  const next: ThemeName = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  if (!inTauri()) {
    return;
  }
  void invoke("set_theme", { theme: next }).catch((error: unknown) => {
    console.error(error);
  });
});

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
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        togglePreview();
        return;
      }
      if (!inTauri() || event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      void invoke("hide_memos").catch((error: unknown) => {
        console.error(error);
      });
    },
    true,
  );
}

renderSurface();

async function loadPinned(id: string) {
  const note = await invoke<Note>("get_note", { id });
  const dirty = loadedContent.length > 0 && noteContent !== loadedContent;
  if (!dirty && (editingId !== note.id || loadedContent !== note.content)) {
    editingId = note.id;
    showStored(note.content);
    loadedContent = note.content;
  }
  setConflict(note.syncState === "conflict" ? note.id : null);
  setPinPressed(note.pinned);
  await loadTheme();
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
    }
    await refreshRecent();
  } catch (error) {
    console.error(error);
  }
}

if (isPreviewWindow()) {
  void initLightbox().catch((error: unknown) => {
    console.error(error);
  });
} else if (pinnedNoteId && inTauri()) {
  void loadPinned(pinnedNoteId).catch((error: unknown) => {
    console.error(error);
  });
  void listen<string>("show-pin", (event) => {
    void loadPinned(event.payload).catch((error: unknown) => {
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
