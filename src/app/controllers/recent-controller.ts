import { noteTitle } from "../../editor/markdown-edit";
import { syncIcon } from "../../look/sync-status";
import { scrollTextOffsetIntoView } from "../../editor/textarea";
import { exactStamp, relativeTime } from "../../time";
import type { Note } from "../../types";
import type { AppContext } from "../context";
import type { RecentState } from "../state";

const collapsedCount = 3;
const fetchLimit = 200;

export interface RecentSession {
  open(note: Note): Promise<void>;
  currentId(): string | null;
  selectedId(): string | null;
  isEmptyNewMemo(): boolean;
  focusEditor(): void;
}

export interface RecentAudience {
  updateFromRecent(note: Note): void;
}

export interface RecentController {
  dismiss(): void;
  scheduleRefresh(): void;
  refresh(): Promise<void>;
  markSelected(): void;
  openTagSearch(raw: string, keep?: HTMLElement | null): void;
  toggleSearchByTab(): void;
  reveal(): void;
  resetForComposer(): void;
  collapseForFlush(): void;
}

export function createRecentController(
  context: AppContext,
  state: RecentState,
  session: RecentSession,
  audience: RecentAudience,
): RecentController {
  const {
    memoList,
    recent,
    recentSearch,
    recentMore,
    pinToggle,
  } = context.dom;
  const pinned = context.mode.kind === "pinned";

  function clearQuery() {
    state.query = "";
    recentSearch.value = "";
  }

  function showSearch(on: boolean) {
    recentSearch.hidden = !on;
    if (!on) {
      clearQuery();
    }
  }

  function dismiss() {
    if (pinned) {
      if (!document.documentElement.classList.contains("pin-search-open")) {
        return;
      }
      document.documentElement.classList.remove("pin-search-open");
      state.expanded = false;
      state.hidden = true;
      memoList.hidden = true;
      recent.hidden = true;
      recent.classList.remove("expanded");
      showSearch(false);
      recentMore.hidden = true;
      return;
    }
    if (state.hidden) {
      return;
    }
    state.expanded = false;
    state.hidden = true;
    memoList.hidden = true;
    recent.hidden = true;
    recent.classList.remove("expanded");
    showSearch(false);
    recentMore.hidden = false;
    recentMore.textContent = "More";
    recentMore.setAttribute("aria-expanded", "false");
    void refresh().catch((error: unknown) => {
      console.error(error);
    });
  }

  function scheduleRefresh() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void refresh();
    }, 200);
  }

  async function refresh() {
    if (pinned && !document.documentElement.classList.contains("pin-search-open")) {
      return;
    }
    if (state.flight) {
      state.again = true;
      return state.flight;
    }
    state.flight = refreshNow().finally(() => {
      state.flight = null;
      if (state.again) {
        state.again = false;
        void refresh();
      }
    });
    return state.flight;
  }

  async function refreshNow() {
    const notes = await context.backend.listRecent(fetchLimit);
    const openId = session.currentId();
    if (openId) {
      const current = notes.find((item) => item.id === openId);
      if (current) {
        audience.updateFromRecent(current);
      }
    }
    const forcePinSearch = Boolean(pinned && document.documentElement.classList.contains("pin-search-open"));
    if (notes.length === 0 && !forcePinSearch) {
      memoList.hidden = true;
      recent.replaceChildren();
      recent.hidden = true;
      showSearch(false);
      recentMore.hidden = true;
      return;
    }
    if (state.hidden && !forcePinSearch) {
      memoList.hidden = true;
      recent.replaceChildren();
      recent.hidden = true;
      recent.classList.remove("expanded");
      showSearch(false);
      recentMore.hidden = false;
      recentMore.textContent = "More";
      recentMore.setAttribute("aria-expanded", "false");
      return;
    }
    if (notes.length <= collapsedCount && !forcePinSearch && !state.expanded) {
      state.expanded = false;
    }
    memoList.hidden = false;
    recent.hidden = false;
    showSearch(state.expanded || forcePinSearch);
    const visible = state.expanded || forcePinSearch
      ? notes.filter((item) => item.content.toLowerCase().includes(state.query))
      : notes.slice(0, collapsedCount);
    recent.classList.toggle("expanded", state.expanded || forcePinSearch);
    recent.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No matches";
      recent.append(empty);
    }
    for (const item of visible) {
      const row = document.createElement("li");
      row.dataset.id = item.id;
      if (item.id === session.selectedId()) {
        row.classList.add("selected");
      }
      const title = document.createElement("button");
      title.type = "button";
      title.className = "title";
      title.textContent = noteTitle(item.content);
      title.addEventListener("click", () => {
        void session.open(item)
          .then(markSelected)
          .catch((error: unknown) => {
            console.error(error);
          });
      });
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = relativeTime(item.updatedAt);
      when.title = exactStamp(item.updatedAt);
      const sync = document.createElement("span");
      sync.className = "sync";
      const icon = syncIcon(item.syncState, item.visibility);
      sync.innerHTML = icon.svg;
      sync.title = item.lastError ?? icon.label;
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "pin icon-button";
      pin.innerHTML = pinToggle.innerHTML;
      pin.setAttribute("aria-label", item.pinned ? "Unpin" : "Pin");
      pin.setAttribute("aria-pressed", String(item.pinned));
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        void context.backend
          .setPinned(item.id, !item.pinned, false)
          .then(() => refresh())
          .catch((error: unknown) => {
            console.error(error);
          });
      });
      const label = document.createElement("div");
      label.className = "label";
      label.append(title, when);
      row.append(label, sync, pin);
      recent.append(row);
    }
    recentMore.hidden = notes.length <= collapsedCount;
    recentMore.textContent = state.expanded ? "Less" : "More";
    recentMore.setAttribute("aria-expanded", String(state.expanded));
  }

  function markSelected() {
    for (const row of recent.querySelectorAll<HTMLElement>("li[data-id]")) {
      row.classList.toggle("selected", row.dataset.id === session.selectedId());
    }
  }

  function openTagSearch(raw: string, keep?: HTMLElement | null) {
    const query = raw.startsWith("#") ? raw : `#${raw}`;
    state.hidden = false;
    state.expanded = true;
    if (pinned) {
      document.documentElement.classList.add("pin-search-open");
    }
    showSearch(true);
    recentSearch.value = query;
    state.query = query.trim().toLowerCase();
    memoList.hidden = false;
    recent.hidden = false;
    void refresh()
      .then(() => {
        if (keep instanceof HTMLTextAreaElement) {
          scrollTextOffsetIntoView(keep, keep.selectionStart);
        } else {
          keep?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        recentSearch.focus();
        recentSearch.select();
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  }

  function toggleSearchByTab() {
    if (pinned) {
      const isOpen = document.documentElement.classList.contains("pin-search-open");
      if (isOpen) {
        dismiss();
        if (document.activeElement === recentSearch) {
          recentSearch.blur();
        }
        return;
      }
      document.documentElement.classList.add("pin-search-open");
      state.hidden = false;
      state.expanded = true;
      showSearch(true);
      memoList.hidden = false;
      recent.hidden = false;
      recentSearch.focus();
      recentSearch.select();
      void refresh().catch((error: unknown) => {
        console.error(error);
      });
      return;
    }
    const searchOpen = !recentSearch.hidden && !state.hidden && state.expanded;
    if (searchOpen) {
      state.expanded = false;
      showSearch(false);
      void refresh()
        .then(() => {
          if (session.isEmptyNewMemo()) {
            session.focusEditor();
          } else if (document.activeElement === recentSearch) {
            recentSearch.blur();
          }
        })
        .catch((error: unknown) => {
          console.error(error);
        });
      return;
    }
    state.hidden = false;
    state.expanded = true;
    showSearch(true);
    memoList.hidden = false;
    recent.hidden = false;
    recentSearch.focus();
    recentSearch.select();
    void refresh()
      .then(() => {
        recentSearch.focus();
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  }

  function resetForComposer() {
    state.hidden = false;
    state.expanded = false;
  }

  function reveal() {
    state.hidden = false;
  }

  function collapseForFlush() {
    state.expanded = false;
    state.hidden = false;
  }

  recentSearch.addEventListener("input", () => {
    state.query = recentSearch.value.trim().toLowerCase();
    void refresh().catch((error: unknown) => {
      console.error(error);
    });
  });

  recentMore.addEventListener("click", () => {
    if (state.hidden) {
      state.hidden = false;
    } else {
      state.expanded = !state.expanded;
    }
    void refresh().catch((error: unknown) => {
      console.error(error);
    });
  });

  return {
    dismiss,
    scheduleRefresh,
    refresh,
    markSelected,
    openTagSearch,
    toggleSearchByTab,
    reveal,
    resetForComposer,
    collapseForFlush,
  };
}
