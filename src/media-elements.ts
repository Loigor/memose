import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import {
  displayFileName,
  isAudio,
  isImage,
  isPreviewableMedia,
  isVideo,
  mediaPrefix,
  parseMediaMeta,
} from "./markdown-edit";
import { inTauri } from "./platform";

export const mediaPointer = {
  dragged: false,
};

export async function mediaSrc(name: string): Promise<string> {
  const path = await invoke<string>("media_path", { name });
  return convertFileSrc(path);
}

export function revealInFolderLabel(): string {
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

export function closeMediaContextMenu() {
  if (mediaContextMenuEl) {
    mediaContextMenuEl.remove();
    mediaContextMenuEl = null;
  }
}

export function mediaContextMenuOpen(): boolean {
  return mediaContextMenuEl !== null;
}

export function showMediaContextMenu(
  event: MouseEvent,
  name: string,
  options?: { onRemove?: () => void; onPreview?: (name: string) => void },
) {
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
      options?.onPreview?.(name);
    } else {
      void invoke("open_media_file", { name }).catch((error: unknown) => {
        console.error(error);
      });
    }
  });
  menu.append(openBtn);

  if (options?.onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger";
    removeBtn.setAttribute("role", "menuitem");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMediaContextMenu();
      options.onRemove?.();
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

export function createVideoPreviewElement(name: string, label?: string, resolvedUrl?: string): HTMLElement {
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

export function createAudioElement(name: string, label: string | undefined, src?: string): HTMLElement {
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

export function createFileAttachmentChip(name: string, label?: string): HTMLAnchorElement {
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
    if (mediaPointer.dragged) {
      mediaPointer.dragged = false;
      return;
    }
    void invoke("open_media_file", { name }).catch((error: unknown) => {
      console.error(error);
    });
  });
  return link;
}

export function previewBodyTarget(target: EventTarget | null): target is Element {
  return (
    target instanceof Element &&
    Boolean(target.closest("#note-pane")) &&
    !target.closest("a, input, img, video, audio, .media-audio, .file-attachment, button")
  );
}

export async function hydratePreviewContent(
  container: HTMLElement,
  isCurrent: () => boolean = () => true,
  onPreview?: (name: string) => void,
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
            showMediaContextMenu(event, name, { onPreview });
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
            showMediaContextMenu(event, name, { onPreview });
          });
          img.replaceWith(videoWrap);
          return;
        }
        if (isAudio(name)) {
          const audioWrap = createAudioElement(name, label, url);
          audioWrap.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name, { onPreview });
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
          onPreview?.(name);
        });
        img.addEventListener("contextmenu", (event) => {
          showMediaContextMenu(event, name, { onPreview });
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
            onPreview?.(name);
          });
          img.addEventListener("contextmenu", (event) => {
            showMediaContextMenu(event, name, { onPreview });
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
            showMediaContextMenu(event, name, { onPreview });
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
            showMediaContextMenu(event, name, { onPreview });
          });
          link.replaceWith(audioWrap);
        } catch (error) {
          console.error(error);
        }
        return;
      }
      const chip = createFileAttachmentChip(name, label);
      chip.addEventListener("contextmenu", (event) => {
        showMediaContextMenu(event, name, { onPreview });
      });
      link.replaceWith(chip);
    }),
  );
}
