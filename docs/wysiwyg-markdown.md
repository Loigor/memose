# WYSIWYG markdown (possible future)

Status: not scheduled. Plain markdown stays the default editor.

A formatted editing mode is possible later. The mode that fits memose is a live preview over the markdown string already stored and synced. A rich-text document that exports markdown on save does not fit, because sync and conflict handling compare that string.

## What the app stores today

A note is a markdown string in SQLite. Drafts, edits, and publish all send that string (`scheduleDraft` in `src/main.ts`, `content` in `src-tauri/src/notes`). When a useMemos server is configured, the same string is the memo body. A push longer than 8,192 characters is rejected.

The card editor splits that string into textareas around `![](memose-media/…)` blocks. Cmd+Enter (Ctrl+Enter elsewhere) switches to a read-only preview rendered with `marked` (GFM, breaks) and sanitized with DOMPurify. Frontend dependencies are `@tauri-apps/api`, `marked`, and `dompurify`.

Each pinned memo is its own Tauri webview (`pin-` plus the note id in `src-tauri/src/window_ctl.rs`). JavaScript heaps are not shared across those windows.

Any future editor has to:

- Leave the saved string equal to what the user typed, including list markers and blank lines.
- Keep working for notes that contain memose media paths.
- Stay off the startup path of a window that is still in plain mode.
- Stay small. The webview is already the expensive part. Diagram, math, and syntax-highlighter runtimes are not.

## Assessment

### Marko

[Marko](https://github.com/SeanPedersen/Marko) is a SvelteKit Tauri markdown app. Its “WYSIWYG” is CodeMirror 6. The buffer stays markdown. `src/lib/components/codemirror/livePreview.ts` (2,890 lines) hides syntax on quiet lines and paints headings, emphasis, links, images, tables, and task checkboxes. Clicking a checkbox replaces the `[ ]` / `[x]` span in the source. The line being edited stays raw. That is the same idea as Obsidian live preview, and it is the right document model for memose.

Marko itself should not be ported. The app pulls Svelte, wiki links, kanban, and editable tables. `livePreview.ts` statically imports KaTeX (about 77 KB gzip) and Mermaid (published chunks of 109 KB and 134 KB gzip before cytoscape and the diagram parser). Bundle figures are from bundlephobia for the versions in Marko’s `package.json` (CodeMirror view 6.39, lang-markdown 6.5, mermaid 11.12, KaTeX 0.16). The stock `@codemirror/lang-markdown` bundle, including its dependency tree, is about 165 KB gzip. That number already includes the view and the parser.

`LICENSE` is BSD-3-Clause (Alec Ames, Sean Pedersen). `package.json` says MIT. The license file is the one that would apply if source were copied. A short decoration plugin written for memose avoids carrying that license for a file that would mostly be deleted.

One detail is worth keeping: Marko calls `drawSelection()` because WKWebView can freeze the native caret. Tauri on macOS uses that webview.

### StackEdit

[StackEdit](https://stackedit.io/) is a different product from the one its homepage still describes.

The site (copyright 2013–2019) presents PageDown formatting buttons, a live preview with scroll sync, GitHub-flavored markdown, LaTeX, UML diagrams, ABC musical scores, and emoji. PageDown, the editor used by Stack Overflow, inserts markdown from a toolbar. It does not hide syntax in the typing surface.

The current source ([benweet/stackedit](https://github.com/benweet/stackedit) v5.15.4, Apache-2.0) matches that split layout and goes further:

- The typing surface is [cledit](https://github.com/benweet/stackedit/tree/master/src/services/editor/cledit), a contenteditable whose text is still markdown, highlighted with Prism per section (`editorSvc.js`).
- PageDown is still wired in, as the toolbar and shortcuts that insert markdown into that contenteditable.
- A second pane renders HTML with markdown-it. Section diffs use diff-match-patch so only changed sections refresh, and section heights drive scroll sync.
- Dependencies include Vue 2, Vuex, markdown-it and a pile of plugins, Prism, KaTeX, Mermaid, and abcjs. `turndown` is present for HTML-to-markdown conversion, which is the lossy direction.

That is a desktop writing app with two scrolling columns. Memose already has the cheap version of the preview half: one card, `marked`, and a shortcut. A scroll-synced second pane does not fit a post-it, and the Vue 2 stack is the wrong runtime to adopt. StackEdit confirms the toolbar idea (buttons that wrap the selection in `**` or insert `- [ ]`) and does not offer a lighter single-surface editor.

### Editors that own a rich-text document

TipTap, ProseMirror, Milkdown, Lexical, MDXEditor, Toast UI, and Vditor parse markdown into their own model and serialize on save. Serialization rewrites markers (`*` versus `-`, `**` versus `__`) and blank lines. The stored note then differs from what was typed, and sync can treat that as a local edit against the server. Several of them also require React or another framework. A `contenteditable` filled from `marked` has the same trip back to markdown, plus caret and sanitizing bugs.

## If this is built later

Two slices, in order. Either can ship alone.

### 1. Task gutter

Keep the textarea. Lines that are `- [ ]` or `- [x]` get a checkbox. Clicking it rewrites the marker and goes through the existing draft timer. Inserting a task can be a shortcut or a small button. No new dependency. This is the whole request if the goal is “easier task lists.”

### 2. Optional live preview

One CodeMirror 6 view per memo window, loaded with a dynamic import only when the mode is on. `onchange` writes `noteContent` and calls `scheduleDraft`. External updates (open note, conflict resolution) patch the changed range so the caret stays put.

Include:

- Task checkbox widget.
- Heading and emphasis marks. Bullet markers hidden off the active line.
- Image widget for `![](memose-media/…)`, using the existing `media_path` command and `convertFileSrc`, so this mode does not need the split textareas.
- `drawSelection()` for the WKWebView caret.

Leave out: Mermaid, KaTeX, highlight.js, `@codemirror/language-data`, editable tables, wiki links, a search panel, and HTML blocks. Those are most of Marko’s plugin and the source of its decoration bugs during drag and table-cell edits.

Plain typing stays the default. Live preview is a setting, or another state beside the existing preview shortcut. The read-only preview can stay for glancing at a note without a caret.

## Out of scope

- Replacing the textarea for everyone.
- Vendoring Marko or StackEdit, or adding Svelte or Vue.
- Math, diagrams, scores, or a second preview column.
- Any editor whose save path normalizes markdown.
