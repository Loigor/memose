# Refactor plan

Structure only. No UX, copy, or IPC changes in these steps. Each step moves one ownership boundary, stays buildable, and is checked with the same tests before the next one starts.

Page entries stay where the HTML files load them: `src/main.ts`, `src/settings.ts`, `src/pin-tabs.ts`, `src/styles.css`, `src/settings.css`, `src/pin-tabs.css`.

## What is already in good shape

- Tauri v2 layout matches the project rules: `main.rs` only calls `memose_lib::run()`, commands are registered in `generate_handler!`, and `AppError` is a `thiserror` enum that serializes across IPC.
- Rust is already split by job (`notes/`, `window_ctl/geom.rs`, `commands.rs`, `media.rs`, `tray.rs`). `Db` uses short mutex scopes and poison recovery.
- Frontend behavior already lives in modules, not one script. Markdown transforms, shortcuts, and theme math are pure enough for `node --test`.
- `unwrap` / `expect` in `notes/db.rs` are inside `#[cfg(test)]`. Production window code does not panic that way.

Do not add a UI framework. HTML stays the component tree.

## Problems, in the order they should be fixed

| Problem | Where | Why it matters |
| --- | --- | --- |
| Flat frontend tree | `src/*.ts` beside the page entries | The next file split has nowhere to land, and a new module looks the same as an app entry. |
| IPC test assumes that flat tree | `tests/frontend.test.ts` listed only `src/*.ts` | A file moved into a folder would drop its `invoke()` calls out of the contract check. Fixed in step 1. |
| God files | `window_ctl/mod.rs` (3033), `main.ts` (2773), `stack.ts` (2341), `styles.css` (2027), `notes/db.rs` (1915), `notes/sync.rs` (1831), `media.rs` (1035) | A change to drag, sync, or the editor requires reading an unrelated half of the file. |
| Two block renderers | `renderBlocks` in `main.ts`, `renderSectionBlocks` in `stack.ts` | Same media-row idea, different details (composer placeholder, host state vs section state). Merge only after a line-by-line diff, in its own step. |
| One stylesheet, no sections | `src/styles.css` | Safe to split only by cutting rules into files that `styles.css` imports in today's order. |

`commands.rs` (760 lines) stays the IPC surface. Splitting it does not make the app easier to follow.

## Rules for every remaining step

1. Move or extract. Do not change what the user sees, what SQLite stores, or which command names exist.
2. One boundary per step. Stop while `npm run test:ts` passes. Rust steps also run `npm run lint:rust` and `npm run test:rust`.
3. Re-export the old public path when Rust callers use a module (`window_ctl::open_pinned` stays). Frontend callers update their imports in the same step.
4. Keep a function's error handling when it moves.
5. No new types, traits, or barrels unless a move does not compile without a parameter the code already had.
6. Do not merge the two block renderers in the same step as a file move.

## Steps

### 1. Editor folder — done

Moved, names unchanged:

- `src/editor/markdown-edit.ts`
- `src/editor/editor-blocks.ts`
- `src/editor/editor-field.ts`
- `src/editor/textarea.ts`
- `src/editor/history.ts`
- `src/editor/md-highlight.ts`

The IPC contract test now walks every `.ts` file under `src/`.

### 2. Media folder — done

Moved, names unchanged: `src/media/media-dnd.ts`, `src/media/media-elements.ts`, `src/media/files.ts`. `media-elements.ts` still calls `invoke`, and the IPC test walks every `.ts` file under `src/`.

### 3. Look and audience folder — done

Moved, names unchanged: `src/look/look.ts`, `src/look/memo-chrome.ts`, `src/look/hue-pop.ts`, `src/look/audience-ui.ts`, `src/look/visibility.ts`, `src/look/sync-status.ts`. Call sites and `tests/frontend.test.ts` import those paths.

Leave `shortcuts.ts`, `types.ts`, `platform.ts`, `dom.ts`, and `time.ts` at `src/` until a later reader actually gets lost. They are small and shared by every page.

### 4. Stylesheet, same cascade

`src/styles.css` mixes stack, header, audience, and editor rules in one cascade. Pulling every `.stack-note` rule into one file would change which rule wins. Split only into contiguous slices, imported from `src/styles.css` in today's order. Do not retune a rule. Check: `npm run test:ts` (it reads `textarea::selection` from `src/styles.css`) and a load of `index.html` in Vite.

Slices so far, imported in this order: `src/styles/shell.css` (tokens, page chrome, collapsed card, resize, stack, through `.lifting`), `src/styles/header.css` (the `header` rule through the hue controls), `src/styles/controls.css` (`.icon-button` through the block textarea sizes), then `src/styles/field.css` (`.media-row` through the base `.md-hl` rule). `styles.css` continues at `html[data-mdhl] .md-hl`. The selection rules stay in `styles.css`.

### 5. `stack.ts`, one piece at a time

The height helpers (`targetWindowHeight` through `tweenWindowHeight`) are not a closed set. They read `stackState`, `openNoteHeight`, `hostCollapsed`, and the tween timers, and `loadStack`, `paintChrome`, and resize call them back. Move that shared state with the functions. Do not add a controller type.

Extract in this order, only when the functions and their helpers move together:

1. Window height tween (`targetWindowHeight` through `tweenWindowHeight`), together with the lets it writes.
2. Section block render (`renderSectionBlocks` and the save/edit helpers it calls).
3. Chrome drag and resize (`wireChrome`, `startWindowDrag`, `startResize`).

`bindStack` and the exports `main.ts` already uses stay in `src/stack.ts`.

### 6. `main.ts`, one piece at a time

Same rule. Suggested order, smallest closed set first:

1. Recent list (`refreshRecent`, search, row paint).
2. Look paint (`paintLook`, hue slots, theme toggle).
3. Audience menu.
4. Draft persist (`scheduleDraft`, `persistDraft`, `loadDraft`).

The boot at the bottom of `main.ts` (composer vs pinned vs media preview) stays in `main.ts`.

### 7. `window_ctl`, leaves first

`geom.rs` is already the pattern: private module, re-export what `commands.rs` calls.

1. Confirm `open_media_preview` / `close_media_preview` do not call pin or drag helpers. If they don't, move them to `window_ctl/preview.rs`. If they do, skip them and do not force the split.
2. Pin-window open, place, and organize.
3. Composer present / hide / flush.
4. Drag, snap, and stack attach last. Those functions share the static maps (`dragging`, `stack_aims`, `following`). Move the maps with the functions into one `drag.rs`. Do not invent a controller type.

Check each cut with `npm run test:rust` and `npm run lint:rust`. Geometry tests already live on `geom.rs`.

### 8. `notes/db.rs` by `impl Db` blocks — done

Rust allows more than one `impl Db`. Keep `open`, `with`, schema, and `map_note` in `notes/db.rs`. Move one group per step, tests with the methods they call:

1. Space catalog. Done: `notes/db/spaces.rs` holds the catalog methods and `StoredSpace`. `Db::with` and `get_meta` stay in `db.rs`. Note writes still call `spaces::space_hue_value`.
2. Stack and pin frames. Done: `notes/db/stack.rs` holds collapse, stack links, pin flag, window frame, and `list_pinned`. `save_look` and `set_pinned_opacity` stay in `db.rs`. `map_note` and `LIST_PINNED` stay there too; the stack module calls them.
3. Sync row updates. Done: `notes/db/remote.rs` holds push completion, error/local marks, remote stubs, and conflict resolution. `RemoteLink` is re-exported from `db`. Settings, tokens, and media upload rows stay in `db.rs`.

The public `Db` methods stay on `Db`. `notes/mod.rs` re-exports do not change.

### 9. `notes/sync.rs` — done

Done: `notes/sync/parse.rs` holds the memo and space parsers, time parsing, request bodies, and `remote_change`. `RemoteChange` and `space_uid` stay reachable from `sync`. The worker (`start_worker`, `drain`) and the HTTP tests stay in `sync.rs`. Tests that call a parser import it from `super::parse`.

### 10. `media.rs` — done

Done: `media/clipboard.rs` holds `paste_clipboard` and the macOS and Windows paste implementations, plus TIFF-to-PNG conversion. `paste_clipboard` is re-exported from `media`. Path checks (`valid_name`, `resolve`) and markdown token rewrite stay in `media.rs`.

## After this plan

UX fixes are a different pass. Use the heuristics skill then, on the running app, not while files are moving.

## Skills

Already in the repo and used for this work: `ponytail`, `rust-best-practices`, `tauri-v2`. `ux-heuristics` waits for the UX pass. `caveman` fights this plan: the steps need full names and file paths.

Worth adding under `.agents/skills/` before the next step:

| Skill | Use it when |
| --- | --- |
| `safe-refactor` | Every remaining step. One boundary, same proof before and after, no feature edits mixed in. |
| `verify-and-stop` | After a step is green. Stops the session from starting the next folder "while we're here." |
| `investigate-first` | A moved file fails a test and the cause is not an import path. |
| `surgical-patch` | The UX and bug pass after step 10. One behavior change, the callers of that function, nothing else. |
| `web-design-guidelines` | Together with `ux-heuristics` when that pass reviews contrast, focus, and labels. |

Do not add `vercel-react-best-practices`. This app is vanilla TypeScript.

## Status

- [x] 1. `src/editor/` and recursive IPC scan
- [x] 2. `src/media/`
- [x] 3. `src/look/`
- [ ] 4. Stylesheet split, same cascade
- [ ] 5. `stack.ts` extracts
- [ ] 6. `main.ts` extracts
- [ ] 7. `window_ctl` leaves
- [x] 8. `Db` impl groups
- [x] 9. Sync parsers
- [x] 10. Media clipboard
