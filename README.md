# Memose

A tray post-it for quick notes. Notes are saved locally. When a useMemos server URL and access token are set, new notes are pushed as private memos.

```bash
npm install
npm run tauri dev
```

Node 20.19 or newer is required. The tray icon shows pinned memos. Cmd+Alt+N on macOS (Ctrl+Alt+N elsewhere) starts a new memo at the cursor. Cmd+Alt+P shows pinned memos, and a second press hides them. Escape hides them. Cmd+Enter (Ctrl+Enter elsewhere) switches the note between writing and preview. Hold Alt to drag a memo from anywhere on the card. Quit from the tray menu.
