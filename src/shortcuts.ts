export type ShortcutBinds = {
  newMemo: string;
  togglePinned: string;
  preview: string;
  hide: string;
  randomHue: string;
  gesture: string;
};

export const shortcutFields: { id: Exclude<keyof ShortcutBinds, "gesture">; label: string }[] = [
  { id: "newMemo", label: "New memo" },
  { id: "togglePinned", label: "Toggle pinned" },
  { id: "preview", label: "Preview" },
  { id: "hide", label: "Hide" },
  { id: "randomHue", label: "Random hue" },
];

function mac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function defaultBinds(): ShortcutBinds {
  const command = mac() ? "Super" : "Control";
  return {
    newMemo: `${command}+Alt+N`,
    togglePinned: `${command}+Alt+P`,
    preview: `${command}+Enter`,
    hide: "Escape",
    randomHue: "Alt+Enter",
    gesture: "Alt",
  };
}

export function modifierChoices(): { value: string; label: string }[] {
  const apple = mac();
  return [
    { value: "Alt", label: apple ? "Option" : "Alt" },
    { value: "Control", label: apple ? "Control" : "Ctrl" },
    { value: "Shift", label: "Shift" },
    { value: "Super", label: apple ? "Command" : "Win" },
  ];
}

export function gestureSnippet(gesture: string): string {
  const key = formatBind(gesture);
  const both = formatBind(`${gesture}+Super`);
  return `Hold ${key} and drag anywhere on a memo to move it. Hold ${key} and scroll to change its transparency. Hold ${both} and scroll to give every pinned memo that same transparency.`;
}

export function modifierDown(
  gesture: string,
  flags: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean },
): boolean {
  switch (gesture.trim().toLowerCase()) {
    case "control":
    case "ctrl":
      return flags.ctrlKey;
    case "shift":
      return flags.shiftKey;
    case "super":
    case "command":
    case "cmd":
    case "meta":
      return flags.metaKey;
    default:
      return flags.altKey;
  }
}

export function isModifierKey(gesture: string, key: string): boolean {
  switch (gesture.trim().toLowerCase()) {
    case "control":
    case "ctrl":
      return key === "Control";
    case "shift":
      return key === "Shift";
    case "super":
    case "command":
    case "cmd":
    case "meta":
      return key === "Meta";
    default:
      return key === "Alt";
  }
}

export function formatBind(binding: string): string {
  const apple = mac();
  const parts = binding
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => {
      const name = token.toLowerCase();
      if (name === "commandorcontrol" || name === "cmdorctrl" || name === "cmdorcontrol" || name === "commandorctrl") {
        return apple ? "⌘" : "Ctrl";
      }
      if (name === "super" || name === "command" || name === "cmd" || name === "meta") {
        return apple ? "⌘" : "Win";
      }
      if (name === "alt" || name === "option") {
        return apple ? "⌥" : "Alt";
      }
      if (name === "control" || name === "ctrl") {
        return apple ? "⌃" : "Ctrl";
      }
      if (name === "shift") {
        return apple ? "⇧" : "Shift";
      }
      if (name === "enter") {
        return apple ? "↩" : "Enter";
      }
      if (name === "escape" || name === "esc") {
        return "Esc";
      }
      if (name.startsWith("key") && name.length === 4) {
        return name.slice(3).toUpperCase();
      }
      if (name.length === 1) {
        return name.toUpperCase();
      }
      return token;
    });
  return apple ? parts.join("") : parts.join("+");
}

function normalizeKey(value: string): string {
  const name = value.trim().toLowerCase();
  if (name === "esc") {
    return "escape";
  }
  if (name.startsWith("key") && name.length === 4) {
    return name.slice(3);
  }
  if (name.startsWith("digit") && name.length === 6) {
    return name.slice(5);
  }
  return name;
}

export function matchBind(event: KeyboardEvent, binding: string): boolean {
  const tokens = binding
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return false;
  }
  let alt = false;
  let ctrl = false;
  let shift = false;
  let meta = false;
  let key = "";
  for (const token of tokens) {
    const name = token.toLowerCase();
    if (name === "alt" || name === "option") {
      alt = true;
    } else if (name === "control" || name === "ctrl") {
      ctrl = true;
    } else if (name === "shift") {
      shift = true;
    } else if (name === "super" || name === "command" || name === "cmd" || name === "meta") {
      meta = true;
    } else if (name === "commandorcontrol" || name === "cmdorctrl" || name === "cmdorcontrol" || name === "commandorctrl") {
      if (mac()) {
        meta = true;
      } else {
        ctrl = true;
      }
    } else {
      key = token;
    }
  }
  if (key.length === 0) {
    return false;
  }
  return (
    event.altKey === alt &&
    event.ctrlKey === ctrl &&
    event.shiftKey === shift &&
    event.metaKey === meta &&
    normalizeKey(event.code) === normalizeKey(key)
  );
}

export function eventToBind(event: KeyboardEvent): string | null {
  if (event.key === "Alt" || event.key === "Shift" || event.key === "Control" || event.key === "Meta") {
    return null;
  }
  const parts: string[] = [];
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.ctrlKey) {
    parts.push("Control");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.metaKey) {
    parts.push("Super");
  }
  const code = event.code;
  if (code.startsWith("Key") && code.length === 4) {
    parts.push(code.slice(3));
  } else if (code.startsWith("Digit") && code.length === 6) {
    parts.push(code.slice(5));
  } else {
    parts.push(code);
  }
  return parts.join("+");
}
