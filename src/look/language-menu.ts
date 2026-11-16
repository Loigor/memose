import { LANGUAGE_CHOICES, languageLabel } from "../editor/code-highlight";

/** "Auto-detect" in the menu; stored as no language. */
const AUTO = "";

/**
 * Adds (once) and refreshes the coder editor's language picker inside a Format menu.
 * `chosen` is the memo's stored language, null for auto-detect; `detected` is what auto picks.
 */
export function paintLanguageMenu(pop: HTMLElement, chosen: string | null, detected: string) {
  let toggle = pop.querySelector<HTMLButtonElement>(":scope > [data-format='lang']");
  let list = pop.querySelector<HTMLElement>(":scope > .format-langs");
  if (!toggle || !list) {
    const rule = document.createElement("div");
    rule.className = "format-rule";
    rule.setAttribute("aria-hidden", "true");
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.dataset.format = "lang";
    toggle.setAttribute("aria-expanded", "false");
    const name = document.createElement("span");
    name.textContent = "Language";
    const value = document.createElement("span");
    value.className = "format-value";
    toggle.append(name, value);
    list = document.createElement("div");
    list.className = "format-langs";
    list.hidden = true;
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Language");
    for (const [id, label] of [[AUTO, "Auto-detect"] as const, ...LANGUAGE_CHOICES]) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.langChoice = id;
      option.setAttribute("aria-pressed", "false");
      option.textContent = label;
      list.append(option);
    }
    pop.append(rule, toggle, list);
  }
  const current = chosen ?? AUTO;
  const value = toggle.querySelector<HTMLElement>(".format-value");
  if (value) {
    value.textContent = chosen ? languageLabel(chosen) : `Auto · ${languageLabel(detected)}`;
  }
  for (const option of list.querySelectorAll<HTMLButtonElement>("[data-lang-choice]")) {
    const id = option.dataset.langChoice ?? AUTO;
    option.setAttribute("aria-pressed", String(id === current));
    if (id === AUTO) {
      option.textContent = `Auto-detect (${languageLabel(detected)})`;
    }
  }
}

/** Opens or closes the language list; returns true when it is now open. */
export function toggleLanguageList(pop: HTMLElement, open?: boolean): boolean {
  const toggle = pop.querySelector<HTMLButtonElement>(":scope > [data-format='lang']");
  const list = pop.querySelector<HTMLElement>(":scope > .format-langs");
  if (!toggle || !list) {
    return false;
  }
  const next = open ?? Boolean(list.hidden);
  list.hidden = !next;
  toggle.setAttribute("aria-expanded", String(next));
  if (next) {
    list.querySelector<HTMLElement>("[aria-pressed='true']")?.scrollIntoView({ block: "nearest" });
  }
  return next;
}

/**
 * The language a click picked: a language id, null for auto-detect, or undefined when the click
 * was not on a language option.
 */
export function pickedLanguage(target: EventTarget | null): string | null | undefined {
  const option = target instanceof Element ? target.closest<HTMLElement>("[data-lang-choice]") : null;
  if (!option) {
    return undefined;
  }
  return option.dataset.langChoice || null;
}
