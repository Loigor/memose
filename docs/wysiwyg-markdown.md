# WYSIWYG markdown

Status: this is the normal editor. Preview and the coder editor stay as they are.

The typing surface is the markdown string already stored and synced. A rich-text document that exports markdown on save does not fit, because sync compares that string.

## What the app stores

A note is a markdown string in SQLite. Drafts, edits, and publish all send that string (`scheduleDraft` in `src/main.ts`, `content` in `src-tauri/src/notes`). When a useMemos server is configured, the same string is the memo body. A push longer than 8,192 characters is rejected.

Each pinned memo is its own Tauri webview. JavaScript heaps are not shared across those windows. Media paths `![](memose-media/…)` stay in the string.

The saved string must stay equal to what was typed, including markers and blank lines. Nothing in this editor rewrites `*` versus `-` or `**` versus `__`.

## The normal editor

One editing surface. Each line is a row. The row’s class comes from the line prefix, and the characters stay in the row:

- `# Title` through `######`, with a space after the hashes, is a heading. While the caret is on that line the hashes stay visible. After the caret leaves, the editor shows the title and keeps the hashes in the stored string.
- A quote, bullet, task, and rule do the same. The caret line shows the markdown, so the caret stays on a real character. When the caret leaves, a quote shows a bar, a bullet shows a dot, a task shows a checkbox, and a rule shows a line. An ordered item keeps its number. A checked task strikes the rest of the line.
- Anything else is body text. On the caret line, bold, italic, code, and link markers stay visible. On the other lines they show the rendered span. A `#tag` stays visible, including inside bold or italic. On a heading line the `#` stays part of the heading.

A fence line stays in the text until Enter, so `` ```json `` can be finished before it becomes a block. Enter lifts that line into a code block, shows the language at the top right, and highlights the code. A brace block in a code block or the coder editor folds from the gutter; the hidden lines stay in the stored text. Closing a fence or inserting a `memose-media` token still splits the note into those blocks.

The coder editor is the raw textarea, gutter, and overlay. A fenced block inside it stays a coder field: the note’s line numbers continue through that block, and the block adds its own gutter in the code color, indented beside them, with a line between the two columns. The language name floats on the block’s top line and does not widen the gap between the columns. Double-click a line number to mark that line; click it again, or clear the line, to remove the mark. Enter in a code block or the coder editor keeps the previous line’s indent. Whitespace size in settings is how many characters one indent is. Preview is still the read-only `marked` view. The normal editor is the default. “Coder editor default” in settings still chooses the textarea instead. Turning coder mode on or off rebuilds the surface once. A color change does not.

### Why rows

One textarea cannot paint two font sizes on one grid, which is why the caret sat off the character: the overlay and the textarea were different boxes. One textarea per line makes a selection across lines impossible and turns every Enter into a block split. A row inside one `contenteditable` is still one selection. The caret is in the text it is editing, because that text is the row.

### Long notes

A memo with more than a thousand lines must not slow the editor or the app.

- A keystroke updates the edited row’s class and, when the marks on a row no longer match its text, that row’s spans. It does not rebuild the note, and it does not run `highlightMarkdown`.
- Reading the rows back into the stored string on each edit is fine.
- The first paint of about a thousand simple rows is fine. Windowing waits until that paint is actually slow.
- Paste, or a row list the browser broke, is repaired from the plain text of that edit. Enter that continues a task list, Tab, a closed fence, and the format toolbar still replace the string in one step.

### Keys

Enter at the end of a task line continues the list, and that finished line renders as a checkbox. Tab still indents markdown. Arrow keys move inside the rows, and at the edge of the block they move to the previous or next text or code field. Backspace at the start of a line joins it with the line above. Backspace in an empty code block removes that block and leaves the caret where the block started. Backspace at the start of a nonempty text or code field moves the caret to the end of the previous field. Backspace before a media block still removes that media.

Bold and Italic wrap the selection. Title, List, Numbered, Task, Quote, and Code block set the line, replacing a marker that is already there. The caret line shows those characters. The other lines hide them and show the rendered span. A keystroke paints after the browser has applied the character, so the style sticks on the first memo.

## Not in this pass

- CodeMirror, TipTap, ProseMirror, Milkdown, Lexical, or any editor that serializes its own document.
- Mermaid, KaTeX, Shiki, Highlight.js, or a second preview column.

CodeMirror’s live preview hides syntax and is a large runtime. The rich-text editors rewrite markers on save, so a sync would see an edit the user did not type.
