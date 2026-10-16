# Memose

A tray post-it for quick notes. Notes are saved locally. When a useMemos server URL and access token are set, new notes are pushed as private memos.

```bash
npm install
npm run check
npm run tauri dev
```

Node 20.19 or newer is required. Run `npm run check` to execute the full quality pipeline (version sync, TypeScript check, Vite build, frontend unit/contract tests, Cargo Clippy, and Rust unit tests); see [`docs/quality-pipeline.md`](docs/quality-pipeline.md) for engineering and cross-platform guidelines. The release version is `version` in `package.json`. `npm run release` builds the installers this computer can produce and writes them to `release/` so they can be committed. Clicking the tray icon opens a new memo beside it and shows pinned memos; switching to another app hides them. Cmd+Alt+N on macOS (Ctrl+Alt+N elsewhere) starts a new memo at the cursor, and pressing it again switches between that new memo and the last edited note. Cmd+Alt+P keeps pinned memos visible across app switches, and a second press hides them. Escape hides them. Cmd+Enter (Ctrl+Enter elsewhere) switches the note between writing and preview. Hold Alt to drag a memo from anywhere on the card. Quit from the tray menu.
