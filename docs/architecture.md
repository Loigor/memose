# Architecture

Memose is a **Tauri v2** desktop app with a **vanilla TypeScript** frontend (no React or Vue) and a **Rust** backend. The UI is HTML, CSS, and DOM modules. The OS window, tray, SQLite, file I/O, and useMemos sync live in Rust.

## High-level shape

```
┌─────────────────────────────────────────────────────────┐
│  WebView (WKWebView / WebView2 / WebKitGTK)             │
│  index.html + src/main.ts   → composer / pinned memos   │
│  settings.html + src/settings.ts → settings window      │
│  invoke() / listen()  ──IPC──►  #[tauri::command]       │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│  Rust crate memose_lib  (src-tauri/)                    │
│  windows, tray, shortcuts, SQLite, HTTP sync, media     │
└─────────────────────────────────────────────────────────┘
```

`npm run tauri dev` starts Vite on port 1420, then loads that URL into a native window. `npm run tauri build` runs `tsc && vite build` and ships `dist/` inside the native binary.

The frontend never talks to SQLite or HTTP. It calls `invoke("...")` and listens for events; Rust owns persistence, network, and window chrome.

## Frontend: HTML pages, not UI components

UI structure is **static HTML**. Behavior is **TypeScript modules** that query those IDs and mutate the DOM.

Vite is configured as a multi-page build (`vite.config.ts`) with two entries:

| Entry | Script | Role |
| --- | --- | --- |
| `index.html` | `src/main.ts` | Memo card: editor, recent list, pin window, media lightbox |
| `settings.html` | `src/settings.ts` | Settings: visibility, shortcuts, useMemos sync |

Markup for the note card, toolbar, audience popover, conflict banner, recent list, stack container, and resize handles lives in `index.html`. Settings tabs live in `settings.html`. Shared look is in `src/styles.css`, which imports `shell.css`, `header.css`, `controls.css`, `field.css`, `highlight.css`, and `media.css` from `src/styles/` in that order, and in `src/settings.css`.

### TypeScript modules (`src/`)

These are helpers, not a component framework:

| Module | Role |
| --- | --- |
| `main.ts` | App controller: editor state, drafts, pinning, recent list, IPC, event listeners |
| `settings.ts` | Settings window controller |
| `stack.ts` | Stacked memos drawn under a host window |
| `editor/` (`markdown-edit.ts`, `editor-blocks.ts`, `editor-field.ts`, `textarea.ts`, `history.ts`, `md-highlight.ts`) | Block editor, markdown transforms, undo |
| `media/` (`media-dnd.ts`, `media-elements.ts`, `files.ts`) | Paste/drop, resize, lightbox, attachments |
| `look/` (`look.ts`, `memo-chrome.ts`, `hue-pop.ts`, `audience-ui.ts`, `visibility.ts`, `sync-status.ts`) | Hue, theme, audience, sync icon |
| `shortcuts.ts` | Shortcut matching (shared with settings) |
| `types.ts` | `Note` / `MemoSpace` shapes matching Rust `#[serde(rename_all = "camelCase")]` |

`main.ts` boots in three modes from the **same** `index.html`:

1. **Composer** (`main` window) — new draft + recent list
2. **Pinned memo** — extra windows labeled `pin-<note-id>`, with `globalThis.__memosePin` injected
3. **Media preview** — window label `media-preview`, lightbox only

That split is at the bottom of `main.ts`: it either loads a pinned note, initializes the lightbox, or listens for composer events (`composer-flush`, `composer-fresh`, `notes-changed`, and so on).

## Tauri glue

Rust crate layout:

- `src-tauri/src/main.rs` — tiny binary: `memose_lib::run()`
- `src-tauri/src/lib.rs` — the real app: plugins, setup, command registry
- `src-tauri/tauri.conf.json` — one hidden frameless `main` window, CSP, `asset:` protocol for `$APPDATA/media/**`
- `src-tauri/capabilities/default.json` — which windows (`main`, `settings`, `media-preview`, `pin-*`) may call which APIs

On setup (`lib.rs`):

1. macOS: accessory app (menu bar, no Dock)
2. Create `app_data_dir/media/` and open `memose.db`
3. Import a legacy keychain token if present
4. Put `AppState` (DB, HTTP client, sync channel, window flags) into Tauri's managed state
5. Attach window events, tray, global shortcuts, mouse-side-button hook
6. Start the sync worker and kick off the first cycle

Frontend calls look like:

```ts
invoke("save_edit", { id, content })
listen("notes-changed", () => { ... })
```

Every command is registered in `tauri::generate_handler![...]` in `lib.rs`. Implementations live in `src-tauri/src/commands.rs` — thin wrappers that call `notes::Db`, `window_ctl`, `media`, or the sync worker, then `app.emit(...)` so other windows refresh.

Tests in `tests/frontend.test.ts` enforce a **1-to-1 IPC contract**: every registered command must be invoked from the frontend, and every `invoke("...")` must exist on the Rust side.

Engineering rules for this boundary (no blocking the async runtime, path validation, lock discipline) are in [`quality-pipeline.md`](quality-pipeline.md).

## Rust backend layout

| Module | Job |
| --- | --- |
| `commands.rs` | IPC surface |
| `notes/` | SQLite + sync |
| `window_ctl/` | Composer, pin windows, snap, stack, drag/resize |
| `tray.rs` | Tray icon + menu |
| `shortcuts.rs` | Global hotkeys persisted in SQLite `meta` |
| `mouse_hook.rs` | Mouse4/Mouse5 (macOS/Windows; no-op on Linux) |
| `media.rs` | Save/reveal attachments, sniff types, path safety. Paste and TIFF conversion live in `media/clipboard.rs` |
| `auth.rs` | One-time copy of an old keychain token into SQLite |
| `state.rs` | Process-wide `AppState` |
| `error.rs` | `AppError` for IPC |

`AppState` holds the shared `Db`, media directory, `reqwest` client, sync job sender, and UI flags (`shown`, `pinned_mode`, flush generation counters).

## SQLite (local source of truth)

Opened at `{app_data_dir}/memose.db` in `notes::Db::open`. The wrapper is `Arc<Mutex<Connection>>` (`rusqlite`, bundled SQLite).

Three tables, created idempotently:

- **`notes`** — content, timestamps, `sync_state`, `remote_name`, pin geometry, look, audience, stack host
- **`meta`** — key/value: `base_url`, `access_token`, theme, default visibility/space, shortcuts, snap flag, space catalog JSON
- **`media_uploads`** — maps local `memose-media/<name>` files to remote attachment names

Extra note columns are added with `ensure_column` (`PRAGMA table_info` then `ALTER TABLE ... ADD COLUMN`) so old databases upgrade in place.

### Note lifecycle (`sync_state`)

| State | Meaning |
| --- | --- |
| `draft` | Unsaved composer text; empty content deletes it |
| `local` | Saved, no server configured |
| `pending` | Queued to push |
| `synced` | Matches server |
| `remote` | Stub from the server index; body fetched on open (`materialize`) |
| `conflict` | Both sides changed; UI shows Keep this / Use server |
| `error` | Last push failed (`last_error`) |

Composer flow: typing → `upsert_draft` → hide/flush → `finalize_composer` / `commit_note` → `pending` or `local` → sync worker.

Edits of an already-synced note set `base_content` (last known server body) and `sync_state = pending`.

## Sync (useMemos, offline-first)

HTTP stays in `src-tauri/src/notes/sync.rs`. JSON parsers and request bodies live in `notes/sync/parse.rs`. A background Tokio task owns an `mpsc` of `Job`s:

- `Cycle` — debounce 400ms, coalesce extras, then `run_cycle`
- `Materialize(id)` — fetch a `remote` stub's full body + attachments
- `KeepLocal(id)` — conflict: push local over server

`request_sync` is called on launch, after saves, and after settings changes.

A cycle (`drain`):

1. No-op unless `meta.base_url` and `access_token` exist
2. Detect/store API flavor (`Latest` `/api/memos` vs `V1` `/api/v1/memos`)
3. About every 20s: list remote memos + spaces (`refresh_index` / `refresh_spaces`)
4. Push every `pending`/`error` note (create or PATCH), then upload attachments
5. Emit `notes-changed` / `spaces-changed` if anything moved

**Pull vs conflict** (`remote_change`): if the server timestamp advanced and local text still equals `base_content`, pull; if the user also edited, mark `CONFLICT` and keep both `content` and `remote_content`.

**Media split:** local markdown uses `memose-media/<name>`. Sync strips those tokens for the remote body (`media::content_for_remote`), uploads binaries, and re-merges them on pull. Files sit in `$APPDATA/media/` and are served through Tauri's `asset:` protocol.

Tokens used to live in the OS keychain; `auth.rs` copies a leftover token into `meta.access_token` once, then SQLite is the store.

## Native shell: windows, tray, shortcuts

1. **One hidden `main` window** is declared in `tauri.conf.json` (frameless, transparent, always-on-top, off-screen). It is the composer, not a normal document window.
2. **Tray** (`tray.rs`): left-click shows the composer at the tray/cursor; menu has Show, Auto organize, Settings, Launch at login, Quit.
3. **Global shortcuts** (Tauri plugin): new memo / toggle pinned. Side buttons go through `mouse_hook.rs`.
4. **Pinned memos** are extra WebViews of the same `index.html?pin=<id>`, label `pin-<uuid>`, with an init script setting `__memosePin`. Geometry is stored on the note row (`win_x` / `win_y` / `win_w` / `win_h`).
5. **Settings** is a separate `settings.html` window.
6. **Window chrome** (move from anywhere, edge snap, stack-on-drop, fold, corner resize) is native code in `window_ctl/`, driven by IPC from `stack.ts` / `main.ts`.
7. **macOS** stays an accessory app until a pin/settings window needs focus; hiding calls `[NSApp hide:]` so the previous app gets keyboard back.

Platform-specific rules for WebView, clipboard, DPI, and Wayland are in [`quality-pipeline.md`](quality-pipeline.md).

## Data flow for a typical memo

```
User types in #blocks
    → serializeBlocks() in main.ts
    → invoke("upsert_draft" | "save_edit" | "commit_note")
    → commands.rs → notes::Db (SQLite)
    → request_sync(app)
    → sync worker HTTP to useMemos
    → emit("notes-changed")
    → all open WebViews refresh recent list / pinned body
```

HTML is the component tree, `src/*.ts` is UI logic, `commands.rs` is the API, `notes/db.rs` is persistence, `notes/sync.rs` is the network, and `window_ctl` is the desktop shell. The frontend is a view layer over a Rust app that owns windows, files, and the database.
