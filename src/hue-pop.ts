import { paperAt, type ThemeName } from "./memo-chrome.ts";

export type HuePopSource = {
  theme: () => ThemeName;
  hue: () => number;
  swatches: () => number[];
  setHue: (hue: number) => void;
  setSwatches: (swatches: number[]) => void;
};

export function bindHuePop(root: HTMLElement, source: HuePopSource): () => void {
  const slider = root.querySelector<HTMLInputElement>(".hue-slider");
  const add = root.querySelector<HTMLButtonElement>(".hue-add");
  const slots = [...root.querySelectorAll<HTMLButtonElement>(".hue-slot")];
  if (!slider || !add) {
    return () => {};
  }

  const paint = () => {
    const theme = source.theme();
    const hue = source.hue();
    const swatches = source.swatches();
    slider.value = String(hue);
    slider.style.setProperty("--thumb", paperAt(theme, hue));
    slots.forEach((slot, index) => {
      const saved = swatches[index];
      if (saved == null) {
        slot.style.background = "";
        delete slot.dataset.hue;
        slot.setAttribute("aria-pressed", "false");
        return;
      }
      slot.dataset.hue = String(saved);
      slot.style.background = paperAt(theme, saved);
      slot.setAttribute("aria-pressed", String(saved === hue));
    });
    add.disabled = swatches.length >= 6 || swatches.includes(hue);
  };

  slider.addEventListener("input", () => {
    source.setHue(Number(slider.value));
    paint();
  });
  add.addEventListener("click", () => {
    const hue = Number(slider.value);
    const swatches = source.swatches();
    if (swatches.includes(hue) || swatches.length >= 6) {
      return;
    }
    source.setSwatches([...swatches, hue]);
    paint();
  });
  for (const slot of slots) {
    slot.addEventListener("click", () => {
      const raw = slot.dataset.hue;
      if (raw == null || raw === "") {
        return;
      }
      source.setHue(Number(raw));
      paint();
    });
  }
  paint();
  return paint;
}
