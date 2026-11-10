import { paperAt, type ThemeName } from "./memo-chrome.ts";
import { hueSwatches, onHueSwatches, saveHueSwatches } from "./swatches.ts";

export type HuePopSource = {
  theme: () => ThemeName;
  hue: () => number;
  setHue: (hue: number) => void;
  chip?: (theme: ThemeName, hue: number) => string;
};

export function bindHuePop(root: HTMLElement, source: HuePopSource): () => void {
  const slider = root.querySelector<HTMLInputElement>(".hue-slider");
  const add = root.querySelector<HTMLButtonElement>(".hue-add");
  const slots = [...root.querySelectorAll<HTMLButtonElement>(".hue-slot")];
  if (!slider || !add) {
    return () => {};
  }
  const chip = source.chip ?? paperAt;

  const paint = () => {
    const theme = source.theme();
    const hue = source.hue();
    const swatches = hueSwatches();
    slider.value = String(hue);
    slider.style.setProperty("--thumb", chip(theme, hue));
    slots.forEach((slot, index) => {
      const saved = swatches[index];
      if (saved == null) {
        slot.style.background = "";
        delete slot.dataset.hue;
        slot.setAttribute("aria-pressed", "false");
        return;
      }
      slot.dataset.hue = String(saved);
      slot.style.background = chip(theme, saved);
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
    const swatches = hueSwatches();
    if (swatches.includes(hue) || swatches.length >= 6) {
      return;
    }
    void saveHueSwatches([...swatches, hue]);
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
  onHueSwatches(paint);
  paint();
  return paint;
}
