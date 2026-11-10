<div align="center">

# Memose

Sticky notes that live in your tray.  
Capture, pin, and stack Markdown memos without leaving the desktop.

[![CI](https://github.com/Loigor/memose/actions/workflows/ci.yml/badge.svg)](https://github.com/Loigor/memose/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Loigor/memose)](https://github.com/Loigor/memose/releases/latest)
![macOS, Windows, Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-informational)

</div>

<div align="center">

![Memose demo](docs/demo.mp4)

</div>

Memose is a desktop post-it app: a global quick-capture composer, always-on-top pinned memos, and stacks you can fold away. Notes are Markdown, stored locally in SQLite, and can optionally sync with a self-hosted [useMemos](https://www.usememos.com/) server.

## Highlights

- **Tray capture** — Open a fresh memo beside the tray or at the cursor. Flip between a new draft and the last note you edited.
- **Pinned stacks** — Pin memos so they float across apps. Snap to screen and neighbor edges, grid them from the tray, or drop one memo onto another to stack. Fold, peek, and detach sections without changing the collapsed mode.
- **Markdown & media** — Formatting toolbar, task lists, fenced code, undo/redo, and instant preview. Paste or drop images, video, audio, and files; resize inline.
- **Look** — Light/dark, paper hue with saved swatches, and per-memo or all-pinned transparency.
- **Pinned-mode tabs** — Group pinned desks (Work, Home, …) on a hairline strip at the top of the screen.
- **Offline-first sync** — Speaks useMemos `Latest` and `V1`. Syncs body, visibility (`Private`, `Protected`, `Public`, or workspace `Space`), and attachments, with side-by-side conflict resolution.

## Install

Download the latest build from [Releases](https://github.com/Loigor/memose/releases/latest).

| Platform | Artifact |
| :--- | :--- |
| macOS | `.dmg` (Apple Silicon and Intel) |
| Windows | `-setup.exe` and `.msi` |
| Linux | `.deb`, `.rpm`, and `.AppImage` |

Checksums ship as `SHA256SUMS.txt` on each release.

## Shortcuts

All shortcuts and the on-memo gesture modifier can be changed in **Settings**, including multi-key chords and mouse side buttons (`Alt+Mouse4`).

| Action | macOS | Windows / Linux |
| :--- | :--- | :--- |
| **New memo** (or toggle last edited note) | `Cmd+Opt+N` | `Ctrl+Alt+N` |
| **Toggle pinned memos** | `Cmd+Opt+P` | `Ctrl+Alt+P` |
| **Toggle Markdown preview** | `Cmd+Enter` | `Ctrl+Enter` |
| **Hide memos** | `Escape` | `Escape` |
| **Random paper hue** | `Opt+Enter` | `Alt+Enter` |
| **Move memo from anywhere on the card** | Hold `Opt` + drag | Hold `Alt` + drag |
| **Adjust memo transparency** | Hold `Opt` + scroll | Hold `Alt` + scroll |
| **Adjust all pinned memos** | Hold `Opt+Cmd` + scroll | Hold `Alt+Win` + scroll |

## Development

**Requires** Node.js `>=22` and a Rust toolchain (`rustup`).

```bash
npm install
npm run check
npm run tauri dev
```

| Script | What it does |
| :--- | :--- |
| `npm run tauri dev` | Run the app |
| `npm run check` | Version sync, `tsc`, Vite build, frontend tests, Clippy, Rust tests |
| `npm test` | Frontend (`npm run test:ts`) and Rust (`npm run test:rust`) |
| `npm run test:ui` | Playwright UI tests against Vite with a mocked Tauri IPC harness. Install browsers once: `npx playwright install chromium chromium-headless-shell`. Not part of `npm run check`. |
| `npm run demo:record` | Re-record `docs/demo.mp4` (Playwright + ffmpeg) |
| `npm run test:scale` | Chromium memory/DOM scale tests plus the ignored 10k-memo SQLite stress test. See [`docs/ui-test-plan.md`](docs/ui-test-plan.md). |
| `npm run release` | Sync versions from `package.json` and build installers into `release/<platform>/` |

### CI

- **CI** (`.github/workflows/ci.yml`) — `npm run check` on Linux, macOS, and Windows for every push to `main` and every pull request.
- **Release** (`.github/workflows/release.yml`) — Push a `v*` tag (`git tag v1.0.2 && git push origin v1.0.2`) or run **Actions → Release**. Builds macOS `.dmg`, Windows `.exe`/`.msi`, and Linux `.deb`/`.rpm`/`.AppImage`, then publishes the GitHub Release.

Architecture, IPC rules, and platform notes: [`docs/architecture.md`](docs/architecture.md) and [`docs/quality-pipeline.md`](docs/quality-pipeline.md).
