# Memose

A desktop tray post-it app for quick Markdown notes, built with **Rust** and **Tauri v2**. Notes are saved locally in SQLite first and optionally synced with a self-hosted [useMemos](https://www.usememos.com/) server.

## Features

- **Tray & Global Quick Capture**: Open a fresh memo beside the tray icon or at the cursor from any app; switch back and forth between a new draft and your last edited note.
- **Pinned & Stacked Memos**: Pin notes so they float on screen across app switches, snap memos to screen and neighbor edges, auto-organize pinned memos into a grid from the tray menu, or drop a memo onto another to stack them together (and fold/unfold or detach individual sections).
- **Markdown & Media Editor**: Write in Markdown with a formatting toolbar (bold, italic, headings, task lists, inline/fenced code), interactive checkboxes, undo/redo history, and instant preview toggle. Paste or drag-and-drop images, videos, audio, and file attachments with inline or block layout and drag-to-resize.
- **Per-Note Look & Theme**: Customize light/dark mode, paper hue with saved color swatches, and card transparency (per memo or across all pinned memos).
- **Offline-First useMemos Sync**: Automatically detects `Latest` vs. `V1` useMemos APIs, syncs note bodies, visibility (`Private`, `Protected`, `Public`, or workspace `Space`), and attachments, and provides side-by-side conflict resolution when a memo changes in both places.

## Default Shortcuts & Gestures

All shortcuts and the on-memo gesture modifier can be customized in **Settings** (including multi-shortcut bindings and mouse side buttons such as `Alt+Mouse4`).

| Action | macOS | Windows / Linux |
| :--- | :--- | :--- |
| **New memo** (or toggle last edited note) | `Cmd+Opt+N` | `Ctrl+Alt+N` |
| **Toggle pinned memos** (keep visible across apps) | `Cmd+Opt+P` | `Ctrl+Alt+P` |
| **Toggle Markdown preview** | `Cmd+Enter` | `Ctrl+Enter` |
| **Hide memos** | `Escape` | `Escape` |
| **Random paper hue** | `Opt+Enter` | `Alt+Enter` |
| **Move memo from anywhere on card** | Hold `Opt` + drag | Hold `Alt` + drag |
| **Adjust memo transparency** | Hold `Opt` + scroll | Hold `Alt` + scroll |
| **Adjust all pinned memos' transparency** | Hold `Opt+Cmd` + scroll | Hold `Alt+Win` + scroll |

## Development & Quality Pipeline

**Prerequisites:** Node.js `>=20.19.0` and a Rust toolchain (`rustup`).

```bash
npm install
npm run check
npm run tauri dev
```

### Scripts

- `npm run tauri dev` — Start the app in development mode.
- `npm run check` — Run the full quality gate: version sync, strict TypeScript typecheck (`tsc`), Vite bundle build, frontend unit & Tauri IPC contract tests (`node --test`), Cargo Clippy (`-D warnings`), and Rust backend unit tests (`cargo test`).
- `npm test` — Run both frontend (`npm run test:ts`) and Rust (`npm run test:rust`) test suites.
- `npm run test:ui` — Playwright functional UI tests against the Vite frontend with a mocked Tauri IPC harness (`npx playwright install chromium chromium-headless-shell` once). Not part of `npm run check`.
- `npm run test:scale` — Chromium CDP memory/DOM scale tests plus the ignored 10k-memo SQLite stress test. See [`docs/ui-test-plan.md`](docs/ui-test-plan.md).
- `npm run lint:rust` — Run `cargo clippy --all-targets -- -D warnings`.
- `npm run release` — Synchronize versions from `package.json` (`version` is the single source of truth) and build installable release bundles for the host platform (or explicit `--target <triple>`) into `release/<platform>/`.

### GitHub Actions Release Pipeline

- **CI (`.github/workflows/ci.yml`)**: Runs `npm run check` across Linux (`ubuntu-22.04`), macOS (`macos-latest`), and Windows (`windows-latest`) on every push to `main` and pull request.
- **Release (`.github/workflows/release.yml`)**: Triggered by pushing a `v*` tag (e.g. `git tag v1.0.0 && git push origin main --tags`) or manually via **Actions -> Release -> Run workflow**. Builds installers for macOS (`aarch64` & `x64` `.dmg`), Windows (`x64` `-setup.exe` & `.msi`), and Linux (`x64` `.deb`, `.rpm`, & `.AppImage`), generates `SHA256SUMS.txt`, and publishes the GitHub Release.

See [`docs/quality-pipeline.md`](docs/quality-pipeline.md) for architecture guardrails, Tauri IPC rules, and platform-specific notes for macOS, Windows, and Linux.
