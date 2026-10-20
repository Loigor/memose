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
