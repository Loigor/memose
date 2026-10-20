# Quality Pipeline & Rust + Tauri Desktop Engineering Guide

This document defines the mandatory quality pipeline and engineering guardrails for **Memose** as it approaches and maintains its **1.0 release**. Because the codebase is developed with AI assistance, every change must pass deterministic automated checks and adhere to strict architectural, safety, and cross-platform rules.

---

## 1. Automated Quality Pipeline (`npm run check`)

Run the full quality pipeline before every commit and release:

```bash
npm run check
```

### Pipeline Stages

1. **Version Synchronization (`node release/sync-version.mjs`)**
   - Propagates the single source-of-truth `version` from `package.json` to `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`.
2. **TypeScript Typecheck & Dead-Code Gate (`tsc`)**
   - Enforces `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, and `noFallthroughCasesInSwitch: true`.
3. **Production Frontend Bundle (`vite build`)**
   - Verifies multi-page bundling (`index.html` and `settings.html`) and asset resolution.
4. **Frontend Unit & IPC Contract Tests (`npm run test:ts`)**
   - Runs `tests/frontend.test.ts` via Node's built-in test runner (`node --test`).
   - Tests pure markdown editing (`wrapText`, `applyCode`, `applyTitle`, `applyTask`, `toggleTask`, `taskListOnEnter`, `tabOnMarkdown`, `renumberOrderedLists`), media block parsing/serialization (`parseBlocks`, `serializeBlocks`, `ensureTextSlots`, `parseMediaMeta`, `mediaMarkdown`, `noteTitle`), shortcut parsing/matching (`src/shortcuts.ts`), theme chrome (`src/memo-chrome.ts`), version parity, and **1-to-1 bidirectional Tauri IPC command registration**.
5. **Rust Static Analysis (`npm run lint:rust`)**
   - Runs `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
   - Treats all Clippy warnings across library, binary, and test targets as hard errors.
6. **Rust Backend Unit & Integration Tests (`npm run test:rust`)**
   - Runs `cargo test --manifest-path src-tauri/Cargo.toml`.
   - Covers SQLite note lifecycle, draft/publish/edit transitions, stack chains, conflict detection/resolution, local HTTP mock server sync (`Latest` vs `V1` useMemos API), attachment storage/magic-byte sniffing/path traversal protection, shortcut validation, and window geometry/snapping/grid layout.
   - Does **not** run the ignored `scale_stress_*` SQLite test (see below).

### Optional UI & scale suites (not in `npm run check`)

These are slower, browser- and load-oriented, and run only when asked. Full matrix, budgets, and harness notes: [`docs/ui-test-plan.md`](ui-test-plan.md).

```bash
npx playwright install chromium chromium-headless-shell
npm run test:ui          # Playwright functional UI
npm run test:scale       # Playwright @scale memory/DOM + ignored 10k SQLite test
```

---

## 2. Guardrails for AI-Coded Rust & Tauri Applications

### 2.1 Tauri IPC & Command Boundary Discipline

- **1-to-1 IPC Contract Enforcement**: Every `#[tauri::command]` registered in `tauri::generate_handler![...]` (`src-tauri/src/lib.rs`) must be actively used by the frontend (`src/main.ts` or `src/settings.ts`), and every frontend `invoke("...")` call must match a registered command. Because `generate_handler!` references command functions, Rust's `dead_code` lint will not catch unused Tauri commands—`tests/frontend.test.ts` enforces this automatically.
- **Never Block the Async Runtime**: Any command or worker performing synchronous disk I/O or heavier SQLite work inside an `async fn` must offload blocking work via `tokio::task::spawn_blocking` (or `db_call`).
- **`tauri::State<'_, T>` is a Reference Wrapper, Not a Lock Guard**: Never call `std::mem::drop(state)` on `tauri::State<'_, AppState>` (flagged by `clippy::drop_non_drop`). Only drop explicit `MutexGuard` values when you need to release a lock before an `.await` or cross-thread call.
- **Path Traversal & Input Validation**: Never trust filenames or identifiers passed over IPC or downloaded from a remote server. Always validate attachment names through `media::valid_name` / `media::resolve` (rejecting `..`, `/`, `\`, leading dots, or non-ASCII-alphanumeric characters) before touching the filesystem.

### 2.2 Concurrency, State & Lock Discipline

- **Keep `Mutex` Critical Sections Short and Synchronous**:
  - Never hold a `std::sync::MutexGuard` across `.await` points, window creation, or `app.run_on_main_thread(...)` dispatches.
  - Clone the needed data (`Arc`/small structs) inside a short scope, let the guard drop, and then perform I/O or window operations.
- **Poison Recovery**: Use `.unwrap_or_else(|poisoned| poisoned.into_inner())` on `std::sync::Mutex` locks so a recoverable panic on one thread does not permanently brick the app state.
- **Generation Counters for Async UI Flows**:
  - Window hide/flush cycles (`state.generation`, `state.handled_flush`) and async markdown preview hydration (`previewGen`) must check generation counters after every `await` so stale async completions cannot overwrite newer user state.
- **Graph Cycle Defense**:
  - Linked structures stored in SQLite (such as stacked memos via `stack_under`) must always guard traversal (`stack_root_id`, `chain_after`) with a `HashSet<String>` of visited IDs and a depth cap (`STACK_LIMIT`) to prevent infinite loops on corrupted data.

### 2.3 SQLite & Offline-First Sync Invariants

- **Idempotent Schema Migrations**: Every schema change in `src-tauri/src/notes/db.rs` must use `CREATE TABLE IF NOT EXISTS` or `ensure_column` (`PRAGMA table_info(...)` check before `ALTER TABLE ... ADD COLUMN`) so existing user databases upgrade seamlessly without data loss.
- **Local vs. Remote Media Separation**:
  - Local markdown uses `![](memose-media/<name>)` and `[label](memose-media/<name>)` tokens.
  - When syncing to useMemos, strip local media tokens from the remote text (`media::content_for_remote`), upload binary attachments via the server's attachment/resource endpoints, and re-merge local media references (`merge_local_media`) when pulling remote updates.
- **Explicit Conflict Preservation**: If a note has unsaved/pending local edits (`local_dirty = 1` or `sync_state = PENDING`) and the remote server timestamp advances with different content, transition the note to `CONFLICT` (`server_content` preserved alongside `content`) rather than silently overwriting either side.

### 2.4 Frontend DOM, Security & CSS Hygiene

- **Zero Raw HTML Interpolation of Untrusted Strings**:
  - Always sanitize markdown HTML with `DOMPurify.sanitize(html)` before assigning to `.innerHTML`.
  - Never interpolate filenames, note titles, or user labels into `.innerHTML` template strings—always create the element and assign `.textContent` (prevents DOM XSS via crafted attachment filenames).
- **Pure Logic Extraction**:
  - Keep markdown transformations (`src/markdown-edit.ts`), shortcut matching (`src/shortcuts.ts`), and theme palette math (`src/memo-chrome.ts`) free of top-level DOM side effects so they remain directly testable under `node --test`.
- **DOM Event Bubbling Guards**:
  - In `dragleave` handlers on container elements (`#card`, `.stack-note`), check `event.relatedTarget instanceof Node && container.contains(event.relatedTarget)` before removing `.dropping` classes to prevent flicker when dragging over child elements.
  - Exclude interactive controls (`a, input, img, video, audio, .media-audio, .file-attachment, button`) from drag-start and double-click preview-toggle handlers.
- **No Dangling CSS or Exports**:
  - When removing or refactoring a UI feature, remove its CSS rules from `src/styles.css` / `src/settings.css` and unused helper functions in the same change.

---

## 3. Platform-Specific Exceptions & Special Cases

Desktop WebView runtimes and window managers differ significantly across **macOS**, **Windows**, and **Linux**. Follow these platform rules whenever touching `window_ctl.rs`, `media.rs`, `mouse_hook.rs`, `shortcuts.rs`, or frontend input handling:

### 3.1 macOS (`WKWebView` / AppKit / CoreGraphics)

1. **Objective-C FFI Requires `NSAutoreleasePool` on Background Threads**:
   - Tauri IPC commands execute on worker threads that do not drain an AppKit run-loop autorelease pool automatically.
   - Any Objective-C FFI call (`NSData`, `NSBitmapImageRep`, `NSPasteboard`, `NSString`, `NSURL` in `src-tauri/src/media.rs`) **must** be wrapped in an RAII `AutoreleasePool` (`objc_autoreleasePoolPush` / `objc_autoreleasePoolPop`) so temporary image buffers and pasteboard objects are freed immediately when the function returns.
2. **Accessory Activation Policy & Focus Restoration**:
   - Memose runs with `ActivationPolicy::Accessory` (`LSUIElement` behavior) so it stays in the menu bar without cluttering the Dock.
   - When hiding all Memose windows (`hide_window` / `hide_all` in `window_ctl.rs`), macOS does not automatically return keyboard focus to the previously active app unless `[NSApp hide:nil]` is invoked after all app windows are hidden.
3. **AppKit Thread Affinity**:
   - Constructing or mutating `NSWindow` / `WebviewWindow` properties on macOS must happen on the main thread (`app.run_on_main_thread(...)`).
4. **Pasteboard Formats (`TIFF` & File URLs)**:
   - macOS screenshots and copied images often place `public.tiff` data on `NSPasteboard` rather than PNG, and Finder file copies use `NSFilenamesPboardType` / `public.file-url` (which `WKWebView`'s JS `ClipboardEvent.clipboardData.files` often omits).
   - Keep the native `paste_clipboard_macos` fallback and `tiff_to_png` (`NSBitmapImageRep`) conversion intact.
5. **Global Side-Button Mouse Hooks (`CGEventTap`)**:
   - macOS can disable a `CGEventTap` if the system is briefly under heavy load (`kCGEventTapDisabledByTimeout`). The callback in `mouse_hook.rs` must listen for timeout/user-input disable events and call `CGEventTapEnable(tap, true)`.

### 3.2 Windows (`WebView2` / Win32 / DWM)

1. **`WebView2` Window Creation Deadlock**:
   - Calling `WebviewWindowBuilder::build()` synchronously inside a Tauri IPC command handler or UI thread callback on Windows can deadlock `WebView2` COM initialization (`open_media_preview`, `open_pin`).
   - Always spawn `WebviewWindowBuilder::build()` onto a background thread (`std::thread::spawn`) on Windows.
2. **System Clipboard Lock (`OpenClipboard` / `CloseClipboard`)**:
   - Win32 `OpenClipboard` locks the clipboard for the entire OS session until `CloseClipboard` is called.
   - Always wrap `OpenClipboard` in an RAII guard (`ClipboardGuard` in `media.rs`) so `CloseClipboard()` is guaranteed to run on every exit path.
3. **Frameless Transparent Windows & Mouse Button Swapping**:
   - Custom drag and resize loops polling `GetAsyncKeyState(VK_LBUTTON)` must check `GetSystemMetrics(SM_SWAPBUTTON)` so users with left-handed mouse configurations can drag and resize memos normally.
4. **Per-Monitor DPI Scaling**:
   - Windows monitors frequently run at fractional scales (`125%`, `150%`, `175%`). Always multiply logical card padding (`CARD_PAD_X`, `CARD_PAD_TOP`, `CARD_PAD_BOTTOM`) and snap catch thresholds by `window.scale_factor()` when converting between logical CSS pixels and physical screen coordinates.

### 3.3 Linux (`WebKitGTK` / X11 / Wayland)

1. **Wayland vs. X11 Positioning & Global Hooks**:
   - Wayland compositors restrict applications from reading global cursor coordinates, positioning top-level windows at arbitrary global `(x, y)` coordinates, or installing unprivileged global mouse hooks (`mouse_hook.rs` is a safe no-op stub on Linux).
   - Window placement (`cursor_position()`, `outer_position()`) must always handle `Err` gracefully and fall back to work-area clamping or compositor-managed placement.
2. **Tray Icon Geometry Fallback**:
   - On Linux (`libayatana-appindicator` / StatusNotifierItem), tray click events may not report a non-zero icon rectangle. `tray_card_origin` and `show_from_tray` must fall back to cursor/work-area placement when tray bounds are unavailable.
3. **File Manager Reveal (`reveal_media` / `open_media_file`)**:
   - Unlike macOS (`open -R`) and Windows (`explorer /select,`), Linux desktop environments vary; `reveal_media` opens the parent directory via `xdg-open` and `open_media_file` opens the file via `xdg-open`.

---

## 4. Release Checklist & GitHub Release Pipeline

Before cutting a release:

- [x] Bump `"version"` in `package.json` (currently `"1.0.0"`).
- [x] Run `npm run check` and confirm zero TypeScript errors, zero Clippy warnings, and 100% passing frontend + Rust tests.
- [ ] Verify main composer flow: create draft, markdown toolbar formatting, inline & block media paste/drop/resize, preview toggle (`Cmd/Ctrl+Enter`), and undo/redo (`Cmd/Ctrl+Z`).
- [ ] Verify pinned memos & stacks: pin/unpin, drag onto another memo to stack, fold/unfold headers, detach from stack, edge snapping, and grid auto-organize.
- [ ] Verify useMemos sync: probe server (`Latest` and `V1`), private/workspace visibility, attachment upload/download, and conflict resolution (`Keep local` vs `Use server`).
- [ ] Publish release via GitHub Actions (`.github/workflows/release.yml`):
  - Push tag `v1.0.0` (`git tag v1.0.0 && git push origin main --tags`) **or** trigger **Release** via `workflow_dispatch` in GitHub Actions.
  - Confirm GitHub Release includes macOS (`aarch64` & `x64` `.dmg`), Windows (`x64` `-setup.exe` & `.msi`), Linux (`x64` `.deb`, `.rpm`, & `.AppImage`), and `SHA256SUMS.txt`.
