# UI Test Plan

This document describes the **separate** UI regression and scale/memory suites for Memose. They exercise the Vite + TypeScript frontend in Chromium (with a Tauri IPC harness) and the SQLite backend at high memo counts. They are **not** part of `npm run check`.

The fast daily gate stays:

```bash
npm run check
```

That pipeline already covers TypeScript, the production bundle, unit tests, Clippy, and Rust tests. See [`quality-pipeline.md`](quality-pipeline.md).

---

## 1. Why a separate UI suite

Memose is a Tauri v2 desktop app: a small Chromium/WebKit webview talks to Rust over IPC. Unit tests cover markdown helpers, shortcuts, chrome math, and SQLite lifecycle. They do not:

- Click the composer, recent list, settings tabs, or stacked memo chrome.
- Rebuild hundreds of recent-list DOM rows after `notes-changed`.
- Measure JS heap, DOM node count, or layout cost when the list is large.
- Prove SQLite `list_recent` / stack-chain cost at thousands of rows.

Pinned memos are each their own webview (`pin-<id>` in `src-tauri/src/window_ctl.rs`). Stacked guests share the host window (`#stack` in `index.html`). Those two shapes have different memory profiles. UI tests catch the first class of regressions; scale tests try the second.

---

## 2. Architecture

```
npm run test:ui          Playwright functional UI (no @scale)
npm run test:ui:headed   Same, visible browser
npm run test:scale       Playwright @scale + ignored Rust SQLite stress
```

### 2.1 Browser tier (Playwright + Chromium CDP)

Specs live in `tests/ui/`. Playwright starts (or reuses) Vite on `http://localhost:1420` and loads `index.html` / `settings.html` in headless Chromium.

Before each navigation, `tests/ui/tauri-harness.ts` injects:

- `window.__TAURI_INTERNALS__` so `inTauri()` in `src/main.ts` is true
- `window.__TAURI_EVENT_PLUGIN_INTERNALS__` so `listen` / `emit` work
- Window metadata (`main`, `pin-<id>`, or `media-preview`)
- An in-memory store that implements every Memose `invoke("…")` command plus `plugin:event|*` and `plugin:window|*`

Tests seed notes, emit backend events (`composer-focus`, `notes-changed`, `stack-changed`, …), and read invocations back from `window.__memoseHarness`.

Scale specs open a Chrome DevTools Protocol session and read `Performance.getMetrics` (`JSHeapUsedSize`, `Nodes`, `JSEventListeners`, `LayoutDuration`) after `HeapProfiler.collectGarbage`.

### 2.2 Rust tier (SQLite scale)

`scale_stress_ten_thousand_memos_and_stack_chains` in `src-tauri/src/notes/db.rs` is `#[ignore]` so `npm run test:rust` / `npm run check` stay fast. `npm run test:scale:rust` runs it with `--include-ignored`.

---

## 3. How to run

```bash
npx playwright install chromium chromium-headless-shell   # once per machine
npm run test:ui                   # functional UI
npm run test:ui:headed            # watch the clicks
npm run test:scale:ui             # Chromium memory / DOM budgets
npm run test:scale:rust           # 10k-memo SQLite
npm run test:scale                # both scale tiers
```

Do not add these to `npm run check` or CI until the suite is a known-green gate. Local Vite on port 1420 is reused when already running (`tauri dev`); otherwise Playwright starts Vite itself.

---

## 4. Tauri IPC harness

The harness is a browser `addInitScript`. It is not the real Rust backend. It exists so the **real** frontend can boot without a webview.

| Concern | Production | Harness |
| :--- | :--- | :--- |
| Runtime detect | `"__TAURI_INTERNALS__" in window` | Object injected before parse |
| Window label | Tauri metadata | `main`, `pin-<id>`, `media-preview` |
| Commands | `#[tauri::command]` in `lib.rs` | In-memory `notes` / `settings` / `shortcuts` |
| Events | `app.emit` / `listen` | `plugin:event\|listen` + `__memoseHarness.emit` |
| `list_recent` | Clamp `1..=200` | Same clamp, overridable for 1k DOM stress |
| Media files | App data dir | Fake `media_path` / `convertFileSrc` URLs |
| Native windows | `open_pinned` creates a webview | Records `set_pinned`; one Chromium page |

Pinned UI is still covered by loading `/?pin=<id>` (the same query `src/main.ts` already honors). Multi-process OS webview cost is documented in Scenario D, not measured in one Chromium tab.

### 4.1 Events tests emit

| Event | When |
| :--- | :--- |
| `composer-focus` | Main window: load draft + recent list (composer does not paint the list until this) |
| `composer-fresh` / `composer-cycle` / `composer-flush` | New memo / last-edited toggle / hide+save |
| `notes-changed` | After pin, delete, audience, or bulk seed |
| `stack-changed` / `stack-aim` | Stack membership or drag-aim |
| `settings-changed` | Settings save |
| `pinned-opacity` | Live opacity while a pin is showing |
| `show-pin` / `show-media` | Pin window / lightbox |

---

## 5. Functional UI regression matrix

These are the Playwright specs (`tests/ui/*.spec.ts`, excluding `@scale`). A failure here is a product regression.

### 5.1 Composer lifecycle — `composer-and-recent.spec.ts`

| Case | UI | Expect |
| :--- | :--- | :--- |
| Empty composer | `composer-focus` | `#blocks textarea` with placeholder “Write a note…” |
| Draft debounce | Type in the textarea | `upsert_draft` after ~300ms |
| Markdown toolbar | Editor tools → Markdown → Bold / Italic / Title / Task / Code | Textarea wrapped (`**…**`, `*…*`, `# …`, `- [ ] …`, `` `…` ``) |
| Preview toggle | `#mode-toggle` or `Control/Meta+Enter` | `#preview` shown; Edit restores the textarea |
| Task checkbox | Preview a `- [ ]` line, click the box | Source becomes `- [x]` |
| Undo / redo | Type, then `Control/Meta+Z` | Previous snapshot restored (host undo cap is 60) |

### 5.2 Recent memos and search

| Case | UI | Expect |
| :--- | :--- | :--- |
| Collapsed list | 5+ seeded memos | 3 rows (`collapsedCount`), `#recent-more` = “More” |
| Expand / collapse | Click More / Less | All fetched rows, then back to 3 |
| Search | Expand, type in `#recent-search` | Filter on content; empty copy “No matches” |
| Open a row | Click `.title` | Editor shows that memo; row `.selected` |
| Pin from list | Click row `.pin` | `set_pinned` invoked; `aria-pressed` updates |

`list_recent` in production fetches at most **200** notes (`recentFetchLimit` in `src/main.ts`, clamp in `Db::list_recent`). Expanded search filters that array in memory and rebuilds `<li>` rows with `replaceChildren()`.

### 5.3 Theme, hue, audience, delete, conflict

| Case | UI | Expect |
| :--- | :--- | :--- |
| Light / dark | `#theme-toggle` | `document.documentElement.dataset.theme` flips; `save_look` after debounce |
| Hue + swatches | Alt-click theme (no stack) | `#color-pop`, slider, `#hue-add` (max 6 slots) |
| Visibility | `#visibility-label` | Private / Signed-in / Public / Space members; `set_note_audience` when the memo has an id |
| Delete | Audience foot → Delete → Delete | `delete_note`; editor cleared; list refreshed |
| Conflict | Open a `syncState: conflict` row | `#conflict` banner; Keep this / Use server calls `resolve_conflict` |

### 5.4 Pinned windows and stacks — `pinned-and-stack.spec.ts`

| Case | UI | Expect |
| :--- | :--- | :--- |
| Pin URL | `/?pin=<id>` | Host content in `#blocks`; `html.pin-window` |
| Stack chain | Host + guests with `stackHost` | `.stack-note` per guest from `stack_chain` (max 8) |
| Fold / unfold | `#fold-toggle` / section `.fold-toggle` | `set_collapsed`; `aria-pressed` |
| Auto-fold | After load, add a third guest and `stack-changed` | Host and existing guests fold (`notes.length >= 3` join path) |
| Theme / hue on pin | Theme button | Per-note `save_look` |
| Detach / delete guest | Section audience / detach | `detach_stack` or `delete_note`; `stack-changed` |

### 5.5 Settings — `settings.spec.ts`

| Case | UI | Expect |
| :--- | :--- | :--- |
| Tabs | Click Visibility / Shortcuts / Sync (useMemos) | `aria-selected`, matching `data-panel` |
| Keyboard | `ArrowRight` / `ArrowLeft` on a tab | Next / previous tab |
| Default visibility | Visibility buttons | `save_settings` with `visibility` / `space` |
| Window snap / login | `#snap-memos`, `#autostart` | `set_snap_memos` / `set_autostart` |
| Shortcut recorder | Shortcuts → `+` → key chord | Chip added; `save_shortcut` |
| Gesture modifier | Modifier choices | `save_shortcut` id `gesture` |
| Sync | URL + token → Save / Test / Disconnect | `save_settings`, `test_memos`, `clear_memos` |

---

## 6. Application limits and memory profiling

Run with `npm run test:scale`. Numbers below are **budgets** (fail if exceeded), not targets to optimize toward on every change. They exist so a leak or accidental O(n²) list rebuild shows up as a red test instead of a slow desktop.

Production facts the scenarios rest on:

- Recent fetch cap: **200**
- Stack walk cap: **8** guests (`chain_after` in `src-tauri/src/notes/db.rs`)
- Auto-fold join: **3+** stacked guests in one window
- Undo stacks: **60** snapshots per open section
- Remote markdown body: **8,192** characters (`MEMOS_CONTENT_LIMIT`)
- Each unpinned-from-stack pin is a **separate webview** (heaps are not shared)

### Scenario A — Thousands of memos in DB and recent list

| Layer | Load | Measure | Budget |
| :--- | :--- | :--- | :--- |
| SQLite | 1k / 5k / 10k rows | `list_recent(200)`, `pending_and_errors()` | p95 query **< 100ms** / **< 200ms** on a laptop-class CPU |
| UI default cap | 1,000 seeded, harness returns 200 | DOM `Nodes`, heap after list paint + search | **< 25k** nodes; heap growth vs empty composer **< 25 MB** |
| UI stress render | Harness `listRecentLimit: 1000` | Same metrics for 1,000 rows | **< 80k** nodes; heap growth **< 60 MB**; search keystroke **< 500ms** |

The 1,000-row render is intentional over-cap. It answers “what if we raised `recentFetchLimit`?” without changing production.

### Scenario B — Refresh and event churn (leak check)

50× `notes-changed` (and pin-window `stack-changed`) on a 200-row list, then `HeapProfiler.collectGarbage`.

| Metric | Budget |
| :--- | :--- |
| `JSHeapUsedSize` after GC vs post-first-paint | growth **< 8 MB** |
| `Nodes` | not growing unbounded (within **20%** of first paint) |
| `JSEventListeners` | growth **< 200** |

`refreshRecentNow` rebuilds list children every time. Listeners on discarded `<li>` buttons must go with them.

### Scenario C — Large memo and preview sanitization

One memo at the **8,192** character boundary, **100** task items, and a media token. Toggle Edit / Preview **50** times. Type enough to exceed the **60**-entry undo cap, then undo.

| Metric | Budget |
| :--- | :--- |
| Preview toggle × 50 + GC | heap growth **< 12 MB** |
| `#preview` after toggle | sanitized task list still present; no leftover duplicate `#preview` roots |
| Undo after 100 snapshots | still restores; harness does not grow undo without bound in the page |

### Scenario D — Max stack vs many windows

| Shape | What the test does | What it cannot do in Chromium |
| :--- | :--- | :--- |
| 1 host + 8 guests in `#stack` | Fold/unfold, edit, heap/nodes | — |
| N pinned webviews | Documented only | OS process/RSS; run by hand (`tauri dev`, pin many memos) |

Expect the stacked shape to stay in **one** JS heap (budget: heap **< 80 MB** after load + a few fold cycles). N separate pins cost roughly **N × one-card heap** at the OS level. Prefer stacking when trying large visible sets.

---

## 7. File map

| Path | Role |
| :--- | :--- |
| [`docs/ui-test-plan.md`](ui-test-plan.md) | This plan |
| [`playwright.config.ts`](../playwright.config.ts) | Chromium, Vite `webServer`, `tests/ui` |
| [`tests/ui/tauri-harness.ts`](../tests/ui/tauri-harness.ts) | IPC + events + seed/emit helpers |
| [`tests/ui/helpers.ts`](../tests/ui/helpers.ts) | `openComposer` / `openPinned` / `openSettings` |
| [`tests/ui/composer-and-recent.spec.ts`](../tests/ui/composer-and-recent.spec.ts) | Composer, list, markdown, conflict |
| [`tests/ui/pinned-and-stack.spec.ts`](../tests/ui/pinned-and-stack.spec.ts) | Pin URL, stack, fold |
| [`tests/ui/settings.spec.ts`](../tests/ui/settings.spec.ts) | Settings window |
| [`tests/ui/scale-memory.spec.ts`](../tests/ui/scale-memory.spec.ts) | `@scale` CDP budgets |
| `src-tauri/src/notes/db.rs` (`scale_stress_…`) | Ignored 10k SQLite test |

---

## 8. Adding a UI test

1. Prefer a real click/type path over calling page functions.
2. Seed backend state with `installHarness` / `seedNotes` **before** `goto`, then emit `composer-focus` for the main window.
3. Assert DOM the user sees (`getByRole`, labels, `textarea` values) and, when useful, `getInvocations()`.
4. Put heavy or slow cases in `scale-memory.spec.ts` with `@scale` in the title.
5. Keep `npm run check` free of Playwright and of the ignored Rust stress test.
