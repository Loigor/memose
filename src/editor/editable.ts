export type Editable = HTMLElement & {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number, direction?: "forward" | "backward" | "none"): void;
};

export function isEditable(value: unknown): value is Editable {
  if (!value || typeof value !== "object") {
    return false;
  }
  const field = value as { value?: unknown; setSelectionRange?: unknown };
  return typeof field.value === "string" && typeof field.setSelectionRange === "function";
}

export function editingHost(target: EventTarget | null): Editable | null {
  if (!(target instanceof Node)) {
    return null;
  }
  const el = target instanceof Element ? target : target.parentElement;
  const host = el?.closest("[data-block-field]");
  return isEditable(host) ? host : null;
}

export function activeField(container: ParentNode): Editable | null {
  if (typeof document === "undefined") {
    return null;
  }
  const field = editingHost(document.activeElement);
  if (!field || !container.contains(field)) {
    return null;
  }
  return field;
}

export function fieldsIn(container: ParentNode): Editable[] {
  const out: Editable[] = [];
  for (const node of container.querySelectorAll("[data-block-field]")) {
    if (isEditable(node)) {
      out.push(node);
    }
  }
  return out;
}

export function fieldAt(container: ParentNode, index: number): Editable | null {
  const node = container.querySelector(`[data-block-field][data-index="${index}"]`);
  return isEditable(node) ? node : null;
}
