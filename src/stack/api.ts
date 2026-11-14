import type { SectionState } from "./context";
import type { Editable } from "../editor/editable";
import type { Edit } from "../editor/markdown-edit";
import type { ThemeName } from "../look/memo-chrome";
import type { MediaNoteMutator } from "../media/media-dnd";

export interface StackApi {
  activeStackSection(): {
    section: HTMLElement;
    state: SectionState;
} | null;
  applyOpenHeight(): void;
  applySectionEdit(section: HTMLElement, state: SectionState, area: Editable, edit: Edit): void;
  applyStackEditorChrome(): void;
  cancelHeightTween(): void;
  dismissAutoOpenNewSection(): void;
  dragBlocked(target: EventTarget | null): boolean;
  hasStack(): boolean;
  holdCollapsed(id: string): boolean;
  hostBarOnly(): boolean;
  insertSectionMedia(section: HTMLElement, name: string, label?: string): void;
  isElementHovered(el: HTMLElement | null | undefined): boolean;
  loadStack(): Promise<void>;
  logicalHeight(): Promise<number>;
  mediaMutatorForSection(section: HTMLElement): MediaNoteMutator | null;
  paintChrome(): void;
  paintSectionAudience(section: HTMLElement, state: SectionState): void;
  paintSectionCoder(section: HTMLElement, state: SectionState): void;
  paintSectionColor(section: HTMLElement, state: SectionState): void;
  paintSectionSlots(section: HTMLElement, state: SectionState): void;
  pushSectionUndo(state: SectionState, force?: boolean): void;
  redoSection(section: HTMLElement, state: SectionState): boolean;
  rememberOpenSlice(): void;
  renderSectionBlocks(section: HTMLElement, state: SectionState, focusName?: string): void;
  repaintStackColors(): void;
  rerenderStackEditors(): void;
  resumeStackEditor(): boolean;
  saveSectionEditorView(id: string, state: SectionState): Promise<void>;
  saveSectionLook(id: string, state: SectionState): void;
  scheduleSectionSave(section: HTMLElement, state: SectionState): void;
  sectionAreaSelection(area: Editable, state: SectionState): {
    start: number;
    end: number;
};
  sectionBarOnly(id: string | undefined, state: SectionState): boolean;
  sectionHue(state: SectionState): number | null;
  sectionTargetArea(section: HTMLElement, state: SectionState): Editable | null;
  sectionTheme(state: SectionState): ThemeName;
  setHostCollapsed(collapsed: boolean): Promise<void>;
  setHostCollapsedFlag(collapsed: boolean): void;
  setLogicalHeight(height: number): Promise<void>;
  setSectionHue(section: HTMLElement, state: SectionState, hue: number): void;
  stackCounts(): {
    opens: number;
    bars: number;
};
  startWindowDrag(event: MouseEvent): void;
  syncActiveNoteHeader(): void;
  syncCollapsedPeek(): void;
  syncHeaderCompact(): void;
  targetWindowHeight(): number;
  toggleSection(id: string): Promise<void>;
  toggleSectionPreview(section: HTMLElement): void;
  undoSection(section: HTMLElement, state: SectionState): boolean;
  wireChrome(): void;
}
