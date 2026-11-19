/** The effort slider shown while dictating and on a recording's tools. */

import { effortLevels, topLevel } from "./speech";

/** Places the tip right of `anchor`, centred on it; under it when there is no room on the right. */
function placeTip(tip: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  if (rect.right + 8 + width <= window.innerWidth - 8) {
    const top = rect.top + rect.height / 2 - height / 2;
    tip.style.left = `${rect.right + 8}px`;
    tip.style.top = `${Math.max(4, Math.min(top, window.innerHeight - height - 4))}px`;
    return;
  }
  const below = rect.bottom + 6;
  tip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  tip.style.top = `${below + height <= window.innerHeight - 4 ? below : Math.max(4, rect.top - height - 6)}px`;
}

/**
 * The effort slider: "Effort (High)" and a pill with a dot per level and a knob on the current one.
 * Click a dot, drag along the pill, or use the arrow keys. Hovering shows what the level does.
 * `onChange` gets the new level. Clicks on it never reach the memo or the recording.
 */
export function effortSlider(value: number, onChange: (level: number) => void): HTMLElement {
  const top = topLevel();
  let current = Math.min(Math.max(1, value), top);
  const box = document.createElement("div");
  box.className = "effort-slider";
  const label = document.createElement("span");
  label.className = "effort-label";
  const name = document.createElement("span");
  name.className = "effort-name";
  label.append("Effort ", name);
  const track = document.createElement("div");
  track.className = "effort-track";
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "Effort");
  track.setAttribute("aria-valuemin", "1");
  track.setAttribute("aria-valuemax", String(top));
  track.tabIndex = -1;
  const steps: HTMLElement[] = [];
  for (const item of effortLevels.filter((entry) => entry.level <= top)) {
    const dot = document.createElement("span");
    dot.className = "effort-dot";
    dot.dataset.level = String(item.level);
    steps.push(dot);
    track.append(dot);
  }
  const knob = document.createElement("span");
  knob.className = "effort-knob";
  track.append(knob);
  const tip = document.createElement("div");
  tip.className = "effort-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  let hovering = false;
  let dragging = false;

  // The tip lives on <body> so scrolling boxes cannot clip it. While it shows, it leaves with the slider.
  let leaving: MutationObserver | null = null;
  const hideTip = () => {
    tip.hidden = true;
    tip.remove();
    leaving?.disconnect();
    leaving = null;
  };
  const showTip = () => {
    const shown = (hovering || dragging || document.activeElement === track) && box.isConnected;
    if (!shown) {
      hideTip();
      return;
    }
    if (!tip.isConnected) {
      document.body.append(tip);
      leaving = new MutationObserver(() => {
        if (!box.isConnected) {
          hideTip();
        }
      });
      leaving.observe(document.body, { childList: true, subtree: true });
    }
    tip.hidden = false;
    placeTip(tip, box);
  };
  const paint = () => {
    const found = effortLevels.find((item) => item.level === current) ?? effortLevels[1];
    name.textContent = `(${found.name})`;
    tip.replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = found.name;
    tip.append(strong, ` · ${found.hint}`);
    track.setAttribute("aria-valuenow", String(current));
    track.setAttribute("aria-valuetext", `${found.name}: ${found.hint}`);
    box.style.setProperty("--effort-at", String(top > 1 ? (current - 1) / (top - 1) : 0));
    if (!tip.hidden) {
      placeTip(tip, box);
    }
  };
  const set = (next: number) => {
    const level = Math.min(Math.max(1, next), top);
    if (level === current) {
      return;
    }
    current = level;
    paint();
    onChange(level);
  };
  /** The level whose dot is nearest the pointer. The dots run between the track's side paddings. */
  const atPointer = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    const style = getComputedStyle(track);
    const dot = steps[0]?.offsetWidth ?? 0;
    const first = rect.left + (parseFloat(style.paddingLeft) || 0) + dot / 2;
    const last = rect.right - (parseFloat(style.paddingRight) || 0) - dot / 2;
    const share = last > first ? (clientX - first) / (last - first) : 0;
    return 1 + Math.round(Math.min(Math.max(share, 0), 1) * (top - 1));
  };

  track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    track.setPointerCapture?.(event.pointerId);
    dragging = true;
    box.classList.add("is-dragging");
    set(atPointer(event.clientX));
    showTip();
  });
  track.addEventListener("pointermove", (event) => {
    if (track.hasPointerCapture?.(event.pointerId)) {
      set(atPointer(event.clientX));
    }
  });
  const endDrag = (event: PointerEvent) => {
    track.releasePointerCapture?.(event.pointerId);
    if (!dragging) {
      return;
    }
    dragging = false;
    box.classList.remove("is-dragging");
    showTip();
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  box.addEventListener("pointerenter", () => {
    hovering = true;
    showTip();
  });
  box.addEventListener("pointerleave", () => {
    hovering = false;
    showTip();
  });
  track.addEventListener("focus", showTip);
  track.addEventListener("blur", showTip);
  track.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      set(current - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      set(current + 1);
    }
  });
  for (const type of ["mousedown", "pointerdown", "click", "dragstart"] as const) {
    box.addEventListener(type, (event) => {
      event.stopPropagation();
    });
  }
  box.append(label, track);
  paint();
  box.hidden = top === 1;
  return box;
}
