export function audienceChoice(title: string, hint: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
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

export function revealPressedChoice(container: HTMLElement) {
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
