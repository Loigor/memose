export type Note = {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  syncState: string;
  remoteName: string | null;
  lastError: string | null;
  pinned: boolean;
  opacity: number;
  hueLight: number | null;
  hueDark: number | null;
  swatches: number[];
  visibility?: string | null;
  space?: string | null;
  collapsed?: boolean;
  stackHost?: string | null;
  theme?: string | null;
};

export type MemoSpace = {
  name: string;
  title: string;
  synced?: boolean;
  hue?: number | null;
};

export type PinTabNote = {
  id: string;
  x?: number | null;
  y?: number | null;
  w?: number | null;
  h?: number | null;
};

export type PinTab = {
  id: string;
  name: string;
  hue: number;
  swatches: number[];
  notes: PinTabNote[];
};

export type PinTabs = {
  version: number;
  activeId: string;
  tabs: PinTab[];
};

export type PinTabHit = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};
