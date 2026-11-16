import { restoreCaret } from "../editor/history";
import { darkHue, lightHue } from "../look/look";
import type { MediaNoteMutator } from "../media/media-dnd";
import { mountAudience } from "./audience";
import { mountChrome } from "./chrome";
import { createStackContext, type StackDeps } from "./context";
import { mountEditor } from "./editor";
import { mountLayout } from "./layout";
import { mountLook } from "./look";
import { mountSections } from "./sections";

export type { StackDeps } from "./context";

export type StackController = {
  hasGuests(): boolean;
  repaintColors(): void;
  activeHueTarget(): { current: number; apply(hue: number): void } | null;
  activeSectionElement(): HTMLElement | null;
  syncHeader(): void;
  paintChrome(): void;
  setHostCollapsedFlag(collapsed: boolean): void;
  load(): Promise<void>;
  focusNote(id: string): boolean;
  repaintAudiences(): void;
  applyEditorChrome(): void;
  rerenderEditors(): void;
  resumeEditor(): boolean;
  toggleActivePreview(): boolean;
  insertMedia(section: HTMLElement, name: string, label?: string): void;
  mediaMutator(section: HTMLElement): MediaNoteMutator | null;
  insertPlainText(text: string, section: HTMLElement): void;
  undo(section: HTMLElement): boolean;
  redo(section: HTMLElement): boolean;
  dragBlocked(target: EventTarget | null): boolean;
  startWindowDrag(event: MouseEvent): void;
  syncPeek(): void;
  refreshPreviewShortcut(shortcut: string): void;
  wire(): void;
};

export function createStackController(deps: StackDeps): StackController {
  const ctx = createStackContext(deps);
  const layout = mountLayout(ctx);
  const look = mountLook(ctx);
  const audience = mountAudience(ctx);
  const editor = mountEditor(ctx);
  const sections = mountSections(ctx);
  const chrome = mountChrome(ctx);
  ctx.api = {
    ...layout,
    ...look,
    ...audience,
    ...editor,
    ...sections,
    ...chrome,
  };
  return {
    hasGuests: () => layout.hasStack(),
    repaintColors: () => look.repaintStackColors(),
    activeHueTarget() {
      const target = layout.activeStackSection();
      if (!target) {
        return null;
      }
      const theme = look.sectionTheme(target.state);
      const current = look.sectionHue(target.state) ?? (theme === "dark" ? darkHue : lightHue);
      return {
        current,
        apply(hue: number) {
          const slider = target.section.querySelector<HTMLInputElement>(".hue-slider");
          if (slider) {
            slider.value = String(hue);
          }
          look.setSectionHue(target.section, target.state, hue);
        },
      };
    },
    activeSectionElement: () => layout.activeStackSection()?.section ?? null,
    syncHeader: () => layout.syncHeaderCompact(),
    paintChrome: () => layout.paintChrome(),
    setHostCollapsedFlag: (collapsed) => layout.setHostCollapsedFlag(collapsed),
    load: () => sections.loadStack(),
    focusNote(id) {
      const section = ctx.dom.stack?.querySelector<HTMLElement>(`.stack-note[data-id="${CSS.escape(id)}"]`);
      const state = ctx.notes.get(id);
      if (!section || !state) {
        return false;
      }
      const blocks = section.querySelector(".stack-blocks");
      if (blocks && state.caret) {
        restoreCaret(blocks, state.caret);
        return true;
      }
      editor.sectionTargetArea(section, state)?.focus();
      return true;
    },
    repaintAudiences() {
      ctx.dom.stack?.querySelectorAll<HTMLElement>(".stack-note").forEach((section) => {
        const id = section.dataset.id;
        const state = id ? ctx.notes.get(id) : undefined;
        if (state) {
          audience.paintSectionAudience(section, state);
        }
      });
    },
    applyEditorChrome: () => look.applyStackEditorChrome(),
    rerenderEditors: () => editor.rerenderStackEditors(),
    resumeEditor: () => editor.resumeStackEditor(),
    toggleActivePreview() {
      const target = layout.activeStackSection();
      if (!target) {
        return false;
      }
      editor.toggleSectionPreview(target.section);
      return true;
    },
    insertMedia: (section, name, label) => editor.insertSectionMedia(section, name, label),
    mediaMutator: (section) => editor.mediaMutatorForSection(section),
    insertPlainText(text, section) {
      const id = section.dataset.id;
      const state = id ? ctx.notes.get(id) : undefined;
      if (!state) {
        return;
      }
      const area = editor.sectionTargetArea(section, state);
      if (!area) {
        return;
      }
      const { start, end } = editor.sectionAreaSelection(area, state);
      const value = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
      const cursor = start + text.length;
      editor.applySectionEdit(section, state, area, { value, start: cursor, end: cursor });
    },
    undo(section) {
      const id = section.dataset.id;
      const state = id ? ctx.notes.get(id) : undefined;
      return Boolean(state && editor.undoSection(section, state));
    },
    redo(section) {
      const id = section.dataset.id;
      const state = id ? ctx.notes.get(id) : undefined;
      return Boolean(state && editor.redoSection(section, state));
    },
    dragBlocked: (target) => chrome.dragBlocked(target),
    startWindowDrag: (event) => chrome.startWindowDrag(event),
    syncPeek: () => layout.syncCollapsedPeek(),
    refreshPreviewShortcut(shortcut) {
      ctx.dom.stack?.querySelectorAll<HTMLButtonElement>(".stack-note .mode-toggle").forEach((btn) => {
        const open = btn.getAttribute("aria-pressed") === "true";
        btn.title = open ? `Edit (${shortcut})` : `Preview (${shortcut})`;
      });
    },
    wire: () => chrome.wireChrome(),
  };
}
