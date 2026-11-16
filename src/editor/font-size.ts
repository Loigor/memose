// Editor text size: defaults from settings plus a per-memo step (Cmd/Ctrl + "+", "-", "0").
// Line heights are always whole pixels, so the textarea, the highlight overlay, the gutter and the
// JS-positioned layers (folds, marks, caret line) share one exact pitch at every size.

export type FontRange = { min: number; max: number; fallback: number };

export const MEMO_FONT: FontRange = { min: 10, max: 32, fallback: 16 };
export const CODE_FONT: FontRange = { min: 9, max: 28, fallback: 13 };

/**
 * Per-memo offset in px, applied to both the text and the code size. This only bounds what is
 * stored; the usable range depends on the defaults (see {@link stepRange}).
 */
export const FONT_STEP = { min: -40, max: 40 };

/** Smallest and largest size a memo can be zoomed to, whatever the default. */
export const ZOOM_MIN = 8;
export const ZOOM_MAX = 48;

const MEMO_LEADING = 1.4;
const CODE_LEADING = 1.45;

export function clampFont(value: unknown, range: FontRange): number {
  const size = Math.round(Number(value));
  return Number.isFinite(size) && size >= range.min && size <= range.max ? size : range.fallback;
}

export function clampStep(value: unknown): number {
  const step = Math.round(Number(value));
  if (!Number.isFinite(step)) {
    return 0;
  }
  return Math.min(FONT_STEP.max, Math.max(FONT_STEP.min, step));
}

/**
 * Steps that change both sizes without either passing the zoom limits. Bounding the step by the
 * sizes it produces means every key press is visible: no hidden presses pile up past a limit
 * that then have to be undone before the text grows again.
 */
export function stepRange(memoDefault: number, codeDefault: number): { min: number; max: number } {
  return {
    min: ZOOM_MIN - Math.min(memoDefault, codeDefault),
    max: ZOOM_MAX - Math.max(memoDefault, codeDefault),
  };
}

/** `step` limited to what the current defaults can show. */
export function usableStep(step: number, memoDefault: number, codeDefault: number): number {
  const range = stepRange(memoDefault, codeDefault);
  return Math.min(range.max, Math.max(range.min, clampStep(step)));
}

export type FontMetrics = { memoFont: number; memoLine: number; codeFont: number; codeLine: number };

/** Sizes for one memo: the defaults moved by `step`, with whole-pixel line heights. */
export function fontMetrics(memoDefault: number, codeDefault: number, step: number): FontMetrics {
  const usable = usableStep(step, memoDefault, codeDefault);
  const memoFont = memoDefault + usable;
  const codeFont = codeDefault + usable;
  return {
    memoFont,
    memoLine: Math.round(memoFont * MEMO_LEADING),
    codeFont,
    codeLine: Math.round(codeFont * CODE_LEADING),
  };
}

const VARS = ["--memo-font", "--memo-line", "--code-font", "--code-line"] as const;

export function applyFontVars(el: HTMLElement, metrics: FontMetrics) {
  el.style.setProperty("--memo-font", `${metrics.memoFont}px`);
  el.style.setProperty("--memo-line", `${metrics.memoLine}px`);
  el.style.setProperty("--code-font", `${metrics.codeFont}px`);
  el.style.setProperty("--code-line", `${metrics.codeLine}px`);
}

export function clearFontVars(el: HTMLElement) {
  for (const name of VARS) {
    el.style.removeProperty(name);
  }
}

export type ZoomKey = "bigger" | "smaller" | "reset";

/**
 * Reads Cmd (macOS) or Ctrl (Windows, Linux) with "+", "-" or "0". Works for "=" (US "+" without
 * Shift), keyboards with a dedicated "+" key, and the numeric keypad.
 */
export function zoomKey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">,
  mac: boolean,
): ZoomKey | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command || event.altKey) {
    return null;
  }
  if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") {
    return "bigger";
  }
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") {
    return "smaller";
  }
  if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") {
    return "reset";
  }
  return null;
}

/** The step after a key press, always counted from the size currently shown. */
export function nextStep(step: number, key: ZoomKey, memoDefault: number, codeDefault: number): number {
  if (key === "reset") {
    return 0;
  }
  const shown = usableStep(step, memoDefault, codeDefault);
  return usableStep(shown + (key === "bigger" ? 1 : -1), memoDefault, codeDefault);
}
