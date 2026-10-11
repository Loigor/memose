# Memose

A tray post-it for quick notes. Notes are saved locally. When a useMemos server URL and access token are set, new notes are pushed as private memos.

```bash
npm install
npm run tauri dev
```

Node 20.19 or newer is required. Clicking the tray icon opens a new memo beside it and shows pinned memos; switching to another app hides them. Cmd+Alt+N on macOS (Ctrl+Alt+N elsewhere) starts a new memo at the cursor, and pressing it again switches between that new memo and the last edited note. Cmd+Alt+P keeps pinned memos visible across app switches, and a second press hides them. Escape hides them. Cmd+Enter (Ctrl+Enter elsewhere) switches the note between writing and preview. Hold Alt to drag a memo from anywhere on the card. Quit from the tray menu.
