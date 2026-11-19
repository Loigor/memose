export function requireEl<T>(value: T | null, name: string): T {
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

export function pointIn(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

export type ScrollBox = {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  offsetWidth: number;
  offsetHeight: number;
  borderLeft: number;
  borderRight: number;
  borderTop: number;
  borderBottom: number;
  overflowX: string;
  overflowY: string;
};

export function pointOnScrollGutter(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
  box: ScrollBox,
): boolean {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    return false;
  }
  const yScroll =
    (box.overflowY === "auto" || box.overflowY === "scroll" || box.overflowY === "overlay") &&
    box.scrollHeight > box.clientHeight + 1;
  const xScroll =
    (box.overflowX === "auto" || box.overflowX === "scroll" || box.overflowX === "overlay") &&
    box.scrollWidth > box.clientWidth + 1;
  if (yScroll) {
    const reserved = box.offsetWidth - box.clientWidth - box.borderLeft - box.borderRight;
    const hit = Math.max(reserved, 6);
    if (x >= rect.right - hit) {
      return true;
    }
  }
  if (xScroll) {
    const reserved = box.offsetHeight - box.clientHeight - box.borderTop - box.borderBottom;
    const hit = Math.max(reserved, 6);
    if (y >= rect.bottom - hit) {
      return true;
    }
  }
  return false;
}

/** The element `selector` names. A missing one is a bug in the page markup. */
export function required<T extends Element>(selector: string): T {
  return requireEl(document.querySelector<T>(selector), selector);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** A plain button. A `contained` one keeps its click from reaching the memo underneath. */
export function button(className: string, text: string, onClick: () => void, contained = false): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", (event) => {
    if (contained) {
      event.preventDefault();
      event.stopPropagation();
    }
    onClick();
  });
  return node;
}
