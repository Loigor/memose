import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DOMPurify from "dompurify";
import { marked } from "marked";

import {
  applyCode,
  applyTask,
  applyTitle,
  displayFileName,
  ensureTextSlots,
  isAudio,
  isImage,
  isPreviewableMedia,
  isVideo,
  mediaPrefix,
  mediaTokenRegex,
  noteTitle,
  parseBlocks,
  parseMediaMeta,
  serializeBlocks,
  tabOnMarkdown,
  taskListOnEnter,
  toggleTask,
  wrapText,
  type Block,
  type Edit,
} from "./markdown-edit";
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

const card = document.querySelector<HTMLElement>("#card");
const blocks = document.querySelector<HTMLDivElement>("#blocks");
const preview = document.querySelector<HTMLDivElement>("#preview");
const notePane = document.querySelector<HTMLElement>("#note-pane");
const lightbox = document.querySelector<HTMLDivElement>("#lightbox");
const lightboxImage = document.querySelector<HTMLImageElement>("#lightbox-image");
const markdownToggle = document.querySelector<HTMLButtonElement>("#markdown-toggle");
const markdownPop = document.querySelector<HTMLDivElement>("#markdown-pop");
const editorMenuToggle = document.querySelector<HTMLButtonElement>("#editor-menu-toggle");
const editorTools = document.querySelector<HTMLDivElement>("#editor-tools");
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

type NoteHistoryEntry = {
  blocks: Block[];
  caret: { index: number; start: number; end: number } | null;
};

let hostUndoStack: NoteHistoryEntry[] = [];
let hostRedoStack: NoteHistoryEntry[] = [];
let hostLastInputSnapAt = 0;

function cloneBlocks(items: Block[]): Block[] {
  return items.map((b) =>
    b.kind === "text"
      ? { kind: "text", text: b.text }
      : {
          kind: "media",
          name: b.name,
          label: b.label,
          width: b.width,
          inline: b.inline,
        },
  );
}

function pushHostUndo(force = true) {
  const now = performance.now();
  if (!force && now - hostLastInputSnapAt < 900 && hostUndoStack.length > 0) {
    return;
  }
  const serialized = serializeBlocks(noteBlocks);
  const top = hostUndoStack[hostUndoStack.length - 1];
  if (top && serializeBlocks(top.blocks) === serialized) {
    top.caret = caret ? { ...caret } : null;
    return;
  }
  hostUndoStack.push({
    blocks: cloneBlocks(noteBlocks),
    caret: caret ? { ...caret } : null,
  });
  if (hostUndoStack.length > 60) {
    hostUndoStack.shift();
  }
  hostRedoStack = [];
  if (!force) {
    hostLastInputSnapAt = now;
  }
}

function resetHostHistory() {
  hostUndoStack = [];
  hostRedoStack = [];
  hostLastInputSnapAt = 0;
}

function undoHost(): boolean {
  if (hostUndoStack.length === 0) {
    return false;
  }
  const currentSerialized = serializeBlocks(noteBlocks);
  let entry = hostUndoStack.pop()!;
  while (hostUndoStack.length > 0 && serializeBlocks(entry.blocks) === currentSerialized) {
    entry = hostUndoStack.pop()!;
  }
  if (serializeBlocks(entry.blocks) === currentSerialized) {
    return false;
  }
  hostRedoStack.push({
    blocks: cloneBlocks(noteBlocks),
    caret: caret ? { ...caret } : null,
  });
  noteBlocks = cloneBlocks(entry.blocks);
  caret = entry.caret ? { ...entry.caret } : null;
  hostLastInputSnapAt = 0;
  publishBlocks();
  scheduleDraft();
  if (caret) {
    const area = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${caret.index}"]`);
    if (area) {
      area.focus();
      const s = Math.min(caret.start, area.value.length);
      const e = Math.min(caret.end, area.value.length);
      area.setSelectionRange(s, e);
    }
  }
  return true;
}

function redoHost(): boolean {
  if (hostRedoStack.length === 0) {
    return false;
  }
  const entry = hostRedoStack.pop()!;
  hostUndoStack.push({
    blocks: cloneBlocks(noteBlocks),
    caret: caret ? { ...caret } : null,
  });
  noteBlocks = cloneBlocks(entry.blocks);
  caret = entry.caret ? { ...entry.caret } : null;
  hostLastInputSnapAt = 0;
  publishBlocks();
  scheduleDraft();
  if (caret) {
    const area = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${caret.index}"]`);
    if (area) {
      area.focus();
      const s = Math.min(caret.start, area.value.length);
      const e = Math.min(caret.end, area.value.length);
      area.setSelectionRange(s, e);
    }
  }
  return true;
}

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
const editorMenuToggleEl = requireEl(editorMenuToggle, "editor menu toggle");
const editorToolsEl = requireEl(editorTools, "editor tools");
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

const maxMediaBytes = 32 * 1024 * 1024;

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
  resetHostHistory();
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

async function mediaSrc(name: string): Promise<string> {
  const path = await invoke<string>("media_path", { name });
  return convertFileSrc(path);
}

function revealInFolderLabel(): string {
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (platform.includes("mac")) {
    return "Show in Finder";
  }
  if (platform.includes("win")) {
    return "Show in Explorer";
  }
  return "Show in File Manager";
}

let mediaContextMenuEl: HTMLElement | null = null;

function closeMediaContextMenu() {
  if (mediaContextMenuEl) {
    mediaContextMenuEl.remove();
    mediaContextMenuEl = null;
  }
}

function showMediaContextMenu(event: MouseEvent, name: string, onRemove?: () => void) {
  if (!inTauri()) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closeMediaContextMenu();

  const menu = document.createElement("div");
  menu.id = "media-context-menu";
  menu.className = "media-context-menu";
  menu.setAttribute("role", "menu");

  const revealBtn = document.createElement("button");
  revealBtn.type = "button";
  revealBtn.setAttribute("role", "menuitem");
  revealBtn.textContent = revealInFolderLabel();
  revealBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeMediaContextMenu();
    void invoke("reveal_media", { name }).catch((error: unknown) => {
      console.error(error);
    });
  });
  menu.append(revealBtn);

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.setAttribute("role", "menuitem");
  openBtn.textContent = isImage(name) || isVideo(name) ? "Open Preview" : "Open File";
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeMediaContextMenu();
    if (isImage(name) || isVideo(name)) {
      void openPreview(name);
    } else {
      void invoke("open_media_file", { name }).catch((error: unknown) => {
        console.error(error);
      });
    }
  });
  menu.append(openBtn);

  if (onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger";
    removeBtn.setAttribute("role", "menuitem");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMediaContextMenu();
      onRemove();
    });
    menu.append(removeBtn);
  }

  document.body.append(menu);
  mediaContextMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, Math.min(event.clientX, maxX))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, maxY))}px`;
}

document.addEventListener("mousedown", (event) => {
  if (mediaContextMenuEl && event.target instanceof Node && !mediaContextMenuEl.contains(event.target)) {
    closeMediaContextMenu();
  }
});
window.addEventListener("blur", closeMediaContextMenu);
window.addEventListener("scroll", closeMediaContextMenu, true);

const videoPosterCache = new Map<string, string>();
const videoPosterPending = new Map<string, Promise<string | null>>();

function captureVideoPoster(src: string): Promise<string | null> {
  const cached = videoPosterCache.get(src);
  if (cached) {
    return Promise.resolve(cached);
  }
  const existing = videoPosterPending.get(src);
  if (existing) {
    return existing;
  }
  const promise = new Promise<string | null>((resolve) => {
    const probe = document.createElement("video");
    probe.muted = true;
    probe.playsInline = true;
    probe.preload = "metadata";
    probe.crossOrigin = "anonymous";
    let settled = false;
    const finish = (poster: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      videoPosterPending.delete(src);
      if (poster) {
        videoPosterCache.set(src, poster);
      }
      probe.removeAttribute("src");
      probe.load();
      resolve(poster);
    };
    const timer = window.setTimeout(() => finish(null), 3500);
    const drawFrame = () => {
      window.clearTimeout(timer);
      const vw = probe.videoWidth;
      const vh = probe.videoHeight;
      if (!vw || !vh) {
        finish(null);
        return;
      }
      const maxDim = 480;
      const scale = Math.min(1, maxDim / Math.max(vw, vh));
      const cw = Math.max(1, Math.round(vw * scale));
      const ch = Math.max(1, Math.round(vh * scale));
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        finish(null);
        return;
      }
      try {
        ctx.drawImage(probe, 0, 0, cw, ch);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
        finish(dataUrl);
      } catch {
        finish(null);
      }
    };
    probe.addEventListener(
      "loadeddata",
      () => {
        const dur = Number.isFinite(probe.duration) ? probe.duration : 0;
        if (dur > 0.15) {
          probe.currentTime = Math.min(0.1, dur / 4);
        } else {
          drawFrame();
        }
      },
      { once: true },
    );
    probe.addEventListener("seeked", drawFrame, { once: true });
    probe.addEventListener(
      "error",
      () => {
        window.clearTimeout(timer);
        finish(null);
      },
      { once: true },
    );
    probe.src = src;
  });
  videoPosterPending.set(src, promise);
  return promise;
}

function createVideoPreviewElement(name: string, label?: string, resolvedUrl?: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "media-video-wrap";

  const video = document.createElement("video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.draggable = false;

  const badge = document.createElement("div");
  badge.className = "media-video-badge";
  badge.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M4.5 3.5v9l8-4.5-8-4.5z"/></svg>`;
  const badgeText = document.createElement("span");
  badgeText.textContent = displayFileName(name, label);
  badge.append(badgeText);

  video.addEventListener("play", () => {
    wrap.classList.add("is-playing");
  });

  const applyUrl = (url: string) => {
    const cached = videoPosterCache.get(url);
    if (cached) {
      video.poster = cached;
    } else {
      void captureVideoPoster(url).then((poster) => {
        if (poster) {
          video.poster = poster;
        }
      });
    }
    video.src = `${url}#t=0.001`;
  };

  if (resolvedUrl) {
    applyUrl(resolvedUrl);
  } else {
    void mediaSrc(name).then(applyUrl);
  }

  wrap.append(video, badge);
  return wrap;
}

function createAudioElement(name: string, label: string | undefined, src?: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "media-audio";
  const header = document.createElement("div");
  header.className = "media-audio-header";
  header.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M11.5 1.5a.5.5 0 0 1 .5.5v9.25a2.25 2.25 0 1 1-1-1.87V4.28L6 5.53v6.72a2.25 2.25 0 1 1-1-1.87V3.5a.5.5 0 0 1 .38-.49l6-1.5a.5.5 0 0 1 .12-.01z"/></svg>`;
  const title = document.createElement("span");
  title.className = "media-audio-name";
  title.textContent = displayFileName(name, label);
  header.append(title);
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  if (src) {
    audio.src = src;
  } else {
    void mediaSrc(name).then((resolved) => {
      audio.src = resolved;
    });
  }
  wrap.append(header, audio);
  return wrap;
}

function createFileAttachmentChip(name: string, label?: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "file-attachment";
  link.href = "#";
  link.draggable = false;
  const shown = displayFileName(name, label);
  const extMatch = name.match(/\.([A-Za-z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toUpperCase() : "FILE";
  link.title = `${shown} (Click to open, right-click for ${revealInFolderLabel()})`;
  link.innerHTML = `<svg class="file-attachment-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3.5 1.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V5.414a1.5 1.5 0 0 0-.44-1.06L10.646 1.44A1.5 1.5 0 0 0 9.586 1H3.5zM3 3a.5.5 0 0 1 .5-.5H9v3a1 1 0 0 0 1 1h3v6.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V3zm7 .207L12.793 5.5H10V3.207z"/></svg><span class="file-attachment-name"></span><span class="file-attachment-ext"></span>`;
  const nameSpan = link.querySelector(".file-attachment-name");
  if (nameSpan) {
    nameSpan.textContent = shown;
  }
  const extSpan = link.querySelector(".file-attachment-ext");
  if (extSpan) {
    extSpan.textContent = ext;
  }
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (mediaDragged) {
      mediaDragged = false;
      return;
    }
    void invoke("open_media_file", { name }).catch((error: unknown) => {
      console.error(error);
    });
  });
  return link;
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
    modeToggleEl.setAttribute("aria-label", "Edit");
    modeToggleEl.title = `Edit (${shortcut})`;
    void paintPreview();
    return;
  }
  previewEl.hidden = true;
  blocksEl.hidden = false;
  modeToggleEl.setAttribute("aria-label", "Preview");
  modeToggleEl.title = `Preview (${shortcut})`;
  renderBlocks(focusName);
}

async function hydratePreviewContent(
  container: HTMLElement,
  isCurrent: () => boolean = () => true,
) {
  for (const box of container.querySelectorAll("input[type='checkbox']")) {
    if (box instanceof HTMLInputElement) {
      box.disabled = false;
    }
  }
  const images = [...container.querySelectorAll("img")];
  await Promise.all(
    images.map(async (img) => {
      const rawSrc = img.getAttribute("src") ?? "";
      if (!rawSrc.startsWith(mediaPrefix)) {
        return;
      }
      const rest = rawSrc.slice(mediaPrefix.length);
      const [name, frag] = rest.split("#");
      const meta = parseMediaMeta(img.getAttribute("alt") || undefined, frag);
      const label = meta.label;
      try {
        if (!isPreviewableMedia(name)) {
          const chip = createFileAttachmentChip(name, label);
          chip.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name);
          });
          img.replaceWith(chip);
          return;
        }
        const url = await mediaSrc(name);
        if (!isCurrent()) {
          return;
        }
        if (isVideo(name)) {
          const videoWrap = createVideoPreviewElement(name, label, url);
          if (meta.width) {
            videoWrap.style.width = `${meta.width}px`;
          }
          videoWrap.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name);
          });
          img.replaceWith(videoWrap);
          return;
        }
        if (isAudio(name)) {
          const audioWrap = createAudioElement(name, label, url);
          audioWrap.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name);
          });
          img.replaceWith(audioWrap);
          return;
        }
        img.src = url;
        img.alt = label ?? "";
        if (meta.width) {
          img.style.width = `${meta.width}px`;
          img.style.maxHeight = "none";
        }
        img.addEventListener("click", () => {
          void openPreview(name);
        });
        img.addEventListener("contextmenu", (event) => {
          showMediaContextMenu(event, name);
        });
      } catch (error) {
        console.error(error);
      }
    }),
  );

  const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
  await Promise.all(
    links.map(async (link) => {
      const rawHref = link.getAttribute("href") ?? "";
      if (!rawHref.startsWith(mediaPrefix)) {
        return;
      }
      const rest = rawHref.slice(mediaPrefix.length);
      const [name, frag] = rest.split("#");
      const meta = parseMediaMeta(link.textContent || undefined, frag);
      const label = meta.label;
      if (isImage(name)) {
        try {
          const url = await mediaSrc(name);
          if (!isCurrent()) {
            return;
          }
          const img = document.createElement("img");
          img.src = url;
          img.alt = label ?? "";
          if (meta.width) {
            img.style.width = `${meta.width}px`;
            img.style.maxHeight = "none";
          }
          img.addEventListener("click", () => {
            void openPreview(name);
          });
          img.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name);
          });
          link.replaceWith(img);
        } catch (error) {
          console.error(error);
        }
        return;
      }
      if (isVideo(name)) {
        try {
          const url = await mediaSrc(name);
          if (!isCurrent()) {
            return;
          }
          const videoWrap = createVideoPreviewElement(name, label, url);
          if (meta.width) {
            videoWrap.style.width = `${meta.width}px`;
          }
          videoWrap.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name);
          });
          link.replaceWith(videoWrap);
        } catch (error) {
          console.error(error);
        }
        return;
      }
      if (isAudio(name)) {
        try {
          const url = await mediaSrc(name);
          if (!isCurrent()) {
            return;
          }
          const audioWrap = createAudioElement(name, label, url);
          audioWrap.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name);
          });
          link.replaceWith(audioWrap);
        } catch (error) {
          console.error(error);
        }
        return;
      }
      const chip = createFileAttachmentChip(name, label);
      chip.addEventListener("contextmenu", (event) => {
        showMediaContextMenu(event, name);
      });
      link.replaceWith(chip);
    }),
  );
}

async function paintPreview() {
  const generation = ++previewGen;
  const parsed = marked.parse(noteContent, { async: false });
  const html = typeof parsed === "string" ? parsed : await parsed;
  if (generation !== previewGen) {
    return;
  }
  previewEl.innerHTML = DOMPurify.sanitize(html);
  await hydratePreviewContent(previewEl, () => generation === previewGen);
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
  pushHostUndo(true);
  noteContent = next;
  noteBlocks = parseBlocks(next);
  scheduleDraft();
});

let previewClick: { at: number; x: number; y: number } | null = null;

function previewBodyTarget(target: EventTarget | null): target is Element {
  return (
    target instanceof Element &&
    Boolean(target.closest("#note-pane")) &&
    !target.closest("a, input, img, video, audio, .media-audio, .file-attachment, button")
  );
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

function sizeBlockTextarea(area: HTMLTextAreaElement) {
  area.rows = 1;
  const isGrow = area.classList.contains("grow");
  const isInline = area.classList.contains("inline-line-slot");
  const isEmpty = area.value.length === 0;
  area.classList.toggle("empty-slot", isEmpty && !isGrow && !isInline);
  if (isEmpty && !isGrow && !isInline) {
    area.style.height = "";
    return;
  }
  area.style.height = "0px";
  const minH = isGrow ? 64 : 22;
  const needed = Math.max(minH, area.scrollHeight);
  area.style.height = `${needed}px`;
}

function resizeAllBlockTextareas(root: ParentNode = document) {
  for (const area of root.querySelectorAll<HTMLTextAreaElement>("#blocks textarea, .stack-blocks textarea")) {
    sizeBlockTextarea(area);
  }
}

type TextLineMetric = {
  text: string;
  startOffset: number;
  endOffset: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
};

function measureTextareaLines(area: HTMLTextAreaElement): TextLineMetric[] {
  const rect = area.getBoundingClientRect();
  if (area.value.length === 0) {
    const midY = rect.top + Math.min(6, rect.height / 2);
    return [
      {
        text: "",
        startOffset: 0,
        endOffset: 0,
        top: midY,
        bottom: midY,
        left: rect.left,
        right: rect.left,
      },
    ];
  }
  const lines = area.value.split("\n");
  const computed = window.getComputedStyle(area);
  const mirror = document.createElement("div");
  mirror.style.position = "fixed";
  mirror.style.left = "-9999px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${Math.max(40, area.clientWidth)}px`;
  mirror.style.padding = computed.padding;
  mirror.style.font = computed.font;
  mirror.style.fontSize = computed.fontSize;
  mirror.style.lineHeight = computed.lineHeight;
  mirror.style.letterSpacing = computed.letterSpacing;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflowWrap = "break-word";

  const lineNodes: { row: HTMLElement; span: HTMLElement; line: string; startOffset: number; endOffset: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    const row = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = line.length > 0 ? line : "\u200b";
    row.append(span);
    mirror.append(row);
    const startOffset = offset;
    const endOffset = offset + line.length;
    lineNodes.push({ row, span, line, startOffset, endOffset });
    offset = endOffset + 1;
  }
  document.body.append(mirror);
  const metrics: TextLineMetric[] = lineNodes.map(({ row, span, line, startOffset, endOffset }) => {
    const top = rect.top - area.scrollTop + row.offsetTop;
    const bottom = top + row.offsetHeight;
    const width = line.length > 0 ? span.offsetWidth : 0;
    return {
      text: line,
      startOffset,
      endOffset,
      top,
      bottom,
      left: rect.left,
      right: rect.left + width,
    };
  });
  mirror.remove();
  return metrics;
}

function estimateCharOffsetInLine(area: HTMLTextAreaElement, line: TextLineMetric, clientX: number): number {
  if (line.text.length === 0 || clientX <= line.left) {
    return line.startOffset;
  }
  if (clientX >= line.right) {
    return line.endOffset;
  }
  const computed = window.getComputedStyle(area);
  const probe = document.createElement("span");
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.font = computed.font;
  probe.style.fontSize = computed.fontSize;
  probe.style.letterSpacing = computed.letterSpacing;
  document.body.append(probe);
  const relX = clientX - line.left;
  let bestIdx = 0;
  let bestDist = relX;
  for (let i = 1; i <= line.text.length; i += 1) {
    probe.textContent = line.text.slice(0, i);
    const w = probe.offsetWidth;
    const dist = Math.abs(relX - w);
    if (dist <= bestDist) {
      bestDist = dist;
      bestIdx = i;
    } else {
      break;
    }
  }
  probe.remove();
  return line.startOffset + bestIdx;
}

type MediaDropTarget =
  | {
      mode: "line";
      blockIndex: number;
      lineIndex: number;
      y: number;
    }
  | {
      mode: "inline";
      blockIndex: number;
      charOffset: number;
      x: number;
      top: number;
      height: number;
    };

function findMediaDropTarget(
  container: HTMLElement,
  figure: HTMLElement,
  fromIndex: number,
  clientX: number,
  clientY: number,
): MediaDropTarget | null {
  const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea[data-index]")];
  for (const area of areas) {
    const aRect = area.getBoundingClientRect();
    if (
      area.value.length > 0 &&
      clientY >= aRect.top + 2 &&
      clientY <= aRect.bottom - 2 &&
      clientX >= aRect.left &&
      clientX <= aRect.right
    ) {
      const blockIndex = Number(area.dataset.index);
      const lines = measureTextareaLines(area);
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
        const lm = lines[lineIdx];
        const lineHeight = Math.max(16, lm.bottom - lm.top);
        const distTop = clientY - lm.top;
        const distBottom = lm.bottom - clientY;
        const inMiddleBand = distTop >= 5 && distBottom >= 5;
        if (inMiddleBand && lm.text.length > 0) {
          const charOffset = estimateCharOffsetInLine(area, lm, clientX);
          let caretX = lm.left;
          if (charOffset > lm.startOffset) {
            const ratio = (charOffset - lm.startOffset) / Math.max(1, lm.text.length);
            caretX = Math.min(aRect.right - 4, lm.left + (lm.right - lm.left) * ratio);
          }
          return {
            mode: "inline",
            blockIndex,
            charOffset,
            x: Math.max(aRect.left + 2, Math.min(aRect.right - 2, clientX < lm.right + 16 ? clientX : caretX)),
            top: lm.top + 2,
            height: lineHeight - 4,
          };
        }
      }
    }
  }

  const candidates: Extract<MediaDropTarget, { mode: "line" }>[] = [];
  for (const area of areas) {
    const blockIndex = Number(area.dataset.index);
    const lines = measureTextareaLines(area);
    const boundaries =
      area.value.length === 0
        ? [lines[0].top]
        : [lines[0].top, ...lines.map((l) => l.bottom)];
    const maxLineIndex = boundaries.length - 1;
    boundaries.forEach((y, lineIndex) => {
      if (blockIndex === fromIndex - 1 && lineIndex === maxLineIndex) {
        return;
      }
      if (blockIndex === fromIndex + 1 && lineIndex === 0) {
        return;
      }
      candidates.push({ mode: "line", blockIndex, lineIndex, y });
    });
  }
  if (candidates.length === 0) {
    return null;
  }
  let best = candidates[0];
  let bestDist = Math.abs(clientY - best.y);
  for (let i = 1; i < candidates.length; i += 1) {
    const d = Math.abs(clientY - candidates[i].y);
    if (d < bestDist) {
      best = candidates[i];
      bestDist = d;
    }
  }
  const figRect = figure.getBoundingClientRect();
  const figCenter = (figRect.top + figRect.bottom) / 2;
  if (clientY >= figRect.top + 6 && clientY <= figRect.bottom - 6 && Math.abs(clientY - figCenter) < bestDist) {
    return null;
  }
  return best;
}

function moveBlockMedia(
  items: Block[],
  fromIndex: number,
  target: MediaDropTarget,
): Block[] {
  const moved = items[fromIndex];
  if (!moved || moved.kind !== "media") {
    return items;
  }
  const next: Block[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (i === fromIndex) {
      continue;
    }
    const block = items[i];
    if (i === target.blockIndex && block.kind === "text") {
      if (target.mode === "inline") {
        const offset = Math.max(0, Math.min(block.text.length, target.charOffset));
        const before = block.text.slice(0, offset);
        const after = block.text.slice(offset);
        if (before.length > 0) {
          next.push({ kind: "text", text: before });
        }
        next.push({
          kind: "media",
          name: moved.name,
          label: moved.label,
          width: moved.width,
          inline: true,
        });
        if (after.length > 0) {
          next.push({ kind: "text", text: after });
        }
      } else if (block.text.length === 0) {
        next.push({
          kind: "media",
          name: moved.name,
          label: moved.label,
          width: moved.width,
          inline: false,
        });
      } else {
        const lines = block.text.split("\n");
        const k = Math.max(0, Math.min(lines.length, target.lineIndex));
        const before = lines.slice(0, k).join("\n");
        const after = lines.slice(k).join("\n");
        if (k > 0) {
          next.push({ kind: "text", text: before });
        }
        next.push({
          kind: "media",
          name: moved.name,
          label: moved.label,
          width: moved.width,
          inline: false,
        });
        if (k < lines.length) {
          next.push({ kind: "text", text: after });
        }
      }
      continue;
    }
    if (block.kind === "text") {
      if (block.text.length > 0) {
        next.push({ kind: "text", text: block.text });
      }
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
  return ensureTextSlots(next);
}

type MediaDragSession = {
  figure: HTMLElement;
  container: HTMLElement;
  section: HTMLElement | null;
  name: string;
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  ghost: HTMLElement | null;
  indicator: HTMLElement | null;
  target: MediaDropTarget | null;
};

let activeMediaDrag: MediaDragSession | null = null;

function finishMediaDrag(commit: boolean) {
  const drag = activeMediaDrag;
  if (!drag) {
    return;
  }
  activeMediaDrag = null;
  drag.ghost?.remove();
  drag.indicator?.remove();
  drag.figure.classList.remove("is-dragging");
  document.body.classList.remove("is-dragging-media");
  draggingMedia = null;
  if (!drag.started) {
    return;
  }
  if (commit && drag.target) {
    if (drag.section) {
      const id = drag.section.dataset.id;
      const state = id ? stackState.get(id) : undefined;
      if (id && state) {
        pushSectionUndo(state, true);
        state.blocks = moveBlockMedia(state.blocks, drag.fromIndex, drag.target);
        state.content = serializeBlocks(state.blocks);
        renderSectionBlocks(drag.section, state);
        scheduleSectionSave(drag.section, state);
      }
    } else {
      pushHostUndo(true);
      noteBlocks = moveBlockMedia(noteBlocks, drag.fromIndex, drag.target);
      publishBlocks();
      scheduleDraft();
    }
  }
  window.setTimeout(() => {
    mediaDragged = false;
  }, 0);
}

window.addEventListener("pointermove", (event) => {
  const drag = activeMediaDrag;
  if (!drag || event.pointerId !== drag.pointerId) {
    return;
  }
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.started) {
    if (Math.hypot(dx, dy) < 5) {
      return;
    }
    drag.started = true;
    draggingMedia = drag.name;
    mediaDragged = true;
    drag.figure.classList.add("is-dragging");
    document.body.classList.add("is-dragging-media");

    const indicator = document.createElement("div");
    indicator.className = "media-drop-indicator";
    indicator.hidden = true;
    document.body.append(indicator);
    drag.indicator = indicator;

    const ghost = document.createElement("div");
    ghost.className = "media-drag-ghost";
    ghost.textContent = displayFileName(drag.name, drag.figure.dataset.label);
    document.body.append(ghost);
    drag.ghost = ghost;
  }

  if (drag.ghost) {
    drag.ghost.style.left = `${event.clientX + 12}px`;
    drag.ghost.style.top = `${event.clientY + 12}px`;
  }

  const cRect = drag.container.getBoundingClientRect();
  if (event.clientY < cRect.top + 28) {
    drag.container.scrollTop -= 8;
  } else if (event.clientY > cRect.bottom - 28) {
    drag.container.scrollTop += 8;
  }

  const target = findMediaDropTarget(
    drag.container,
    drag.figure,
    drag.fromIndex,
    event.clientX,
    event.clientY,
  );
  drag.target = target;
  if (drag.indicator) {
    if (target) {
      if (target.mode === "inline") {
        const clampedTop = Math.max(cRect.top + 2, Math.min(cRect.bottom - 16, target.top));
        drag.indicator.classList.add("is-caret");
        drag.indicator.style.left = `${target.x}px`;
        drag.indicator.style.top = `${clampedTop}px`;
        drag.indicator.style.width = "2px";
        drag.indicator.style.height = `${Math.max(14, target.height)}px`;
      } else {
        const clampedY = Math.max(cRect.top + 2, Math.min(cRect.bottom - 2, target.y));
        drag.indicator.classList.remove("is-caret");
        drag.indicator.style.left = `${cRect.left + 12}px`;
        drag.indicator.style.width = `${Math.max(40, cRect.width - 24)}px`;
        drag.indicator.style.height = "2px";
        drag.indicator.style.top = `${clampedY}px`;
      }
      drag.indicator.hidden = false;
    } else {
      drag.indicator.hidden = true;
    }
  }
});

window.addEventListener("pointerup", (event) => {
  if (activeMediaDrag && event.pointerId === activeMediaDrag.pointerId) {
    finishMediaDrag(true);
  }
});

window.addEventListener("pointercancel", (event) => {
  if (activeMediaDrag && event.pointerId === activeMediaDrag.pointerId) {
    finishMediaDrag(false);
  }
});

function toggleSectionPreview(section: HTMLElement) {
  const id = section.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  const mode = section.querySelector<HTMLButtonElement>(".mode-toggle");
  const preview = section.querySelector<HTMLElement>(".stack-preview");
  const sectionBlocks = section.querySelector<HTMLElement>(".stack-blocks");
  if (!mode || !preview || !sectionBlocks || !state) {
    return;
  }
  const shortcut = previewShortcut();
  const open = preview.hidden;
  preview.hidden = !open;
  sectionBlocks.hidden = open;
  mode.setAttribute("aria-label", open ? "Edit" : "Preview");
  mode.title = open ? `Edit (${shortcut})` : `Preview (${shortcut})`;
  mode.setAttribute("aria-pressed", String(open));
  if (open) {
    const parsed = marked.parse(state.content, { async: false });
    const html = typeof parsed === "string" ? parsed : "";
    preview.innerHTML = DOMPurify.sanitize(html);
    void hydratePreviewContent(preview, () => !preview.hidden);
  } else {
    renderSectionBlocks(section, state);
    sectionTargetArea(section, state)?.focus();
  }
}

function togglePreview() {
  const target = activeStackSection();
  if (target) {
    toggleSectionPreview(target.section);
    return;
  }
  showingPreview = !showingPreview;
  renderSurface();
  if (!showingPreview) {
    focusNote();
  }
}

type MediaResizeSession = {
  figure: HTMLElement;
  targetEl: HTMLElement;
  section: HTMLElement | null;
  blockIndex: number;
  pointerId: number;
  startX: number;
  startWidth: number;
  maxWidth: number;
  currentWidth: number;
};

let activeMediaResize: MediaResizeSession | null = null;

function applyMediaFigureSize(figure: HTMLElement, width?: number) {
  const target = figure.querySelector<HTMLElement>("img, .media-video-wrap");
  if (!target) {
    return;
  }
  if (width && width >= 40) {
    figure.dataset.width = String(Math.round(width));
    target.style.width = `${Math.round(width)}px`;
    if (target instanceof HTMLImageElement) {
      target.style.maxHeight = "none";
    }
    const video = target.querySelector<HTMLVideoElement>("video");
    if (video) {
      video.style.maxHeight = "none";
    }
  } else {
    delete figure.dataset.width;
    target.style.width = "";
    if (target instanceof HTMLImageElement) {
      target.style.maxHeight = "";
    }
    const video = target.querySelector<HTMLVideoElement>("video");
    if (video) {
      video.style.maxHeight = "";
    }
  }
}

function commitMediaWidth(section: HTMLElement | null, blockIndex: number, width: number | undefined) {
  if (section) {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!id || !state) {
      return;
    }
    const block = state.blocks[blockIndex];
    if (block?.kind === "media" && block.width !== width) {
      pushSectionUndo(state, true);
      block.width = width;
      state.content = serializeBlocks(state.blocks);
      scheduleSectionSave(section, state);
      resizeAllBlockTextareas(section);
    }
    return;
  }
  const block = noteBlocks[blockIndex];
  if (block?.kind === "media" && block.width !== width) {
    pushHostUndo(true);
    block.width = width;
    noteContent = serializeBlocks(noteBlocks);
    scheduleDraft();
    resizeAllBlockTextareas(blocksEl);
  }
}

window.addEventListener("pointermove", (event) => {
  const rs = activeMediaResize;
  if (!rs || event.pointerId !== rs.pointerId) {
    return;
  }
  const dx = event.clientX - rs.startX;
  const nextW = Math.round(Math.max(48, Math.min(rs.maxWidth, rs.startWidth + dx)));
  rs.currentWidth = nextW;
  applyMediaFigureSize(rs.figure, nextW);
  resizeAllBlockTextareas(rs.section ?? blocksEl);
});

function finishMediaResize(commit: boolean) {
  const rs = activeMediaResize;
  if (!rs) {
    return;
  }
  activeMediaResize = null;
  rs.figure.classList.remove("is-resizing");
  document.body.classList.remove("is-resizing-media");
  if (commit) {
    commitMediaWidth(rs.section, rs.blockIndex, rs.currentWidth);
  }
  window.setTimeout(() => {
    mediaDragged = false;
  }, 0);
}

window.addEventListener("pointerup", (event) => {
  if (activeMediaResize && event.pointerId === activeMediaResize.pointerId) {
    finishMediaResize(true);
  }
});

window.addEventListener("pointercancel", (event) => {
  if (activeMediaResize && event.pointerId === activeMediaResize.pointerId) {
    finishMediaResize(false);
  }
});

function createMedia(name: string, label?: string, section?: HTMLElement | null, width?: number): HTMLElement {
  const figure = document.createElement("div");
  figure.className = "media";
  figure.dataset.media = name;
  if (label) {
    figure.dataset.label = label;
  }
  figure.draggable = false;

  let resizableTarget: HTMLElement | null = null;
  if (isVideo(name)) {
    const videoWrap = createVideoPreviewElement(name, label);
    figure.append(videoWrap);
    resizableTarget = videoWrap;
  } else if (isAudio(name)) {
    const audioWrap = createAudioElement(name, label);
    figure.append(audioWrap);
  } else if (isImage(name)) {
    const img = document.createElement("img");
    img.alt = label ?? "";
    img.draggable = false;
    void mediaSrc(name).then((src) => {
      img.src = src;
    });
    img.addEventListener("click", () => {
      if (mediaDragged) {
        mediaDragged = false;
        return;
      }
      void openPreview(name);
    });
    figure.append(img);
    resizableTarget = img;
  } else {
    const chip = createFileAttachmentChip(name, label);
    figure.append(chip);
  }

  if (resizableTarget) {
    applyMediaFigureSize(figure, width);
    const grip = document.createElement("div");
    grip.className = "media-resize-grip";
    grip.title = "Drag to resize (double-click to reset)";
    grip.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const idx = Number(figure.dataset.index);
      applyMediaFigureSize(figure, undefined);
      commitMediaWidth(section ?? null, idx, undefined);
    });
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !resizableTarget) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      mediaDragged = true;
      const container = figure.closest<HTMLElement>("#blocks, .stack-blocks");
      const maxWidth = container ? Math.max(80, container.clientWidth - 8) : 600;
      const rect = resizableTarget.getBoundingClientRect();
      const startWidth = Math.max(48, Math.round(rect.width));
      const blockIndex = Number(figure.dataset.index);
      figure.classList.add("is-resizing");
      document.body.classList.add("is-resizing-media");
      activeMediaResize = {
        figure,
        targetEl: resizableTarget,
        section: section ?? null,
        blockIndex,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
        maxWidth,
        currentWidth: startWidth,
      };
    });
    figure.append(grip);
  }

  figure.addEventListener("contextmenu", (event) => {
    const idx = Number(figure.dataset.index);
    showMediaContextMenu(event, name, () => {
      if (section) {
        removeSectionMediaAt(section, idx, name);
      } else {
        removeMediaAt(idx, name);
      }
    });
  });

  figure.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest("audio, .media-resize-grip")) {
        return;
      }
      if (target instanceof HTMLVideoElement) {
        const vRect = target.getBoundingClientRect();
        if (event.clientY > vRect.bottom - 38) {
          return;
        }
      }
    }
    const container = figure.closest<HTMLElement>("#blocks, .stack-blocks");
    if (!container) {
      return;
    }
    event.stopPropagation();
    const fromIndex = Number(figure.dataset.index);
    activeMediaDrag = {
      figure,
      container,
      section: section ?? null,
      name,
      fromIndex,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      ghost: null,
      indicator: null,
      target: null,
    };
  });

  return figure;
}

function handleBlockMediaDeletion(
  container: HTMLElement,
  area: HTMLTextAreaElement,
  event: KeyboardEvent,
  getBlocks: () => Block[],
  removeMediaByIndex: (mediaIndex: number, focusBlockIndex: number, caretOffset: number) => void,
): boolean {
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
    return false;
  }
  if (area.selectionStart !== area.selectionEnd) {
    return false;
  }
  const index = Number(area.dataset.index);
  const items = getBlocks();
  if (event.key === "Backspace" && area.selectionStart === 0) {
    const prevBlock = items[index - 1];
    if (prevBlock?.kind === "media") {
      event.preventDefault();
      const beforeMedia = items[index - 2];
      const beforeLen = beforeMedia?.kind === "text" ? beforeMedia.text.length : 0;
      const targetTextIndex = Math.max(0, index - 2);
      const caretOffset = beforeLen > 0 && area.value.length > 0 ? beforeLen + 1 : beforeLen;
      removeMediaByIndex(index - 1, targetTextIndex, caretOffset);
      return true;
    }
  }
  if (event.key === "Delete" && area.selectionEnd === area.value.length) {
    const nextBlock = items[index + 1];
    if (nextBlock?.kind === "media") {
      event.preventDefault();
      const caretOffset = area.value.length;
      removeMediaByIndex(index + 1, index, caretOffset);
      return true;
    }
  }
  if (event.key === "ArrowLeft" && area.selectionStart === 0) {
    const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
    const pos = areas.indexOf(area);
    if (pos > 0) {
      event.preventDefault();
      const prev = areas[pos - 1];
      prev.focus();
      prev.setSelectionRange(prev.value.length, prev.value.length);
      return true;
    }
  }
  if (event.key === "ArrowRight" && area.selectionEnd === area.value.length) {
    const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
    const pos = areas.indexOf(area);
    if (pos >= 0 && pos < areas.length - 1) {
      event.preventDefault();
      const next = areas[pos + 1];
      next.focus();
      next.setSelectionRange(0, 0);
      return true;
    }
  }
  return false;
}

function handleBlockAreaNavigation(
  container: HTMLElement,
  area: HTMLTextAreaElement,
  event: KeyboardEvent,
): boolean {
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
    return false;
  }
  if (event.key === "ArrowUp" && area.selectionStart === area.selectionEnd) {
    const before = area.value.slice(0, area.selectionStart);
    if (!before.includes("\n")) {
      const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
      const pos = areas.indexOf(area);
      if (pos > 0) {
        event.preventDefault();
        const prev = areas[pos - 1];
        prev.focus();
        prev.setSelectionRange(prev.value.length, prev.value.length);
        return true;
      }
    }
  }
  if (event.key === "ArrowDown" && area.selectionStart === area.selectionEnd) {
    const after = area.value.slice(area.selectionEnd);
    if (!after.includes("\n")) {
      const areas = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")];
      const pos = areas.indexOf(area);
      if (pos >= 0 && pos < areas.length - 1) {
        event.preventDefault();
        const next = areas[pos + 1];
        next.focus();
        next.setSelectionRange(0, 0);
        return true;
      }
    }
  }
  return false;
}

function syncInlineLineSlot(
  area: HTMLTextAreaElement,
  prevBlock: Block | undefined,
  row: HTMLElement | null,
  container: HTMLElement,
  isLast: boolean,
) {
  if (prevBlock?.kind !== "media") {
    return;
  }
  const hasNewline = area.value.includes("\n");
  if (hasNewline) {
    prevBlock.inline = false;
    if (area.classList.contains("inline-line-slot")) {
      area.classList.remove("inline-line-slot");
      if (isLast) {
        area.classList.add("grow");
      }
      if (row && area.parentElement === row) {
        row.after(area);
      } else if (area.parentElement !== container) {
        container.append(area);
      }
    }
  } else {
    prevBlock.inline = area.value.length > 0;
    if (row && !area.classList.contains("inline-line-slot")) {
      area.classList.add("inline-line-slot");
      area.classList.remove("grow");
      row.append(area);
    }
  }
}

function renderBlocks(focusName?: string) {
  const reuse = new Map<string, HTMLElement[]>();
  for (const node of blocksEl.querySelectorAll<HTMLElement>("[data-media]")) {
    const name = node.dataset.media;
    if (name) {
      const list = reuse.get(name) ?? [];
      list.push(node);
      reuse.set(name, list);
    }
  }
  blocksEl.replaceChildren();
  let lastText = -1;
  noteBlocks.forEach((block, index) => {
    if (block.kind === "text") {
      lastText = index;
    }
  });
  let currentRow: HTMLElement | null = null;
  let currentRowSideArea: HTMLTextAreaElement | null = null;

  noteBlocks.forEach((block, index) => {
    if (block.kind === "text") {
      const prevBlock = noteBlocks[index - 1];
      const isAfterMedia = prevBlock?.kind === "media";
      const area = document.createElement("textarea");
      area.rows = 1;
      area.spellcheck = false;
      area.autocomplete = "off";
      area.autocapitalize = "off";
      area.setAttribute("autocorrect", "off");
      area.setAttribute("writingsuggestions", "false");
      area.dataset.index = String(index);
      area.value = block.text;
      const canSitOnMediaLine =
        isAfterMedia &&
        currentRow !== null &&
        currentRowSideArea === null &&
        !block.text.includes("\n");
      if (noteBlocks.length === 1) {
        area.placeholder = "Write a note…";
      } else if (canSitOnMediaLine) {
        area.classList.add("inline-line-slot");
      }
      if (index === lastText && !area.classList.contains("inline-line-slot")) {
        area.classList.add("grow");
      }
      const assignedRow = canSitOnMediaLine ? currentRow : null;
      const remember = () => {
        caret = { index, start: area.selectionStart, end: area.selectionEnd };
      };
      area.addEventListener("focus", () => {
        remember();
        sizeBlockTextarea(area);
      });
      area.addEventListener("blur", () => {
        sizeBlockTextarea(area);
      });
      area.addEventListener("keyup", remember);
      area.addEventListener("mouseup", remember);
      area.addEventListener("select", remember);
      area.addEventListener("keydown", (event) => {
        if (
          handleBlockMediaDeletion(
            blocksEl,
            area,
            event,
            () => noteBlocks,
            (mediaIndex, focusIdx, caretPos) => {
              pushHostUndo(true);
              noteBlocks.splice(mediaIndex, 1);
              publishBlocks();
              scheduleDraft();
              const target = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${focusIdx}"]`);
              if (target) {
                target.focus();
                const clamped = Math.min(caretPos, target.value.length);
                target.setSelectionRange(clamped, clamped);
              }
            },
          )
        ) {
          return;
        }
        if (handleBlockAreaNavigation(blocksEl, area, event)) {
          return;
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing &&
          area.classList.contains("inline-line-slot")
        ) {
          if (area.value.length === 0) {
            event.preventDefault();
            if (prevBlock?.kind === "media") {
              prevBlock.inline = false;
            }
            area.classList.remove("inline-line-slot");
            if (index === lastText) {
              area.classList.add("grow");
            }
            if (assignedRow && area.parentElement === assignedRow) {
              assignedRow.after(area);
            } else {
              blocksEl.append(area);
            }
            sizeBlockTextarea(area);
            area.focus();
            return;
          }
          event.preventDefault();
          pushHostUndo(true);
          const { start, end } = areaSelection(area);
          const beforeLine = area.value.slice(0, start);
          const afterLine = area.value.slice(end);
          if (prevBlock?.kind === "media") {
            prevBlock.inline = beforeLine.length > 0;
          }
          noteBlocks.splice(
            index,
            1,
            { kind: "text", text: beforeLine },
            { kind: "text", text: `\n${afterLine}` },
          );
          publishBlocks();
          scheduleDraft();
          const target = blocksEl.querySelector<HTMLTextAreaElement>(`textarea[data-index="${index}"]`);
          if (target) {
            target.focus();
            const pos = Math.min(beforeLine.length + 1, target.value.length);
            target.setSelectionRange(pos, pos);
          }
          return;
        }
        if (
          event.key === "Tab" &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing
        ) {
          const isEmptyNewMemo =
            !pinnedNoteId &&
            editingId === null &&
            noteContent.trim().length === 0 &&
            noteBlocks.length === 1 &&
            area.value.length === 0;
          if (!isEmptyNewMemo) {
            event.preventDefault();
            const edit = tabOnMarkdown(area.value, area.selectionStart, area.selectionEnd, event.shiftKey);
            applyEdit(area, edit);
            return;
          }
        }
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
      area.addEventListener("beforeinput", () => {
        pushHostUndo(false);
      });
      area.addEventListener("input", () => {
        block.text = area.value;
        syncInlineLineSlot(area, prevBlock, assignedRow, blocksEl, index === lastText);
        noteContent = serializeBlocks(noteBlocks);
        if (mediaTokenRegex.test(area.value)) {
          noteBlocks = parseBlocks(noteContent);
          renderBlocks();
          syncNoteTitle();
          scheduleDraft();
          return;
        }
        sizeBlockTextarea(area);
        remember();
        followEnd(area);
        dismissList();
        syncNoteTitle();
        scheduleDraft();
      });
      if (canSitOnMediaLine && currentRow) {
        currentRow.append(area);
        currentRowSideArea = area;
      } else {
        currentRow = null;
        currentRowSideArea = null;
        blocksEl.append(area);
      }
      sizeBlockTextarea(area);
      return;
    }
    const existingList = reuse.get(block.name);
    const figure = existingList?.shift() ?? createMedia(block.name, block.label, null, block.width);
    applyMediaFigureSize(figure, block.width);
    figure.dataset.index = String(index);
    const row = document.createElement("div");
    row.className = "media-row";
    row.append(figure);
    blocksEl.append(row);
    currentRow = row;
    currentRowSideArea = null;
  });
  if (!focusName) {
    return;
  }
  const media = blocksEl.querySelector(`[data-media="${CSS.escape(focusName)}"]`);
  const next = media?.parentElement?.querySelector("textarea") ?? media?.nextElementSibling;
  if (next instanceof HTMLTextAreaElement) {
    next.focus();
  }
}

function removeMediaAt(index: number, name: string) {
  const from =
    noteBlocks[index]?.kind === "media"
      ? index
      : noteBlocks.findIndex((block) => block.kind === "media" && block.name === name);
  if (from < 0) {
    return;
  }
  pushHostUndo(true);
  noteBlocks.splice(from, 1);
  publishBlocks();
  syncNoteTitle();
  scheduleDraft();
}

function insertMedia(name: string, label?: string) {
  pushHostUndo(true);
  const area = document.activeElement instanceof HTMLTextAreaElement && blocksEl.contains(document.activeElement)
    ? document.activeElement
    : targetArea();
  const index = area ? Number(area.dataset.index) : noteBlocks.length - 1;
  const block = noteBlocks[index];
  if (!block || block.kind !== "text") {
    noteBlocks.push({ kind: "media", name, label });
  } else {
    const { start, end } = area ? areaSelection(area) : { start: block.text.length, end: block.text.length };
    const before = block.text.slice(0, start).replace(/\n+$/, "");
    const after = block.text.slice(end).replace(/^\n+/, "");
    noteBlocks.splice(
      index,
      1,
      { kind: "text", text: before },
      { kind: "media", name, label },
      { kind: "text", text: after },
    );
  }
  publishBlocks(name);
  syncNoteTitle();
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
  pushHostUndo(true);
  area.value = edit.value;
  block.text = edit.value;
  noteContent = serializeBlocks(noteBlocks);
  if (mediaTokenRegex.test(area.value)) {
    noteBlocks = parseBlocks(noteContent);
    renderBlocks();
    syncNoteTitle();
    scheduleDraft();
    return;
  }
  sizeBlockTextarea(area);
  const start = Math.min(edit.start, edit.value.length);
  const end = Math.min(edit.end, edit.value.length);
  area.focus();
  area.setSelectionRange(start, end);
  caret = { index, start, end };
  followEnd(area);
  dismissList();
  syncNoteTitle();
  scheduleDraft();
}

function followEnd(area: HTMLTextAreaElement) {
  if (area.selectionStart !== area.value.length || area.selectionEnd !== area.value.length) {
    return;
  }
  const container = area.closest<HTMLElement>("#blocks, .stack-blocks");
  const pin = () => {
    if (area.selectionEnd === area.value.length && container) {
      const cRect = container.getBoundingClientRect();
      const aRect = area.getBoundingClientRect();
      if (aRect.bottom > cRect.bottom) {
        container.scrollTop += aRect.bottom - cRect.bottom + 8;
      }
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

function insertSectionMedia(section: HTMLElement, name: string, label?: string) {
  const id = section.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  const sectionBlocks = section.querySelector<HTMLElement>(".stack-blocks");
  if (!id || !state || !sectionBlocks) {
    return;
  }
  pushSectionUndo(state, true);
  const area =
    document.activeElement instanceof HTMLTextAreaElement && sectionBlocks.contains(document.activeElement)
      ? document.activeElement
      : sectionTargetArea(section, state);
  const index = area ? Number(area.dataset.index) : state.blocks.length - 1;
  const block = state.blocks[index];
  if (!block || block.kind !== "text") {
    state.blocks.push({ kind: "media", name, label });
  } else {
    const { start, end } = area ? sectionAreaSelection(area, state) : { start: block.text.length, end: block.text.length };
    const before = block.text.slice(0, start).replace(/\n+$/, "");
    const after = block.text.slice(end).replace(/^\n+/, "");
    state.blocks.splice(
      index,
      1,
      { kind: "text", text: before },
      { kind: "media", name, label },
      { kind: "text", text: after },
    );
  }
  state.blocks = ensureTextSlots(state.blocks);
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state, name);
  scheduleSectionSave(section, state);
  const preview = section.querySelector<HTMLElement>(".stack-preview");
  if (preview && !preview.hidden) {
    const parsed = marked.parse(state.content, { async: false });
    const html = typeof parsed === "string" ? parsed : "";
    preview.innerHTML = DOMPurify.sanitize(html);
    void hydratePreviewContent(preview, () => !preview.hidden);
  }
}

function insertSnippet(snippet: string, targetSection?: HTMLElement | null) {
  const match = snippet.trim().match(mediaTokenRegex);
  if (!match?.[3]) {
    return;
  }
  const section = targetSection !== undefined ? targetSection : (activeStackSection()?.section ?? null);
  if (section) {
    insertSectionMedia(section, match[3], match[2] || undefined);
    return;
  }
  insertMedia(match[3], match[2] || undefined);
}

async function attachFiles(files: File[], targetSection?: HTMLElement | null) {
  if (!inTauri()) {
    return;
  }
  for (const file of files) {
    if (file.size > maxMediaBytes) {
      console.error("File is larger than 32 MB");
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const markdown = await invoke<string>("save_media", {
        bytes,
        filename: file.name || null,
        mime: file.type || null,
      });
      insertSnippet(markdown, targetSection);
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
  if (pinnedNoteId) {
    dismissList();
    if (item.id === pinnedNoteId) {
      focusNote();
      return;
    }
    const stackedSection = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(item.id)}"]`);
    const stackedState = stackState.get(item.id);
    if (stackedSection && stackedState) {
      sectionTargetArea(stackedSection, stackedState)?.focus();
      return;
    }
    if (inTauri()) {
      await invoke("set_pinned", { id: item.id, pinned: true, fromComposer: false });
    }
    return;
  }
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
  const spaceTitle = space ? knownSpaces.find((item) => item.name === space)?.title : undefined;
  if (value === "SPACE") {
    return spaceTitle || "Space";
  }
  const short = visibilityOptions.find((item) => item.value === value)?.short ?? "Private";
  return spaceTitle ? `${short} | ${spaceTitle}` : short;
}

function refreshMetaSep() {
  editedSepEl.hidden = visibilityLabelEl.hidden || editedAtEl.hidden;
  syncHeaderCompact();
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
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (state) {
      paintSectionAudience(section, state);
    }
  });
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
  if (pinnedNoteId) {
    if (!document.documentElement.classList.contains("pin-search-open")) {
      return;
    }
    document.documentElement.classList.remove("pin-search-open");
    recentExpanded = false;
    listHidden = true;
    memoListEl.hidden = true;
    recentEl.hidden = true;
    recentEl.classList.remove("expanded");
    showMemoSearch(false);
    recentMoreEl.hidden = true;
    return;
  }
  if (listHidden) {
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
  if (pinnedNoteId && !document.documentElement.classList.contains("pin-search-open")) {
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
  const forcePinSearch = Boolean(pinnedNoteId && document.documentElement.classList.contains("pin-search-open"));
  if (notes.length === 0 && !forcePinSearch) {
    memoListEl.hidden = true;
    recentEl.replaceChildren();
    recentEl.hidden = true;
    showMemoSearch(false);
    recentMoreEl.hidden = true;
    return;
  }
  if (listHidden && !forcePinSearch) {
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
  if (notes.length <= collapsedCount && !forcePinSearch && !recentExpanded) {
    recentExpanded = false;
  }
  memoListEl.hidden = false;
  recentEl.hidden = false;
  showMemoSearch(recentExpanded || forcePinSearch);
  const visible = recentExpanded || forcePinSearch
    ? notes.filter((item) => item.content.toLowerCase().includes(memoQuery))
    : notes.slice(0, collapsedCount);
  recentEl.classList.toggle("expanded", recentExpanded || forcePinSearch);
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

function paintThemeIcon() {
  const hostColorMode = hasStack() ? !altHeld : altHeld;
  paintThemeButton(themeToggleEl, themeIconEl, currentTheme(), hostColorMode);
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

function activeStackSection(): { section: HTMLElement; state: StackState } | null {
  const active = document.activeElement;
  if (active instanceof Element) {
    const section = active.closest<HTMLElement>(".stack-note");
    const id = section?.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (section && state) {
      return { section, state };
    }
    if (cardEl.contains(active)) {
      return null;
    }
  }
  if (lastActiveSection && lastActiveSection !== "host") {
    const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(lastActiveSection)}"]`);
    const state = stackState.get(lastActiveSection);
    if (section && state) {
      return { section, state };
    }
  }
  if (lastActiveSection === "host") {
    return null;
  }
  const hovered = [...(stackEl?.querySelectorAll<HTMLElement>(".stack-note") ?? [])].find((section) =>
    isElementHovered(section),
  );
  const id = hovered?.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  if (hovered && state) {
    return { section: hovered, state };
  }
  return null;
}

function randomHue() {
  const target = activeStackSection();
  if (target) {
    const { section, state } = target;
    const theme = sectionTheme(state);
    const current = sectionHue(state) ?? (theme === "dark" ? darkHue : lightHue);
    let hue = Math.floor(Math.random() * 360);
    if (hue === current) {
      hue = (hue + 137) % 360;
    }
    const slider = section.querySelector<HTMLInputElement>(".hue-slider");
    if (slider) {
      slider.value = String(hue);
    }
    setSectionHue(section, state, hue);
    return;
  }
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

function toggleMemoSearchByTab() {
  if (pinnedNoteId) {
    const isOpen = document.documentElement.classList.contains("pin-search-open");
    if (isOpen) {
      dismissList();
      if (document.activeElement === recentSearchEl) {
        recentSearchEl.blur();
      }
      return;
    }
    document.documentElement.classList.add("pin-search-open");
    listHidden = false;
    recentExpanded = true;
    showMemoSearch(true);
    memoListEl.hidden = false;
    recentEl.hidden = false;
    recentSearchEl.focus();
    recentSearchEl.select();
    void refreshRecent().catch((error: unknown) => {
      console.error(error);
    });
    return;
  }
  const searchOpen = !recentSearchEl.hidden && !listHidden && recentExpanded;
  if (searchOpen) {
    recentExpanded = false;
    showMemoSearch(false);
    void refreshRecent().then(() => {
      if (!pinnedNoteId && editingId === null && noteContent.trim().length === 0) {
        focusNote();
      } else if (document.activeElement === recentSearchEl) {
        recentSearchEl.blur();
      }
    }).catch((error: unknown) => {
      console.error(error);
    });
    return;
  }
  listHidden = false;
  recentExpanded = true;
  showMemoSearch(true);
  memoListEl.hidden = false;
  recentEl.hidden = false;
  recentSearchEl.focus();
  recentSearchEl.select();
  void refreshRecent().then(() => {
    recentSearchEl.focus();
  }).catch((error: unknown) => {
    console.error(error);
  });
}

notePaneEl.addEventListener("mousedown", () => {
  dismissList();
});

cardEl.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
    return;
  }
  const target = event.target;
  if (target instanceof Element && target.closest("#card > header, .stack-note")) {
    return;
  }
  if (gestureHeld || modifierDown(binds.gesture, event)) {
    if (
      target instanceof Element &&
      target.closest(
        "#theme-toggle, #color-pop, #audience-pop, #visibility-label, #markdown-toggle, #markdown-pop, #editor-menu-toggle, #editor-tools, .editor-menu-toggle, .editor-tools, #resize-grip, .resize-handle",
      )
    ) {
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

let lastPasteHandledAt = 0;

function insertPlainText(text: string, targetSection?: HTMLElement | null) {
  if (targetSection) {
    const id = targetSection.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!state) {
      return;
    }
    const area = sectionTargetArea(targetSection, state);
    if (!area) {
      return;
    }
    const { start, end } = sectionAreaSelection(area, state);
    const value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
    const cursor = start + text.length;
    applySectionEdit(targetSection, state, area, { value, start: cursor, end: cursor });
    return;
  }
  const area = targetArea();
  if (!area) {
    return;
  }
  const { start, end } = areaSelection(area);
  const value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
  const cursor = start + text.length;
  applyEdit(area, { value, start: cursor, end: cursor });
}

document.addEventListener("paste", (event) => {
  if (isPreviewWindow()) {
    return;
  }
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    return;
  }
  lastPasteHandledAt = performance.now();
  const targetSection =
    (target instanceof Element ? target.closest<HTMLElement>(".stack-note") : null) ??
    activeStackSection()?.section ??
    null;

  const files = filesFromTransfer(event.clipboardData);
  const items = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const allFiles = uniqueFiles([...files, ...items]);
  const plainText = event.clipboardData?.getData("text/plain") ?? "";

  if (!inTauri()) {
    return;
  }

  event.preventDefault();
  void (async () => {
    try {
      const nativeSnippets = await invoke<string[]>("paste_clipboard_media");
      if (nativeSnippets.length > 0) {
        for (const md of nativeSnippets) {
          insertSnippet(md, targetSection);
        }
        return;
      }
    } catch (error) {
      console.error(error);
    }
    if (allFiles.length > 0) {
      await attachFiles(allFiles, targetSection);
      return;
    }
    if (plainText.length > 0) {
      insertPlainText(plainText, targetSection);
    }
  })();
});

cardEl.addEventListener("dragover", (event) => {
  if (draggingMedia || ![...(event.dataTransfer?.types ?? [])].includes("Files")) {
    return;
  }
  event.preventDefault();
  cardEl.classList.add("dropping");
});

cardEl.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && cardEl.contains(event.relatedTarget)) {
    return;
  }
  cardEl.classList.remove("dropping");
});

cardEl.addEventListener("drop", (event) => {
  if (isPreviewWindow() || draggingMedia) {
    return;
  }
  const files = filesFromTransfer(event.dataTransfer);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  cardEl.classList.remove("dropping");
  const targetSection =
    (event.target instanceof Element ? event.target.closest<HTMLElement>(".stack-note") : null) ??
    activeStackSection()?.section ??
    null;
  void attachFiles(files, targetSection);
});

function closeEditorMenu() {
  editorToolsEl.classList.remove("open");
  editorMenuToggleEl.setAttribute("aria-expanded", "false");
}

editorMenuToggleEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

editorMenuToggleEl.addEventListener("click", () => {
  const open = !editorToolsEl.classList.contains("open");
  editorToolsEl.classList.toggle("open", open);
  editorMenuToggleEl.setAttribute("aria-expanded", String(open));
  if (!open) {
    closeMarkdownPop();
    colorPopEl.hidden = true;
  }
});

modeToggleEl.addEventListener("click", () => {
  togglePreview();
  closeEditorMenu();
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
  closeEditorMenu();
});

document.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (!markdownPopEl.hidden && !markdownPopEl.contains(target) && !markdownToggleEl.contains(target)) {
    closeMarkdownPop();
  }
  if (
    editorToolsEl.classList.contains("open") &&
    !editorToolsEl.contains(target) &&
    !editorMenuToggleEl.contains(target)
  ) {
    closeEditorMenu();
  }
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
  const alt = event.altKey || altHeld;
  const colorMode = hasStack() ? !alt : alt;
  if (colorMode) {
    colorPopEl.hidden = !colorPopEl.hidden;
    if (!colorPopEl.hidden) {
      syncSlider();
    }
    return;
  }
  colorPopEl.hidden = true;
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
  for (const tools of document.querySelectorAll<HTMLElement>(".stack-note .editor-tools.open")) {
    const anchor = tools.parentElement;
    if (tools.contains(target) || anchor?.contains(target)) {
      continue;
    }
    tools.classList.remove("open");
    anchor?.querySelector<HTMLElement>(".editor-menu-toggle")?.setAttribute("aria-expanded", "false");
  }
  for (const pop of document.querySelectorAll<HTMLElement>(
    ".stack-note .color-pop, .stack-note .markdown-pop, .stack-note .audience-pop",
  )) {
    if (pop.hidden || pop.contains(target)) {
      continue;
    }
    const anchor = pop.parentElement;
    if (anchor?.contains(target)) {
      continue;
    }
    pop.hidden = true;
    const label = anchor?.querySelector<HTMLElement>(".visibility-label");
    label?.setAttribute("aria-expanded", "false");
    const delNote = pop.querySelector<HTMLElement>(".delete-note");
    const delConfirm = pop.querySelector<HTMLElement>(".delete-confirm");
    const delYes = pop.querySelector<HTMLElement>(".delete-yes");
    if (delNote) delNote.hidden = false;
    if (delConfirm) delConfirm.hidden = true;
    if (delYes) delYes.textContent = "Delete";
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

document.addEventListener(
  "wheel",
  (event) => {
    if ((!gestureHeld && !modifierDown(binds.gesture, event)) || isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("#card, .stack-note")) {
      return;
    }
    if (target.closest("#color-pop, #audience-pop, #markdown-pop, #editor-tools, .color-pop, .audience-pop, .markdown-pop, .editor-tools")) {
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
  suppressHover: boolean;
  loaded: string;
  content: string;
  blocks: Block[];
  caret: { index: number; start: number; end: number } | null;
  undoStack: NoteHistoryEntry[];
  redoStack: NoteHistoryEntry[];
  lastInputSnapAt: number;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  opacity: number;
  theme: ThemeName | null;
  visibility: string;
  space: string;
};

function pushSectionUndo(state: StackState, force = true) {
  const now = performance.now();
  if (!force && now - state.lastInputSnapAt < 900 && state.undoStack.length > 0) {
    return;
  }
  const serialized = serializeBlocks(state.blocks);
  const top = state.undoStack[state.undoStack.length - 1];
  if (top && serializeBlocks(top.blocks) === serialized) {
    top.caret = state.caret ? { ...state.caret } : null;
    return;
  }
  state.undoStack.push({
    blocks: cloneBlocks(state.blocks),
    caret: state.caret ? { ...state.caret } : null,
  });
  if (state.undoStack.length > 60) {
    state.undoStack.shift();
  }
  state.redoStack = [];
  if (!force) {
    state.lastInputSnapAt = now;
  }
}

function undoSection(section: HTMLElement, state: StackState): boolean {
  if (state.undoStack.length === 0) {
    return false;
  }
  const currentSerialized = serializeBlocks(state.blocks);
  let entry = state.undoStack.pop()!;
  while (state.undoStack.length > 0 && serializeBlocks(entry.blocks) === currentSerialized) {
    entry = state.undoStack.pop()!;
  }
  if (serializeBlocks(entry.blocks) === currentSerialized) {
    return false;
  }
  state.redoStack.push({
    blocks: cloneBlocks(state.blocks),
    caret: state.caret ? { ...state.caret } : null,
  });
  state.blocks = cloneBlocks(entry.blocks);
  state.caret = entry.caret ? { ...entry.caret } : null;
  state.lastInputSnapAt = 0;
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state);
  scheduleSectionSave(section, state);
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (container && state.caret) {
    const area = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${state.caret.index}"]`);
    if (area) {
      area.focus();
      const s = Math.min(state.caret.start, area.value.length);
      const e = Math.min(state.caret.end, area.value.length);
      area.setSelectionRange(s, e);
    }
  }
  return true;
}

function redoSection(section: HTMLElement, state: StackState): boolean {
  if (state.redoStack.length === 0) {
    return false;
  }
  const entry = state.redoStack.pop()!;
  state.undoStack.push({
    blocks: cloneBlocks(state.blocks),
    caret: state.caret ? { ...state.caret } : null,
  });
  state.blocks = cloneBlocks(entry.blocks);
  state.caret = entry.caret ? { ...entry.caret } : null;
  state.lastInputSnapAt = 0;
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state);
  scheduleSectionSave(section, state);
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (container && state.caret) {
    const area = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${state.caret.index}"]`);
    if (area) {
      area.focus();
      const s = Math.min(state.caret.start, area.value.length);
      const e = Math.min(state.caret.end, area.value.length);
      area.setSelectionRange(s, e);
    }
  }
  return true;
}

const stackState = new Map<string, StackState>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

let hostCollapsed = false;
let hostHover = false;
let suppressHostHover = false;
let editingHoldSection: string | null = null;
let autoOpenNewSection: string | null = null;
let cursorPoint: { x: number; y: number } | null = null;
let cursorKnown = false;

function isElementHovered(el: HTMLElement | null | undefined): boolean {
  if (!el) {
    return false;
  }
  if (cursorPoint) {
    const rect = el.getBoundingClientRect();
    const bottom = Math.max(rect.bottom, rect.top + NOTE_BAR);
    return (
      cursorPoint.x >= rect.left &&
      cursorPoint.x <= rect.right &&
      cursorPoint.y >= rect.top &&
      cursorPoint.y <= bottom
    );
  }
  if (cursorKnown) {
    return false;
  }
  return el.matches(":hover");
}

function dismissAutoOpenNewSection() {
  if (autoOpenNewSection === null) {
    return;
  }
  const id = autoOpenNewSection;
  autoOpenNewSection = null;
  if (editingHoldSection === id) {
    editingHoldSection = null;
  }
  const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
  if (document.activeElement instanceof HTMLElement && section?.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}
let lastActiveSection: string = "host";

function syncActiveNoteHeader() {
  const winFocused = document.hasFocus();
  const activeEl = document.activeElement;
  let activeKey: string | null = null;
  if (winFocused) {
    if (activeEl instanceof Element) {
      const section = activeEl.closest<HTMLElement>(".stack-note");
      if (section?.dataset.id) {
        activeKey = section.dataset.id;
      } else if (cardEl.contains(activeEl)) {
        activeKey = "host";
      }
    }
    if (!activeKey) {
      activeKey = lastActiveSection;
    }
  }
  cardEl.classList.toggle("is-editing", activeKey === "host");
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    section.classList.toggle("is-editing", Boolean(activeKey && section.dataset.id === activeKey));
  });
}
let pressTravel = 0;
let pressAt: { x: number; y: number } | null = null;
let openNoteHeight = SECTION_OPEN;
let savedHostHeight = 476;
let heightTween = 0;
let tweenTicket = 0;
let sizingWindow = false;
let sizingTimer: ReturnType<typeof setTimeout> | undefined;
let initialSizeSynced = false;
let chromeSignature: string | null = null;

function hostBarOnly(): boolean {
  return hostCollapsed && !hostHover && editingHoldSection !== "host";
}

function sectionBarOnly(id: string | undefined, state: StackState): boolean {
  return state.collapsed && !state.hover && editingHoldSection !== id;
}

function hasStack(): boolean {
  return stackEl != null && stackEl.childElementCount > 0;
}

function stackCounts(): { opens: number; bars: number } {
  let opens = hostBarOnly() ? 0 : 1;
  let bars = hostBarOnly() ? 1 : 0;
  if (hasStack()) {
    for (const [id, state] of stackState.entries()) {
      if (sectionBarOnly(id, state)) {
        bars += 1;
      } else {
        opens += 1;
      }
    }
  }
  return { opens, bars };
}

function targetWindowHeight(): number {
  const chrome = 56;
  if (!hasStack()) {
    return hostBarOnly() ? WINDOW_BAR : Math.max(196, Math.round(chrome + openNoteHeight));
  }
  const { opens, bars } = stackCounts();
  return Math.round(chrome + opens * openNoteHeight + bars * NOTE_BAR);
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
  const { opens, bars } = stackCounts();
  if (opens <= 0) {
    return;
  }
  const available = Math.max(140 * opens, box - bars * NOTE_BAR);
  const slice = Math.max(140, Math.round(available / opens));
  openNoteHeight = slice;
  savedHostHeight = 56 + slice;
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
  if (!inTauri()) {
    return window.innerHeight;
  }
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const size = await win.innerSize();
    return Math.round(size.height / factor);
  } catch {
    return window.innerHeight;
  }
}

async function setLogicalHeight(height: number) {
  if (!inTauri()) {
    return;
  }
  sizingWindow = true;
  clearTimeout(sizingTimer);
  try {
    await invoke("set_window_height", {
      label: getCurrentWindow().label,
      height: Math.max(96, Math.round(height)),
    });
  } finally {
    sizingTimer = window.setTimeout(() => {
      sizingWindow = false;
    }, 220);
  }
}

function cancelHeightTween() {
  tweenTicket += 1;
  clearTimeout(heightTween);
}

function tweenWindowHeight(target: number) {
  cancelHeightTween();
  const ticket = tweenTicket;
  void logicalHeight().then((from) => {
    if (ticket !== tweenTicket) {
      return;
    }
    if (Math.abs(target - from) <= 2) {
      void setLogicalHeight(target);
      return;
    }
    const began = performance.now();
    const step = () => {
      if (ticket !== tweenTicket) {
        return;
      }
      const t = Math.min(1, (performance.now() - began) / 160);
      const eased = 1 - (1 - t) ** 3;
      void setLogicalHeight(Math.round(from + (target - from) * eased));
      if (t < 1) {
        heightTween = window.setTimeout(step, 16);
      }
    };
    heightTween = window.setTimeout(step, 16);
  });
}

function sectionTheme(state: StackState): ThemeName {
  return state.theme ?? currentTheme();
}

function sectionHue(state: StackState): number | null {
  const theme = sectionTheme(state);
  return theme === "dark" ? state.hueDark : state.hueLight;
}

function paintSectionColor(section: HTMLElement, state: StackState) {
  const theme = sectionTheme(state);
  paintSurface(section, theme, sectionHue(state), look.opacity);
  const button = section.querySelector<HTMLElement>(".theme-toggle");
  const icon = section.querySelector(".theme-icon");
  if (button && icon) {
    paintThemeButton(button, icon, theme, !altHeld);
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

function paintSectionAudience(section: HTMLElement, state: StackState) {
  const id = section.dataset.id;
  if (!id) {
    return;
  }
  let visibility = state.visibility || defaultVisibility || "PRIVATE";
  if (!visibilityOptions.some((option) => option.value === visibility)) {
    visibility = "PRIVATE";
  }
  let space = state.space || "";
  if (space && !knownSpaces.some((item) => item.name === space)) {
    space = "";
  }
  state.visibility = visibility;
  state.space = space;
  const label = section.querySelector<HTMLButtonElement>(".visibility-label");
  if (label) {
    label.hidden = !syncEnabled;
    label.textContent = visibilityShort(visibility, space);
  }
  const edited = section.querySelector<HTMLElement>(".edited-at");
  const sep = section.querySelector<HTMLElement>(".edited-sep");
  if (sep && label && edited) {
    sep.hidden = label.hidden || edited.hidden;
  }
  const visChoices = section.querySelector<HTMLElement>(".visibility-choices");
  const spaceBlock = section.querySelector<HTMLElement>(".space-block");
  const spaceChoices = section.querySelector<HTMLElement>(".space-choices");
  const pop = section.querySelector<HTMLElement>(".audience-pop");
  if (!visChoices || !spaceBlock || !spaceChoices) {
    return;
  }
  visChoices.replaceChildren();
  for (const option of visibilityOptions) {
    if (option.value === "SPACE" && knownSpaces.length === 0) {
      continue;
    }
    visChoices.append(
      audienceChoice(option.label, option.hint, state.visibility === option.value, () => {
        state.visibility = option.value;
        if (option.value === "SPACE" && state.space === "" && knownSpaces[0]) {
          state.space = knownSpaces[0].name;
        }
        paintSectionAudience(section, state);
        void invoke("set_note_audience", {
          id,
          visibility: state.visibility,
          space: state.space,
        }).catch((error: unknown) => {
          console.error(error);
        });
      }),
    );
  }
  spaceChoices.replaceChildren();
  spaceBlock.hidden = knownSpaces.length === 0;
  if (knownSpaces.length === 0) {
    return;
  }
  spaceChoices.append(
    audienceChoice("Unassigned", "", state.space === "", () => {
      state.space = "";
      if (state.visibility === "SPACE") {
        state.visibility = "PRIVATE";
      }
      paintSectionAudience(section, state);
      void invoke("set_note_audience", {
        id,
        visibility: state.visibility,
        space: state.space,
      }).catch((error: unknown) => {
        console.error(error);
      });
    }),
  );
  for (const item of knownSpaces) {
    spaceChoices.append(
      audienceChoice(item.title, "", state.space === item.name, () => {
        state.space = item.name;
        paintSectionAudience(section, state);
        void invoke("set_note_audience", {
          id,
          visibility: state.visibility,
          space: state.space,
        }).catch((error: unknown) => {
          console.error(error);
        });
      }),
    );
  }
  if (pop && !pop.hidden) {
    revealPressedChoice(spaceChoices);
  }
  syncHeaderCompact();
}

function sectionAreaSelection(area: HTMLTextAreaElement, state: StackState): { start: number; end: number } {
  const index = Number(area.dataset.index ?? 0);
  if (document.activeElement === area) {
    return {
      start: area.selectionStart ?? area.value.length,
      end: area.selectionEnd ?? area.value.length,
    };
  }
  if (state.caret?.index === index) {
    const start = Math.min(state.caret.start, area.value.length);
    const end = Math.min(state.caret.end, area.value.length);
    return { start, end };
  }
  return { start: area.value.length, end: area.value.length };
}

function sectionTargetArea(section: HTMLElement, state: StackState): HTMLTextAreaElement | null {
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (!container) {
    return null;
  }
  if (document.activeElement instanceof HTMLTextAreaElement && container.contains(document.activeElement)) {
    return document.activeElement;
  }
  if (state.caret) {
    const remembered = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${state.caret.index}"]`);
    if (remembered) {
      return remembered;
    }
  }
  return container.querySelector<HTMLTextAreaElement>("textarea:last-of-type");
}

function scheduleSectionSave(section: HTMLElement, state: StackState) {
  const id = section.dataset.id;
  if (!id) {
    return;
  }
  if (autoOpenNewSection === id) {
    autoOpenNewSection = null;
    editingHoldSection = id;
  }
  const titleEl = section.querySelector(".note-title");
  if (titleEl) {
    titleEl.textContent = noteTitle(state.content) || "Note";
  }
  const now = Date.now();
  const edited = section.querySelector<HTMLElement>(".edited-at");
  const sep = section.querySelector<HTMLElement>(".edited-sep");
  if (edited && sep) {
    edited.hidden = false;
    sep.hidden = false;
    edited.textContent = relativeTime(now);
    edited.title = exactStamp(now);
    syncHeaderCompact();
  }
  const content = state.content;
  const pending = saveTimers.get(id);
  if (pending) {
    clearTimeout(pending);
  }
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      state.loaded = content;
      void invoke("save_edit", { id, content }).catch((error: unknown) => {
        console.error(error);
      });
    }, 300),
  );
}

function applySectionEdit(section: HTMLElement, state: StackState, area: HTMLTextAreaElement, edit: Edit) {
  const index = Number(area.dataset.index ?? 0);
  const block = state.blocks[index];
  if (block?.kind !== "text") {
    return;
  }
  pushSectionUndo(state, true);
  area.value = edit.value;
  block.text = edit.value;
  area.classList.toggle("empty-slot", edit.value.length === 0 && state.blocks.length > 1);
  sizeBlockTextarea(area);
  state.content = serializeBlocks(state.blocks);
  area.focus();
  const start = Math.min(edit.start, area.value.length);
  const end = Math.min(edit.end, area.value.length);
  area.setSelectionRange(start, end);
  state.caret = { index, start, end };
  scheduleSectionSave(section, state);
}

function removeSectionMediaAt(section: HTMLElement, blockIndex: number, name: string) {
  const id = section.dataset.id;
  const state = id ? stackState.get(id) : undefined;
  if (!state) {
    return;
  }
  let targetIndex = blockIndex;
  const current = state.blocks[targetIndex];
  if (!current || current.kind !== "media" || current.name !== name) {
    targetIndex = state.blocks.findIndex((b) => b.kind === "media" && b.name === name);
  }
  if (targetIndex < 0) {
    return;
  }
  pushSectionUndo(state, true);
  state.blocks = ensureTextSlots(state.blocks.filter((_, idx) => idx !== targetIndex));
  state.content = serializeBlocks(state.blocks);
  renderSectionBlocks(section, state);
  scheduleSectionSave(section, state);
}

function renderSectionBlocks(section: HTMLElement, state: StackState, focusName?: string) {
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  if (!container) {
    return;
  }
  state.blocks = ensureTextSlots(state.blocks);
  state.content = serializeBlocks(state.blocks);
  const reuse = new Map<string, HTMLElement[]>();
  for (const node of container.querySelectorAll<HTMLElement>("[data-media]")) {
    const mediaName = node.dataset.media;
    if (mediaName) {
      const list = reuse.get(mediaName) ?? [];
      list.push(node);
      reuse.set(mediaName, list);
    }
  }
  container.replaceChildren();
  const lastIndex = state.blocks.length - 1;
  let currentRow: HTMLElement | null = null;
  let currentRowSideArea: HTMLTextAreaElement | null = null;

  state.blocks.forEach((block, index) => {
    if (block.kind === "text") {
      const prevBlock = state.blocks[index - 1];
      const isAfterMedia = prevBlock?.kind === "media";
      const area = document.createElement("textarea");
      area.dataset.index = String(index);
      area.value = block.text;
      area.rows = 1;
      area.spellcheck = false;
      area.setAttribute("writingsuggestions", "false");
      area.autocomplete = "off";
      area.setAttribute("autocorrect", "off");
      area.setAttribute("autocapitalize", "off");
      const canSitOnMediaLine =
        isAfterMedia &&
        currentRow !== null &&
        currentRowSideArea === null &&
        !block.text.includes("\n");
      if (index === 0 && state.blocks.length === 1) {
        area.placeholder = "Write a memo...";
      } else if (canSitOnMediaLine) {
        area.classList.add("inline-line-slot");
      } else if (block.text.length === 0 && state.blocks.length > 1) {
        area.classList.add("empty-slot");
      }
      if (index === lastIndex && !area.classList.contains("inline-line-slot")) {
        area.classList.add("grow");
      }
      const assignedRow = canSitOnMediaLine ? currentRow : null;
      const rememberCaret = () => {
        state.caret = {
          index,
          start: area.selectionStart ?? area.value.length,
          end: area.selectionEnd ?? area.value.length,
        };
      };
      area.addEventListener("select", rememberCaret);
      area.addEventListener("keyup", rememberCaret);
      area.addEventListener("mouseup", rememberCaret);
      area.addEventListener("focus", rememberCaret);
      area.addEventListener("keydown", (event) => {
        if (
          handleBlockMediaDeletion(
            container,
            area,
            event,
            () => state.blocks,
            (mediaIndex, focusIdx, caretPos) => {
              pushSectionUndo(state, true);
              state.blocks = ensureTextSlots(state.blocks.filter((_, idx) => idx !== mediaIndex));
              state.content = serializeBlocks(state.blocks);
              renderSectionBlocks(section, state);
              scheduleSectionSave(section, state);
              const target = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${focusIdx}"]`);
              if (target) {
                target.focus();
                const clamped = Math.min(caretPos, target.value.length);
                target.setSelectionRange(clamped, clamped);
              }
            },
          )
        ) {
          return;
        }
        if (handleBlockAreaNavigation(container, area, event)) {
          return;
        }
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing &&
          area.classList.contains("inline-line-slot")
        ) {
          if (area.value.length === 0) {
            event.preventDefault();
            if (prevBlock?.kind === "media") {
              prevBlock.inline = false;
            }
            area.classList.remove("inline-line-slot");
            if (index === lastIndex) {
              area.classList.add("grow");
            }
            if (assignedRow && area.parentElement === assignedRow) {
              assignedRow.after(area);
            } else {
              container.append(area);
            }
            sizeBlockTextarea(area);
            area.focus();
            return;
          }
          event.preventDefault();
          pushSectionUndo(state, true);
          const { start, end } = sectionAreaSelection(area, state);
          const beforeLine = area.value.slice(0, start);
          const afterLine = area.value.slice(end);
          if (prevBlock?.kind === "media") {
            prevBlock.inline = beforeLine.length > 0;
          }
          state.blocks.splice(
            index,
            1,
            { kind: "text", text: beforeLine },
            { kind: "text", text: `\n${afterLine}` },
          );
          state.blocks = ensureTextSlots(state.blocks);
          state.content = serializeBlocks(state.blocks);
          renderSectionBlocks(section, state);
          scheduleSectionSave(section, state);
          const target = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${index}"]`);
          if (target) {
            target.focus();
            const pos = Math.min(beforeLine.length + 1, target.value.length);
            target.setSelectionRange(pos, pos);
          }
          return;
        }
        if (
          event.key === "Tab" &&
          !event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.isComposing
        ) {
          event.preventDefault();
          const edit = tabOnMarkdown(area.value, area.selectionStart, area.selectionEnd, event.shiftKey);
          applySectionEdit(section, state, area, edit);
          return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
          return;
        }
        const edit = taskListOnEnter(area.value, area.selectionStart, area.selectionEnd);
        if (!edit) {
          return;
        }
        event.preventDefault();
        applySectionEdit(section, state, area, edit);
      });
      area.addEventListener("beforeinput", () => {
        pushSectionUndo(state, false);
      });
      area.addEventListener("input", () => {
        block.text = area.value;
        syncInlineLineSlot(area, prevBlock, assignedRow, container, index === lastIndex);
        if (mediaTokenRegex.test(area.value)) {
          state.content = serializeBlocks(state.blocks);
          state.blocks = parseBlocks(state.content);
          renderSectionBlocks(section, state);
          scheduleSectionSave(section, state);
          return;
        }
        sizeBlockTextarea(area);
        rememberCaret();
        state.content = serializeBlocks(state.blocks);
        scheduleSectionSave(section, state);
      });
      if (canSitOnMediaLine && currentRow) {
        currentRow.append(area);
        currentRowSideArea = area;
      } else {
        currentRow = null;
        currentRowSideArea = null;
        container.append(area);
      }
      return;
    }
    const existingList = reuse.get(block.name);
    const figure = existingList?.shift() ?? createMedia(block.name, block.label, section, block.width);
    applyMediaFigureSize(figure, block.width);
    figure.dataset.index = String(index);
    const row = document.createElement("div");
    row.className = "media-row";
    row.append(figure);
    container.append(row);
    currentRow = row;
    currentRowSideArea = null;
  });
  resizeAllBlockTextareas(container);
  if (focusName) {
    const mediaIndex = state.blocks.findIndex((item) => item.kind === "media" && item.name === focusName);
    const target = container.querySelector<HTMLTextAreaElement>(`textarea[data-index="${mediaIndex + 1}"]`);
    target?.focus();
  }
}

function syncSection(section: HTMLElement, note: Note) {
  const state = stackState.get(note.id);
  if (!state) {
    return;
  }
  const isBar = sectionBarOnly(note.id, state);
  section.classList.toggle("is-bar", isBar);
  section.classList.toggle("hover-open", state.collapsed && !isBar);
  const title = section.querySelector(".note-title");
  if (title) {
    title.textContent = noteTitle(state.content) || "Note";
  }
  const edited = section.querySelector<HTMLElement>(".edited-at");
  const sep = section.querySelector<HTMLElement>(".edited-sep");
  if (edited && sep) {
    if (note.updatedAt > 0) {
      edited.hidden = false;
      edited.textContent = relativeTime(note.updatedAt);
      edited.title = exactStamp(note.updatedAt);
    } else {
      edited.hidden = true;
    }
  }
  paintSectionAudience(section, state);
  const container = section.querySelector<HTMLElement>(".stack-blocks");
  const activeInside = Boolean(container && document.activeElement && container.contains(document.activeElement));
  if (!activeInside && (state.content === state.loaded || state.content === note.content)) {
    const changed = state.content !== note.content || (container?.childElementCount ?? 0) === 0;
    state.content = note.content;
    state.loaded = note.content;
    if (changed) {
      state.blocks = parseBlocks(note.content);
      renderSectionBlocks(section, state);
    } else if (container) {
      resizeAllBlockTextareas(container);
    }
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
  const factor = window.devicePixelRatio || 1;
  const x = Math.round((event.screenX - (event.clientX - first.left) - 24) * factor);
  const y = Math.round((event.screenY - (event.clientY - first.top) - 24) * factor);
  const w = Math.round((first.width + 48) * factor);
  // The detached root always opens at default/expanded note height; any tail
  // memos attached beneath it keep their current open/collapsed state.
  let detachedCardsHeight = openNoteHeight;
  for (let i = 1; i < sources.length; i += 1) {
    const tailId = sources[i].dataset.id;
    const tailState = tailId ? stackState.get(tailId) : undefined;
    detachedCardsHeight += tailState?.collapsed ? NOTE_BAR : openNoteHeight;
  }
  const h = Math.round((detachedCardsHeight + 56) * factor);
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
    opacity: look.opacity,
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

async function flushSectionSaves(ids?: Iterable<string>) {
  const targets = ids ? [...ids] : [...saveTimers.keys()];
  await Promise.all(
    targets.map(async (id) => {
      const timer = saveTimers.get(id);
      if (!timer) {
        return;
      }
      clearTimeout(timer);
      saveTimers.delete(id);
      const state = stackState.get(id);
      if (!state) {
        return;
      }
      state.loaded = state.content;
      await invoke("save_edit", { id, content: state.content });
    }),
  );
}

function buildSection(note: Note): HTMLElement {
  const section = document.createElement("section");
  section.className = "stack-note";
  section.dataset.id = note.id;
  section.innerHTML = `${stackHeaderHtml()}
    <div class="stack-blocks"></div>
    <div class="stack-preview" hidden></div>
  `;
  const state = stackState.get(note.id);
  if (state) {
    renderSectionBlocks(section, state);
  }
  section.addEventListener("dragover", (event) => {
    if (draggingMedia || ![...(event.dataTransfer?.types ?? [])].includes("Files")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    section.classList.add("dropping");
  });
  section.addEventListener("dragleave", (event) => {
    if (event.relatedTarget instanceof Node && section.contains(event.relatedTarget)) {
      return;
    }
    section.classList.remove("dropping");
  });
  section.addEventListener("drop", (event) => {
    if (isPreviewWindow() || draggingMedia) {
      return;
    }
    const files = filesFromTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    section.classList.remove("dropping");
    void attachFiles(files, section);
  });
  const header = section.querySelector<HTMLElement>("header");
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
    header.dataset.moved = "0";
    void flushSectionSaves().catch((error: unknown) => {
      console.error(error);
    });
    beginSectionLift(section, header, event);
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
  section.addEventListener("click", (event) => {
    const state = stackState.get(note.id);
    if (!state || !sectionBarOnly(note.id, state) || pressTravel > 8 || header.dataset.moved === "1") {
      return;
    }
    if (event.target instanceof Element && event.target.closest("textarea, button, input, .color-pop, .audience-pop, .markdown-pop, .editor-tools")) {
      return;
    }
    state.collapsed = false;
    state.hover = false;
    state.suppressHover = false;
    if (editingHoldSection === note.id) {
      editingHoldSection = null;
    }
    section.classList.remove("is-bar", "hover-open");
    paintSectionColor(section, state);
    paintChrome();
    resizeAllBlockTextareas(section);
    void invoke("set_collapsed", { id: note.id, collapsed: false }).catch((error: unknown) => {
      console.error(error);
    });
  });
  section.addEventListener("pointerdown", (event) => {
    if (autoOpenNewSection === note.id) {
      autoOpenNewSection = null;
      editingHoldSection = note.id;
    }
    if (event.button !== 0 || !inTauri() || isPreviewWindow()) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest("header, button, input, textarea, .media, .media-audio, .file-attachment, .color-pop, .audience-pop, .markdown-pop, .editor-tools, #resize-grip, .resize-handle")) {
      return;
    }
    startWindowDrag(event);
  });
  section.addEventListener("mouseenter", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    syncCollapsedPeek();
  });
  section.addEventListener("mouseleave", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    if (autoOpenNewSection === note.id) {
      dismissAutoOpenNewSection();
    }
    syncCollapsedPeek();
    paintChrome();
  });
  const themeButton = section.querySelector<HTMLButtonElement>(".theme-toggle");
  const pop = section.querySelector<HTMLElement>(".color-pop");
  const hue = section.querySelector<HTMLInputElement>(".hue-slider");
  themeButton?.addEventListener("click", (event) => {
    const state = stackState.get(note.id);
    if (!state || !pop) {
      return;
    }
    const alt = event.altKey || altHeld;
    if (!alt) {
      pop.hidden = !pop.hidden;
      return;
    }
    pop.hidden = true;
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
  const editorMenuToggle = section.querySelector<HTMLButtonElement>(".editor-menu-toggle");
  const editorTools = section.querySelector<HTMLElement>(".editor-tools");
  const closeSectionEditorMenu = () => {
    editorTools?.classList.remove("open");
    editorMenuToggle?.setAttribute("aria-expanded", "false");
  };
  editorMenuToggle?.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  editorMenuToggle?.addEventListener("click", () => {
    if (!editorTools || !editorMenuToggle) {
      return;
    }
    const open = !editorTools.classList.contains("open");
    editorTools.classList.toggle("open", open);
    editorMenuToggle.setAttribute("aria-expanded", String(open));
    if (!open) {
      if (markdownPop) {
        markdownPop.hidden = true;
        markdownToggle?.setAttribute("aria-expanded", "false");
      }
      if (pop) {
        pop.hidden = true;
      }
    }
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
    const state = stackState.get(note.id);
    if (!kind || !state) {
      return;
    }
    const field = sectionTargetArea(section, state);
    if (!field) {
      return;
    }
    const { start, end } = sectionAreaSelection(field, state);
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
    applySectionEdit(section, state, field, edit);
    if (markdownPop) {
      markdownPop.hidden = true;
      markdownToggle?.setAttribute("aria-expanded", "false");
    }
    closeSectionEditorMenu();
  });
  const mode = section.querySelector<HTMLButtonElement>(".mode-toggle");
  const preview = section.querySelector<HTMLElement>(".stack-preview");
  if (mode) {
    mode.title = `Preview (${previewShortcut()})`;
  }
  mode?.addEventListener("click", () => {
    toggleSectionPreview(section);
    closeSectionEditorMenu();
  });
  preview?.addEventListener("change", (event) => {
    const target = event.target;
    const state = stackState.get(note.id);
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox" || !state || !preview) {
      return;
    }
    const boxes = [...preview.querySelectorAll("input[type='checkbox']")];
    const index = boxes.indexOf(target);
    if (index < 0) {
      return;
    }
    const next = toggleTask(state.content, index, target.checked);
    if (next == null || next === state.content) {
      if (next == null) {
        target.checked = !target.checked;
      }
      return;
    }
    pushSectionUndo(state, true);
    state.content = next;
    state.blocks = parseBlocks(next);
    renderSectionBlocks(section, state);
    scheduleSectionSave(section, state);
  });
  preview?.addEventListener("dblclick", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("a, input, img, video, audio, .media-audio, .file-attachment, button")
    ) {
      return;
    }
    const state = stackState.get(note.id);
    mode?.click();
    if (state) {
      sectionTargetArea(section, state)?.focus();
    }
  });
  const visLabel = section.querySelector<HTMLButtonElement>(".visibility-label");
  const audPop = section.querySelector<HTMLElement>(".audience-pop");
  const delNote = section.querySelector<HTMLButtonElement>(".delete-note");
  const delConfirm = section.querySelector<HTMLElement>(".delete-confirm");
  const delNo = section.querySelector<HTMLButtonElement>(".delete-no");
  const delYes = section.querySelector<HTMLButtonElement>(".delete-yes");
  const spaceChoices = section.querySelector<HTMLElement>(".space-choices");
  const resetSectionDelete = () => {
    if (delNote) delNote.hidden = false;
    if (delConfirm) delConfirm.hidden = true;
    if (delYes) delYes.textContent = "Delete";
  };
  const closeSectionAudience = () => {
    if (audPop) audPop.hidden = true;
    visLabel?.setAttribute("aria-expanded", "false");
    resetSectionDelete();
  };
  visLabel?.addEventListener("click", () => {
    if (!audPop) {
      return;
    }
    if (audPop.hidden) {
      resetSectionDelete();
      audPop.hidden = false;
      visLabel.setAttribute("aria-expanded", "true");
      if (spaceChoices) {
        revealPressedChoice(spaceChoices);
      }
      return;
    }
    closeSectionAudience();
  });
  delNote?.addEventListener("click", () => {
    if (delNote) delNote.hidden = true;
    if (delConfirm) delConfirm.hidden = false;
  });
  delNo?.addEventListener("click", () => {
    resetSectionDelete();
  });
  delYes?.addEventListener("click", () => {
    void (async () => {
      if (delYes) delYes.textContent = "Deleting…";
      const pending = saveTimers.get(note.id);
      if (pending) {
        clearTimeout(pending);
        saveTimers.delete(note.id);
      }
      await invoke("delete_note", { id: note.id });
      closeSectionAudience();
    })().catch((error: unknown) => {
      if (delYes) delYes.textContent = "Could not delete";
      console.error(error);
    });
  });
  section.querySelector<HTMLButtonElement>(".pin-toggle")?.addEventListener("click", () => {
    void (async () => {
      await flushSectionSaves([note.id]);
      await invoke("set_pinned", { id: note.id, pinned: false, fromComposer: false });
    })().catch((error: unknown) => {
      console.error(error);
    });
  });
  section.querySelector<HTMLButtonElement>(".fold-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!id || !state) {
      return;
    }
    if (state.collapsed && editingHoldSection === id) {
      editingHoldSection = null;
      if (autoOpenNewSection === id) {
        autoOpenNewSection = null;
      }
      state.hover = false;
      state.suppressHover = isElementHovered(section);
      const isBar = sectionBarOnly(id, state);
      section.classList.toggle("is-bar", isBar);
      section.classList.toggle("hover-open", state.collapsed && !isBar);
      paintSectionColor(section, state);
      paintChrome();
      return;
    }
    void toggleSection(id);
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
  const existing = [...stackEl.children].map((node) => (node as HTMLElement).dataset.id);
  const previous = new Set(existing.filter((id): id is string => Boolean(id)));
  const nextIds = notes.map((note) => note.id);
  const same = existing.length === nextIds.length && existing.every((id, index) => id === nextIds[index]);
  const joinedIds = initialSizeSynced ? nextIds.filter((id) => !previous.has(id)) : [];
  const autoFoldedJoin = joinedIds.length > 0 && notes.length >= 3;
  if (autoFoldedJoin) {
    hostCollapsed = true;
    hostHover = false;
    suppressHostHover = isElementHovered(cardEl);
    const joinedId = joinedIds[0];
    editingHoldSection = joinedId;
    autoOpenNewSection = joinedId;
    lastActiveSection = joinedId;
  }
  const ids = new Set(nextIds);
  for (const id of [...stackState.keys()]) {
    if (!ids.has(id)) {
      stackState.delete(id);
    }
  }
  for (const note of notes) {
    const prev = stackState.get(note.id);
    const isJoined = autoFoldedJoin && note.id === joinedIds[0];
    const hasPendingSave = saveTimers.has(note.id);
    const content = prev && hasPendingSave ? prev.content : note.content;
    const blocks = prev && prev.content === content ? prev.blocks : parseBlocks(content);
    stackState.set(note.id, {
      collapsed: autoFoldedJoin ? true : Boolean(note.collapsed),
      hover: autoFoldedJoin ? false : (prev?.hover ?? false),
      suppressHover: autoFoldedJoin && !isJoined ? true : (prev?.suppressHover ?? false),
      loaded: prev?.loaded ?? note.content,
      content,
      blocks,
      caret: prev?.caret ?? null,
      undoStack: prev?.undoStack ?? [],
      redoStack: prev?.redoStack ?? [],
      lastInputSnapAt: prev?.lastInputSnapAt ?? 0,
      hueLight: note.hueLight,
      hueDark: note.hueDark,
      swatches: [...note.swatches],
      opacity: note.opacity,
      theme: prev?.theme ?? namedTheme(note.theme),
      visibility: note.visibility || "PRIVATE",
      space: note.space || "",
    });
  }
  if (!same) {
    const sections = notes.map((note) => buildSection(note));
    stackEl.replaceChildren(...sections);
    for (const section of sections) {
      const id = section.dataset.id || "";
      const state = stackState.get(id);
      if (!previous.has(id) && state && !sectionBarOnly(id, state)) {
        section.classList.add("joining");
      }
    }
  }
  notes.forEach((note, index) => {
    const section = stackEl.children[index];
    if (section instanceof HTMLElement) {
      syncSection(section, note);
    }
  });
  if (autoFoldedJoin) {
    const joinedId = joinedIds[0];
    const joinedSection = stackEl.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(joinedId)}"]`);
    const joinedState = stackState.get(joinedId);
    if (joinedSection && joinedState) {
      sectionTargetArea(joinedSection, joinedState)?.focus();
    }
  }
  frameEl?.classList.toggle("has-stack", notes.length > 0);
  cardEl.classList.toggle("stacked-host", notes.length > 0);
  cardEl.classList.toggle("is-bar", notes.length > 0 && hostBarOnly());
  if (!initialSizeSynced) {
    initialSizeSynced = true;
    const box = frameEl?.clientHeight ?? 0;
    const { opens, bars } = stackCounts();
    if (opens === 1 && bars === 0 && box > 100) {
      openNoteHeight = Math.max(160, Math.round(box));
      savedHostHeight = 56 + openNoteHeight;
    } else if (opens > 1 && box >= opens * 260 + bars * NOTE_BAR) {
      openNoteHeight = Math.max(160, Math.round((box - bars * NOTE_BAR) / opens));
      savedHostHeight = 56 + openNoteHeight;
    }
  }
  applyOpenHeight();
  if (autoFoldedJoin) {
    const joinedId = joinedIds[0];
    document.documentElement.classList.toggle("collapsed", hostCollapsed);
    document.documentElement.classList.toggle("hover-open", hostCollapsed && !hostBarOnly());
    syncNoteTitle();
    paintThemeIcon();
    syncActiveNoteHeader();
    suppressHostHover = isElementHovered(cardEl);
    stackEl.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
      const id = section.dataset.id;
      const state = id ? stackState.get(id) : undefined;
      if (state && id !== joinedId) {
        state.suppressHover = isElementHovered(section);
      }
    });
  }
  const target = targetWindowHeight();
  const current = await logicalHeight();
  if (!same || Math.abs(target - current) > 4) {
    cancelHeightTween();
    await setLogicalHeight(target);
  }
  chromeSignature = `${stackCounts().opens}:${stackCounts().bars}:${hasStack() ? 1 : 0}`;
}

async function toggleSection(id: string) {
  const state = stackState.get(id);
  if (!state) {
    return;
  }
  state.collapsed = !state.collapsed;
  state.hover = false;
  if (state.collapsed && editingHoldSection === id) {
    editingHoldSection = null;
  }
  if (state.collapsed && autoOpenNewSection === id) {
    autoOpenNewSection = null;
  }
  const section = stackEl?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
  state.suppressHover = state.collapsed && isElementHovered(section);
  const isBar = sectionBarOnly(id, state);
  section?.classList.toggle("is-bar", isBar);
  section?.classList.toggle("hover-open", state.collapsed && !isBar);
  paintChrome();
  await invoke("set_collapsed", { id, collapsed: state.collapsed }).catch((error: unknown) => {
    console.error(error);
  });
}

function syncHeaderCompact() {
  for (const header of document.querySelectorAll<HTMLElement>("#card > header, .stack-note > header")) {
    const parent = header.parentElement;
    const isBar =
      (parent === cardEl && hostBarOnly()) || Boolean(parent?.classList.contains("is-bar"));
    if (isBar) {
      header.classList.remove("compact-meta", "compact-tools");
      continue;
    }
    const headerW = header.clientWidth || cardEl.clientWidth || (frameEl?.clientWidth ?? window.innerWidth - 48);
    if (headerW <= 0) {
      continue;
    }
    const availW = headerW - 20;
    const brandName = header.querySelector<HTMLElement>(".brand-name");
    const label = header.querySelector<HTMLElement>("#visibility-label, .visibility-label");
    const edited = header.querySelector<HTMLElement>("#edited-at, .edited-at");
    const brandW = brandName?.offsetWidth || 58;
    const hasLabel = Boolean(label && !label.hidden);
    const hasEdited = Boolean(edited && !edited.hidden);
    const labelW = hasLabel && label ? label.scrollWidth : 0;
    const editedW = hasEdited && edited ? edited.scrollWidth : 0;
    const hasBothMeta = hasLabel && hasEdited;
    const singleMetaW = hasBothMeta ? labelW + editedW + 12 : labelW + editedW;
    const twoLineMetaW = Math.max(labelW, editedW);
    const singleBrandW = brandW + (singleMetaW > 0 ? 6 + singleMetaW : 0);
    const twoLineBrandW = brandW + (twoLineMetaW > 0 ? 6 + twoLineMetaW : 0);
    const fullButtonsRightW = 150;
    const compactMeta = hasBothMeta && availW < singleBrandW + fullButtonsRightW;
    const effectiveBrandW = compactMeta ? twoLineBrandW : singleBrandW;
    const compactTools = availW < effectiveBrandW + fullButtonsRightW;
    header.classList.toggle("compact-meta", compactMeta);
    header.classList.toggle("compact-tools", compactTools);
    if (!compactTools) {
      const tools = header.querySelector<HTMLElement>(".editor-tools");
      const btn = header.querySelector<HTMLElement>(".editor-menu-toggle");
      tools?.classList.remove("open");
      btn?.setAttribute("aria-expanded", "false");
    }
  }
}

function paintChrome() {
  const hostOpen = hostCollapsed && !hostBarOnly();
  document.documentElement.classList.toggle("collapsed", hostCollapsed);
  document.documentElement.classList.toggle("hover-open", hostOpen);
  const hostFoldBtn = document.querySelector<HTMLButtonElement>("#fold-toggle");
  if (hostFoldBtn) {
    const label = hostCollapsed ? "Unfold memo" : "Fold memo";
    hostFoldBtn.title = label;
    hostFoldBtn.setAttribute("aria-label", label);
    hostFoldBtn.setAttribute("aria-pressed", String(hostCollapsed));
  }
  frameEl?.classList.toggle("has-stack", hasStack());
  cardEl.classList.toggle("is-bar", hasStack() && hostBarOnly());
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (state) {
      const isBar = sectionBarOnly(id, state);
      section.classList.toggle("hover-open", state.collapsed && !isBar);
      const foldBtn = section.querySelector<HTMLButtonElement>(".fold-toggle");
      if (foldBtn) {
        const label = state.collapsed ? "Unfold memo" : "Fold memo";
        foldBtn.title = label;
        foldBtn.setAttribute("aria-label", label);
        foldBtn.setAttribute("aria-pressed", String(state.collapsed));
      }
      if (section.classList.contains("is-bar") !== isBar) {
        section.classList.toggle("is-bar", isBar);
        paintSectionColor(section, state);
      }
    }
  });
  syncNoteTitle();
  paintThemeIcon();
  syncActiveNoteHeader();
  syncHeaderCompact();
  applyOpenHeight();
  if (!inTauri() || isPreviewWindow()) {
    return;
  }
  const { opens, bars } = stackCounts();
  const signature = `${opens}:${bars}:${hasStack() ? 1 : 0}`;
  const first = chromeSignature === null;
  if (chromeSignature === signature) {
    return;
  }
  chromeSignature = signature;
  if (first) {
    return;
  }
  tweenWindowHeight(hasStack() ? targetWindowHeight() : hostBarOnly() ? WINDOW_BAR : savedHostHeight);
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
  suppressHostHover = collapsed && isElementHovered(cardEl);
  if (collapsed && editingHoldSection === "host") {
    editingHoldSection = null;
  }
  const id = pinnedNoteId || editingId;
  if (id && inTauri()) {
    await invoke("set_collapsed", { id, collapsed: hostCollapsed }).catch((error: unknown) => {
      console.error(error);
    });
  }
  paintChrome();
}

function syncCollapsedPeek() {
  let changed = false;
  if (hostCollapsed) {
    const over = isElementHovered(cardEl);
    if (!over && suppressHostHover) {
      suppressHostHover = false;
    }
    const next = over && !suppressHostHover;
    if (next && autoOpenNewSection !== null && autoOpenNewSection !== "host") {
      dismissAutoOpenNewSection();
      changed = true;
    }
    if (next !== hostHover) {
      hostHover = next;
      changed = true;
    }
  } else if (hostHover) {
    hostHover = false;
    suppressHostHover = false;
    changed = true;
  }
  stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
    const id = section.dataset.id;
    const state = id ? stackState.get(id) : undefined;
    if (!state?.collapsed) {
      if (state) {
        state.suppressHover = false;
      }
      return;
    }
    const over = isElementHovered(section);
    if (!over && state.suppressHover) {
      state.suppressHover = false;
    }
    const next = over && !state.suppressHover;
    if (next && autoOpenNewSection !== null && autoOpenNewSection !== id) {
      dismissAutoOpenNewSection();
      changed = true;
    }
    if (next === state.hover) {
      return;
    }
    state.hover = next;
    const isBar = sectionBarOnly(id, state);
    section.classList.toggle("is-bar", isBar);
    section.classList.toggle("hover-open", state.collapsed && !isBar);
    paintSectionColor(section, state);
    changed = true;
  });
  if (changed) {
    paintChrome();
  }
}

function dragBlocked(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, a, input, textarea, select, audio, video, .media, .media-audio, .file-attachment, #media-context-menu, #resize-grip, .resize-handle, #color-pop, #audience-pop, #markdown-pop, #editor-tools, .color-pop, .audience-pop, .markdown-pop, .editor-tools",
      ),
    )
  );
}

type ResizeDir = "w" | "e" | "s" | "sw" | "se";

function resizeZone(event: MouseEvent): ResizeDir | null {
  const target = event.target;
  if (target instanceof Element) {
    if (
      target.closest(
        "button, a, input, textarea, select, #color-pop, #audience-pop, #markdown-pop, #editor-tools, .color-pop, .audience-pop, .markdown-pop, .editor-tools",
      )
    ) {
      return null;
    }
    const handle = target.closest<HTMLElement>("[data-resize]");
    const dir = handle?.dataset.resize;
    if (dir === "w" || dir === "e" || dir === "s" || dir === "sw" || dir === "se") {
      return dir;
    }
  }
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = event.clientX;
  const y = event.clientY;
  const nearBottom = h - y <= 48;
  if (nearBottom && w - x <= 44) {
    return "se";
  }
  if (nearBottom && x <= 44) {
    return "sw";
  }
  if (h - y <= 40 && x > 44 && w - x > 44) {
    return "s";
  }
  if (y >= 24 && x <= 30) {
    return "w";
  }
  if (y >= 24 && w - x <= 30) {
    return "e";
  }
  return null;
}

let resizing = false;
let resizingVertical = false;

function startResize(event: MouseEvent, requestedDir?: ResizeDir) {
  if (resizing || !inTauri() || isPreviewWindow()) {
    return;
  }
  let dir = requestedDir ?? resizeZone(event);
  if (!dir) {
    return;
  }
  if (stackCounts().opens <= 0) {
    if (dir === "s") {
      return;
    }
    if (dir === "se") {
      dir = "e";
    } else if (dir === "sw") {
      dir = "w";
    }
  }
  event.preventDefault();
  event.stopPropagation();
  cancelHeightTween();
  resizing = true;
  resizingVertical = dir === "s" || dir === "se" || dir === "sw";
  void invoke("begin_corner_resize", { label: getCurrentWindow().label, edge: dir })
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => {
      const wasVertical = resizingVertical;
      resizing = false;
      resizingVertical = false;
      if (wasVertical) {
        rememberOpenSlice();
      }
    });
}

function startWindowDrag(event: MouseEvent) {
  if (!inTauri() || isPreviewWindow() || sectionLift !== null) {
    return;
  }
  const dir = resizeZone(event);
  if (dir) {
    startResize(event, dir);
    return;
  }
  event.preventDefault();
  void invoke("begin_memo_drag", { label: getCurrentWindow().label });
}

function typingNote(): boolean {
  if (!document.hasFocus()) {
    return false;
  }
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
      if (event.button !== 0) {
        return;
      }
      const dir = resizeZone(event);
      if (!dir) {
        return;
      }
      startResize(event, dir);
    },
    true,
  );
  window.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      const dir = resizeZone(event);
      if (!dir) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      startResize(event, dir);
    },
    true,
  );

  const hostHeader = document.querySelector<HTMLElement>("#card header");
  hostHeader?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragBlocked(event.target)) {
      return;
    }
    startWindowDrag(event);
  });
  const hostFold = document.querySelector<HTMLButtonElement>("#fold-toggle");
  hostFold?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (hostCollapsed && editingHoldSection === "host") {
      editingHoldSection = null;
      hostHover = false;
      suppressHostHover = isElementHovered(cardEl);
      paintChrome();
      return;
    }
    void setHostCollapsed(!hostCollapsed);
  });

  cardEl.addEventListener("click", (event) => {
    if (!hostBarOnly() || pressTravel > 8) {
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest("textarea, button, input, #audience-pop, #color-pop, #markdown-pop, #editor-tools")
    ) {
      return;
    }
    void setHostCollapsed(false);
  });
  cardEl.addEventListener("mouseenter", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    syncCollapsedPeek();
  });
  document.documentElement.addEventListener("mouseenter", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    slideOut();
    syncCollapsedPeek();
  });
  document.documentElement.addEventListener("mouseleave", () => {
    cursorPoint = null;
    cursorKnown = true;
    if (autoOpenNewSection !== null) {
      dismissAutoOpenNewSection();
    }
    syncCollapsedPeek();
    paintChrome();
    slideHome();
  });
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target instanceof Element) {
      const section = target.closest<HTMLElement>(".stack-note");
      if (section?.dataset.id) {
        lastActiveSection = section.dataset.id;
      } else if (cardEl.contains(target)) {
        lastActiveSection = "host";
      }
    }
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "range")) {
      const section = target.closest<HTMLElement>(".stack-note");
      const nextHold = section?.dataset.id ?? (cardEl.contains(target) ? "host" : null);
      if (nextHold && nextHold !== editingHoldSection) {
        editingHoldSection = nextHold;
        syncCollapsedPeek();
        paintChrome();
      }
    }
    syncActiveNoteHeader();
    if (typingNote()) {
      slideOut();
    }
  });
  document.addEventListener("focusout", () => {
    window.setTimeout(() => {
      syncActiveNoteHeader();
      slideHome();
    }, 0);
  });
  window.addEventListener("focus", () => {
    syncActiveNoteHeader();
  });
  window.addEventListener("blur", () => {
    autoOpenNewSection = null;
    if (editingHoldSection !== null) {
      editingHoldSection = null;
      syncCollapsedPeek();
      paintChrome();
    }
    syncActiveNoteHeader();
    window.setTimeout(slideHome, 0);
  });
  cardEl.addEventListener("mouseleave", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    syncCollapsedPeek();
  });

  window.addEventListener("pointerdown", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
    pressAt = { x: event.clientX, y: event.clientY };
    pressTravel = 0;
    const target = event.target;
    if (target instanceof Element) {
      const section = target.closest<HTMLElement>(".stack-note");
      if (section?.dataset.id) {
        lastActiveSection = section.dataset.id;
      } else if (cardEl.contains(target)) {
        lastActiveSection = "host";
      }
      syncActiveNoteHeader();
    }
  });
  window.addEventListener("pointermove", (event) => {
    cursorPoint = { x: event.clientX, y: event.clientY };
    cursorKnown = true;
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
  if (inTauri() && !isPreviewWindow()) {
    void getCurrentWindow().listen<[number, number] | null>("window-cursor", (event) => {
      cursorKnown = true;
      cursorPoint = event.payload ? { x: event.payload[0], y: event.payload[1] } : null;
      if (!cursorPoint && autoOpenNewSection !== null) {
        dismissAutoOpenNewSection();
        paintChrome();
      }
      syncCollapsedPeek();
    });

    void getCurrentWindow().onDragDropEvent((event) => {
      if (draggingMedia) {
        return;
      }
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        const factor = window.devicePixelRatio || 1;
        const x = payload.position.x / factor;
        const y = payload.position.y / factor;
        const el = document.elementFromPoint(x, y);
        const section = el?.closest<HTMLElement>(".stack-note") ?? null;
        cardEl.classList.toggle("dropping", !section);
        stackEl?.querySelectorAll<HTMLElement>(".stack-note").forEach((s) => {
          s.classList.toggle("dropping", s === section);
        });
        return;
      }
      if (payload.type === "leave") {
        cardEl.classList.remove("dropping");
        stackEl?.querySelectorAll<HTMLElement>(".stack-note.dropping").forEach((s) => {
          s.classList.remove("dropping");
        });
        return;
      }
      if (payload.type === "drop") {
        cardEl.classList.remove("dropping");
        stackEl?.querySelectorAll<HTMLElement>(".stack-note.dropping").forEach((s) => {
          s.classList.remove("dropping");
        });
        const factor = window.devicePixelRatio || 1;
        const x = payload.position.x / factor;
        const y = payload.position.y / factor;
        const el = document.elementFromPoint(x, y);
        const targetSection = el?.closest<HTMLElement>(".stack-note") ?? activeStackSection()?.section ?? null;
        void (async () => {
          for (const path of payload.paths) {
            try {
              const md = await invoke<string>("save_media_file", { path });
              insertSnippet(md, targetSection);
            } catch (error) {
              console.error(error);
            }
          }
        })();
      }
    });
  }

  if (frameEl && typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      syncHeaderCompact();
      resizeAllBlockTextareas();
      if (sizingWindow || !resizing || !resizingVertical) {
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
      if (
        event.key === "Tab" &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.isComposing
      ) {
        const active = document.activeElement;
        const inTextarea = active instanceof HTMLTextAreaElement;
        const isEmptyNewMemo =
          !pinnedNoteId &&
          editingId === null &&
          noteContent.trim().length === 0 &&
          noteBlocks.length === 1 &&
          (inTextarea ? active.value.length === 0 : true);
        if (!inTextarea || isEmptyNewMemo) {
          event.preventDefault();
          event.stopPropagation();
          toggleMemoSearchByTab();
          return;
        }
      }
      const openStackPops = [
        ...document.querySelectorAll<HTMLElement>(
          ".stack-note .color-pop:not([hidden]), .stack-note .markdown-pop:not([hidden]), .stack-note .audience-pop:not([hidden])",
        ),
      ];
      const openSectionTools = [...document.querySelectorAll<HTMLElement>(".stack-note .editor-tools.open")];
      if (
        event.key === "Escape" &&
        (mediaContextMenuEl !== null ||
          !colorPopEl.hidden ||
          !audiencePopEl.hidden ||
          !markdownPopEl.hidden ||
          editorToolsEl.classList.contains("open") ||
          openStackPops.length > 0 ||
          openSectionTools.length > 0)
      ) {
        closeMediaContextMenu();
        colorPopEl.hidden = true;
        closeAudiencePop();
        closeMarkdownPop();
        closeEditorMenu();
        for (const pop of openStackPops) {
          pop.hidden = true;
        }
        for (const tools of openSectionTools) {
          tools.classList.remove("open");
          tools.parentElement
            ?.querySelector<HTMLElement>(".editor-menu-toggle")
            ?.setAttribute("aria-expanded", "false");
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !(event.target instanceof HTMLInputElement)
      ) {
        const keyLower = event.key.toLowerCase();
        const isUndo = keyLower === "z" && !event.shiftKey;
        const isRedo = (keyLower === "z" && event.shiftKey) || (keyLower === "y" && !event.metaKey);
        if (isUndo || isRedo) {
          const target = event.target;
          const targetSection =
            (target instanceof Element ? target.closest<HTMLElement>(".stack-note") : null) ??
            activeStackSection()?.section ??
            null;
          if (targetSection) {
            const id = targetSection.dataset.id;
            const state = id ? stackState.get(id) : undefined;
            if (state && (isUndo ? undoSection(targetSection, state) : redoSection(targetSection, state))) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          } else if (isUndo ? undoHost() : redoHost()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
      }
      if (
        inTauri() &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "v" &&
        !(event.target instanceof HTMLInputElement)
      ) {
        const keydownAt = performance.now();
        const target = event.target;
        const targetSection =
          (target instanceof Element ? target.closest<HTMLElement>(".stack-note") : null) ??
          activeStackSection()?.section ??
          null;
        window.setTimeout(() => {
          if (lastPasteHandledAt >= keydownAt) {
            return;
          }
          lastPasteHandledAt = performance.now();
          void invoke<string[]>("paste_clipboard_media")
            .then((snippets) => {
              for (const md of snippets) {
                insertSnippet(md, targetSection);
              }
            })
            .catch((error: unknown) => {
              console.error(error);
            });
        }, 35);
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
      stackEl?.querySelectorAll<HTMLButtonElement>(".stack-note .mode-toggle").forEach((btn) => {
        const open = btn.getAttribute("aria-pressed") === "true";
        btn.title = open ? `Edit (${shortcut})` : `Preview (${shortcut})`;
      });
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
  paintChrome();
  await loadTheme();
  if (stored.syncState !== "remote") {
    return;
  }
  const note = await invoke<Note>("get_note", { id: pinnedNoteId });
  if (ticket !== pinLoad || note.id !== pinnedNoteId) {
    return;
  }
  applyPinned(note);
  paintChrome();
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
  void listen("stack-changed", () => {
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
