import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { moveBlockMedia } from "../src/editor/editor-blocks.ts";
import { highlightMarkdown } from "../src/editor/md-highlight.ts";
import { tagAtOffset } from "../src/editor/md-tags.ts";
import { uniqueFiles } from "../src/media/files.ts";
import { BlockHistory, cloneBlocks, restorePlace } from "../src/editor/history.ts";
import { defaultLook, lookFromNote, namedTheme } from "../src/look/look.ts";
import {
  applyCode,
  applyTask,
  applyTitle,
  displayFileName,
  ensureTextSlots,
  formatDocument,
  formatJsonDocument,
  isAudio,
  isImage,
  isPreviewableMedia,
  isVideo,
  mediaMarkdown,
  noteTitle,
  parseBlocks,
  parseMediaMeta,
  renumberOrderedLists,
  serializeBlocks,
  tabOnMarkdown,
  taskListOnEnter,
  toggleTask,
  wrapText,
} from "../src/editor/markdown-edit.ts";
import { baseColors, huePopHtml, palette, paperAt, stackHeaderHtml, tabFill, themeGlyph } from "../src/look/memo-chrome.ts";
import { clampHueSwatches } from "../src/look/swatches.ts";
import { pointIn, pointOnScrollGutter, requireEl } from "../src/dom.ts";
import {
  defaultBinds,
  domMouseButton,
  eventToBind,
  eventToMouse,
  formatBind,
  isModifierKey,
  matchBind,
  matchMouse,
  modifierDown,
  mouseChordToBind,
} from "../src/shortcuts.ts";
import { syncIcon } from "../src/look/sync-status.ts";
import { exactStamp, relativeTime } from "../src/time.ts";
import { visibilityShort } from "../src/look/visibility.ts";

function walkTs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkTs(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

test("wrapText wraps selection and places cursor inside empty markers", () => {
  const wrapped = wrapText("hello world", 0, 5, "**", "**");
  assert.equal(wrapped.value, "**hello** world");
  assert.equal(wrapped.start, 2);
  assert.equal(wrapped.end, 7);

  const link = wrapText("docs", 0, 4, "[", "](url)");
  assert.equal(link.value, "[docs](url)");
  assert.equal(link.start, 1);
  assert.equal(link.end, 5);

  const empty = wrapText("hello", 5, 5, "*", "*");
  assert.equal(empty.value, "hello**");
  assert.equal(empty.start, 6);
  assert.equal(empty.end, 6);
});

test("applyCode wraps inline code and multiline fenced code blocks", () => {
  const inline = applyCode("const x = 1;", 6, 7);
  assert.equal(inline.value, "const `x` = 1;");
  assert.equal(inline.start, 7);
  assert.equal(inline.end, 8);

  const multi = applyCode("line 1\nline 2", 0, 13);
  assert.equal(multi.value, "```\nline 1\nline 2\n```");
  assert.equal(multi.start, 4);
  assert.equal(multi.end, 17);
});

test("applyTitle prefixes a line with heading and leaves existing headings intact", () => {
  const h1 = applyTitle("Title", 0, 5);
  assert.equal(h1.value, "# Title");
  assert.equal(h1.start, 2);
  assert.equal(h1.end, 7);

  const unchanged = applyTitle(h1.value, h1.start, h1.end);
  assert.equal(unchanged.value, "# Title");
});

test("applyTask and toggleTask manage markdown task lists and ignore code fences", () => {
  const converted = applyTask("first item", 0, 10);
  assert.equal(converted.value, "- [ ] first item");

  const idempotent = applyTask(converted.value, converted.start, converted.end);
  assert.equal(idempotent.value, "- [ ] first item");

  const doc = "```\n- [ ] ignored in fence\n```\n- [ ] real task\n- [x] done task";
  const checked = toggleTask(doc, 0, true);
  assert.equal(checked, "```\n- [ ] ignored in fence\n```\n- [x] real task\n- [x] done task");

  const unchecked = toggleTask(checked!, 1, false);
  assert.equal(unchecked, "```\n- [ ] ignored in fence\n```\n- [x] real task\n- [ ] done task");
  assert.equal(toggleTask(doc, 99, true), null);
});

test("taskListOnEnter continues lists, exits empty items, and renumbers ordered lists", () => {
  const contTask = taskListOnEnter("- [x] buy milk", 14, 14);
  assert.ok(contTask);
  assert.equal(contTask.value, "- [x] buy milk\n- [ ] ");

  const exitTask = taskListOnEnter("- [ ] ", 6, 6);
  assert.ok(exitTask);
  assert.equal(exitTask.value, "");

  const splitOrdered = taskListOnEnter("1. first\n2. second", 8, 8);
  assert.ok(splitOrdered);
  assert.equal(splitOrdered.value, "1. first\n2. \n3. second");

  const renumbered = renumberOrderedLists("1. a\n5. b\n9. c", 0, 0);
  assert.equal(renumbered.value, "1. a\n2. b\n3. c");
});

test("tabOnMarkdown indents and outdents lists and plain text", () => {
  const indented = tabOnMarkdown("- [ ] item", 6, 6, false);
  assert.equal(indented.value, "\t- [ ] item");

  const outdented = tabOnMarkdown(indented.value, indented.start, indented.end, true);
  assert.equal(outdented.value, "- [ ] item");

  const strippedPrefix = tabOnMarkdown("- [ ] item", 6, 6, true);
  assert.equal(strippedPrefix.value, "item");

  const plain = tabOnMarkdown("hello", 0, 0, false);
  assert.equal(plain.value, "\thello");
});

test("parseBlocks lifts closed fences into code blocks", () => {
  const source = "hello\n```js\nconst x = 1\n```\nworld";
  const blocks = parseBlocks(source);
  const code = blocks.find((block) => block.kind === "code");
  assert.equal(code?.kind, "code");
  if (code?.kind === "code") {
    assert.equal(code.lang, "js");
    assert.equal(code.text, "const x = 1");
  }
  assert.equal(serializeBlocks(blocks), source);
  const open = parseBlocks("hello\n```\nstill open");
  assert.equal(open.some((block) => block.kind === "code"), false);
});

test("media helpers parse, serialize, and extract titles accurately", () => {
  assert.equal(isImage("photo.webp"), true);
  assert.equal(isVideo("clip.mp4"), true);
  assert.equal(isAudio("voice.m4a"), true);
  assert.equal(isPreviewableMedia("Spec.pdf"), false);
  assert.equal(displayFileName("12345678-Project_Plan.pdf"), "Project Plan.pdf");

  const meta = parseMediaMeta("diagram.png|320", "w=480");
  assert.equal(meta.label, "diagram.png");
  assert.equal(meta.width, 480);

  const imgMd = mediaMarkdown("12345678-pic.png", "pic.png", 300);
  assert.equal(imgMd, "![pic.png](memose-media/12345678-pic.png#w=300)");

  const docMd = mediaMarkdown("12345678-Report_2026.pdf");
  assert.equal(docMd, "[Report 2026.pdf](memose-media/12345678-Report_2026.pdf)");

  const blocks = parseBlocks(`Hello\n${imgMd}\nWorld`);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { kind: "text", text: "Hello" });
  assert.deepEqual(blocks[1], {
    kind: "media",
    name: "12345678-pic.png",
    label: "pic.png",
    width: 300,
    inline: false,
  });
  assert.deepEqual(blocks[2], { kind: "text", text: "World" });
  assert.equal(serializeBlocks(blocks), `Hello\n${imgMd}\nWorld`);

  const inlineContent = `![pic.png](memose-media/12345678-pic.png) side note`;
  const inlineBlocks = parseBlocks(inlineContent);
  assert.equal(inlineBlocks[1]?.kind, "media");
  if (inlineBlocks[1]?.kind === "media") {
    assert.equal(inlineBlocks[1].inline, true);
  }
  assert.equal(serializeBlocks(inlineBlocks), inlineContent);

  const ensured = ensureTextSlots([
    { kind: "media", name: "a.png" },
    { kind: "media", name: "b.png" },
  ]);
  assert.equal(ensured.length, 5);
  assert.equal(ensured[0]?.kind, "text");
  assert.equal(ensured[2]?.kind, "text");
  assert.equal(ensured[4]?.kind, "text");

  assert.equal(noteTitle("# Release 1.0\nBody"), "Release 1.0");
  assert.equal(noteTitle("![](memose-media/12345678-pic.png)\nActual title"), "Actual title");
  assert.equal(noteTitle("![chart.png|320](memose-media/12345678-pic.png)"), "chart.png");
  assert.equal(noteTitle("![](memose-media/12345678-pic.png)"), "Image");
  assert.equal(noteTitle("   "), "Note");
});

test("moveBlockMedia splits a text block at a line or inline caret", () => {
  const items = ensureTextSlots([
    { kind: "text", text: "Hello\nWorld" },
    { kind: "media", name: "a.png", label: "a.png", inline: false },
  ]);
  const from = items.findIndex((block) => block.kind === "media");
  const lineMoved = moveBlockMedia(items, from, { mode: "line", blockIndex: 0, lineIndex: 1, y: 0 });
  assert.equal(lineMoved[0]?.kind, "text");
  if (lineMoved[0]?.kind === "text") {
    assert.equal(lineMoved[0].text, "Hello");
  }
  assert.equal(lineMoved[1]?.kind, "media");
  if (lineMoved[1]?.kind === "media") {
    assert.equal(lineMoved[1].inline, false);
  }

  const inlineMoved = moveBlockMedia(items, from, {
    mode: "inline",
    blockIndex: 0,
    charOffset: 2,
    x: 0,
    top: 0,
    height: 16,
  });
  assert.equal(inlineMoved[0]?.kind, "text");
  if (inlineMoved[0]?.kind === "text") {
    assert.equal(inlineMoved[0].text, "He");
  }
  assert.equal(inlineMoved[1]?.kind, "media");
  if (inlineMoved[1]?.kind === "media") {
    assert.equal(inlineMoved[1].inline, true);
  }
});

test("shortcuts module formats and matches keyboard and mouse chords", () => {
  const defaults = defaultBinds();
  assert.ok(formatBind(defaults.newMemo).length > 0);
  assert.equal(isModifierKey("Shift", "Shift"), true);
  assert.equal(isModifierKey("Alt", "Alt"), true);
  assert.equal(isModifierKey("Alt", "a"), false);

  const keyEvent = {
    key: "n",
    code: "KeyN",
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
  } as KeyboardEvent;
  assert.equal(matchBind(keyEvent, "Alt+N, Alt+Mouse4"), true);
  assert.equal(matchBind(keyEvent, "Control+N"), false);
  assert.equal(eventToBind(keyEvent), "Alt+N");
  assert.equal(modifierDown("Alt", keyEvent), true);

  const mouseEvent = { button: 3, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false };
  assert.equal(matchMouse(mouseEvent, "Alt+N, Alt+Mouse4"), true);
  assert.equal(matchMouse(mouseEvent, "Alt+Mouse5"), false);
  assert.equal(eventToMouse(mouseEvent as MouseEvent), "Alt+Mouse4");
  assert.equal(domMouseButton(0), null);
  assert.equal(domMouseButton(2), null);
  assert.equal(domMouseButton(1), 3);
  assert.equal(domMouseButton(3), 4);
  assert.equal(domMouseButton(4), 5);
  assert.equal(
    eventToMouse({ button: 1, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false } as MouseEvent, {
      alt: true,
    }),
    "Alt+Mouse3",
  );
  assert.equal(mouseChordToBind(4, true, false, true, false), "Shift+Alt+Mouse4");
});

test("settings window html has Visibility, Shortcuts, and Sync (useMemos) tabs with Default memo visibility and Window snap", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const html = fs.readFileSync(path.join(root, "settings.html"), "utf8");
  const tabs = [...html.matchAll(/data-tab="([^"]+)"[\s\S]*?>\s*([^<]+?)\s*<\/button>/g)].map((m) => ({
    id: m[1],
    label: m[2],
  }));
  assert.deepEqual(tabs, [
    { id: "visibility", label: "Visibility" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "sync", label: "Sync (useMemos)" },
  ]);
  assert.match(html, /id="tab-visibility"[\s\S]*?aria-selected="true"/);
  assert.match(html, /Default memo visibility/);
  assert.match(html, /Window snap/);
  assert.match(html, /id="snap-memos"/);
  assert.match(html, /id="show-in-switcher"/);
  assert.match(html, /id="pinned-always-on-top"/);
  assert.match(html, /id="coder-editor"/);
  assert.match(html, /id="markdown-highlight"/);
  assert.match(html, /id="markdown-schemes"/);
  assert.match(html, /id="space-choices"/);
  assert.match(html, /id="new-space"/);
  assert.match(html, /id="create-space"/);
});

test("uniqueFiles drops duplicate file records by name, size, and timestamp", () => {
  const first = { name: "a.png", size: 10, lastModified: 1 } as File;
  const copy = { name: "a.png", size: 10, lastModified: 1 } as File;
  const other = { name: "b.png", size: 10, lastModified: 1 } as File;
  assert.deepEqual(uniqueFiles([first, copy, other]), [first, other]);
});

test("relativeTime and exactStamp format nearby and absolute timestamps", () => {
  const now = Date.parse("2026-10-19T18:00:00");
  assert.equal(relativeTime(now - 20_000, now), "just now");
  assert.equal(relativeTime(now - 60_000, now), "1 minute ago");
  assert.equal(relativeTime(now - 120_000, now), "2 minutes ago");
  assert.match(relativeTime(now - 3 * 60 * 60 * 1000, now), /^today at /);
  assert.match(relativeTime(now - 26 * 60 * 60 * 1000, now), /^yesterday at /);
  assert.equal(exactStamp(Date.parse("2026-10-19T08:05:09")), "2026-10-19 08:05:09");
});

test("visibilityShort labels private, space, and combined audience", () => {
  const spaces = [{ name: "team", title: "Team" }];
  assert.equal(visibilityShort("OFFLINE_PRIVATE", "", spaces), "Offline");
  assert.equal(visibilityShort("PRIVATE", "", spaces), "Private");
  assert.equal(visibilityShort("SPACE", "team", spaces), "Team");
  assert.equal(visibilityShort("PUBLIC", "team", spaces), "Public | Team");
});

test("look helpers normalize note color and theme", () => {
  assert.equal(namedTheme("dark"), "dark");
  assert.equal(namedTheme("nope"), null);
  assert.deepEqual(defaultLook(), {
    opacity: 100,
    hueLight: null,
    hueDark: null,
    swatches: [],
    theme: null,
    coder: null,
  });
  const look = lookFromNote({
    id: "n1",
    content: "",
    createdAt: 0,
    updatedAt: 0,
    syncState: "local",
    remoteName: null,
    lastError: null,
    pinned: false,
    opacity: 140,
    hueLight: 20,
    hueDark: 40,
    swatches: [10, 400, 11],
    theme: "dark",
  });
  assert.equal(look.opacity, 100);
  assert.deepEqual(look.swatches, [10, 11]);
  assert.equal(look.theme, "dark");
});

test("restorePlace no-ops without a saved caret", () => {
  assert.equal(restorePlace({ querySelector() { return null; } } as unknown as ParentNode, null), false);
});

test("BlockHistory clones blocks and undoes to the previous snapshot", () => {
  const history = new BlockHistory();
  const first = [{ kind: "text" as const, text: "one" }];
  const second = [{ kind: "text" as const, text: "two" }];
  history.push(first, { index: 0, start: 0, end: 0 }, true);
  history.push(second, { index: 0, start: 3, end: 3 }, true);
  const undone = history.takeUndo(second, { index: 0, start: 3, end: 3 });
  assert.deepEqual(undone?.blocks, cloneBlocks(first));
  const redone = history.takeRedo(first, { index: 0, start: 0, end: 0 });
  assert.deepEqual(redone?.blocks, cloneBlocks(second));
});

test("syncIcon and platform helpers cover common states", () => {
  assert.equal(syncIcon("synced").label, "Synced");
  assert.equal(syncIcon("conflict").label, "Choose a version");
  assert.equal(syncIcon("unknown").label, "Local");
  assert.equal(syncIcon("local", "OFFLINE_PRIVATE").label, "Offline on this computer");
  assert.equal(syncIcon("synced", "OFFLINE_PRIVATE").label, "Offline on this computer");
  assert.equal(requireEl("ok", "field"), "ok");
  assert.throws(() => requireEl(null, "field"), /missing field/);
  const rect = { left: 10, right: 20, top: 5, bottom: 15 } as DOMRect;
  assert.equal(pointIn(rect, 10, 5), true);
  assert.equal(pointIn(rect, 9, 10), false);
  const scroller = {
    clientWidth: 190,
    clientHeight: 200,
    scrollWidth: 190,
    scrollHeight: 400,
    offsetWidth: 200,
    offsetHeight: 200,
    borderLeft: 0,
    borderRight: 0,
    borderTop: 0,
    borderBottom: 0,
    overflowX: "hidden",
    overflowY: "auto",
  };
  const box = { left: 0, top: 0, right: 200, bottom: 200 };
  assert.equal(pointOnScrollGutter(196, 80, box, scroller), true);
  assert.equal(pointOnScrollGutter(100, 80, box, scroller), false);
});

function readCascade(file: string): string {
  const css = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  let imported = "";
  const rest = css.replace(/@import\s+"([^"]+)";\n?/g, (_full, spec: string) => {
    imported += fs.readFileSync(path.resolve(dir, spec), "utf8");
    imported += "\n";
    return "";
  });
  return imported + rest;
}

test("overlay editor keeps selected textarea glyphs invisible", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const css = readCascade(path.join(root, "src/styles.css"));
  assert.match(css, /textarea::selection/);
  assert.doesNotMatch(css, /textarea::selection,[^}]*::-moz-selection/);
  assert.doesNotMatch(css, /\.md-field\.is-selecting/);
  assert.match(css, /-webkit-text-fill-color: transparent/);
  assert.match(css, /#blocks \.md-field\[data-coder\] textarea/);
  assert.match(css, /\.md-field\[data-coder\] \.md-hl \*/);
  assert.doesNotMatch(css, /\.md-line-text\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /--gutter-cols/);
  assert.match(css, /\.md-overflow-shift/);
  assert.match(css, /::-webkit-scrollbar/);
  assert.match(css, /scrollbar-width: thin/);
});

test("highlightMarkdown colors markers without changing the source text", () => {
  const html = highlightMarkdown("# Title\nhello **bold** and `code`\n> quote\n- item\n<script>");
  assert.match(html, /md-line-text/);
  assert.match(html, /\n<span class="md-line">/);
  assert.match(html, /md-heading/);
  assert.match(html, /md-strong/);
  assert.match(html, /md-code/);
  assert.match(html, /md-quote/);
  assert.match(html, /md-marker/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes("<script>"), false);
  assert.match(highlightMarkdown("\tfoo"), /\tfoo/);
  const tagged = highlightMarkdown("pay #finance and `#code`");
  assert.match(tagged, /data-tag="#finance"/);
  assert.match(tagged, /md-code/);
  assert.equal(tagged.includes('data-tag="#code"'), false);
  assert.equal(highlightMarkdown("# Title #finance").includes("md-tag"), false);
  assert.equal(highlightMarkdown("```\n#finance\n```", { tags: true }).includes("md-tag"), false);
  assert.equal(highlightMarkdown("pay #finance", { tags: false }).includes("md-tag"), false);
  assert.equal(tagAtOffset("pay #finance now", 6), "#finance");
  assert.equal(tagAtOffset("a\n#finance", 2), "#finance");
  assert.equal(tagAtOffset("a\n#finance", 10), "#finance");
  assert.equal(tagAtOffset("# Title", 3), null);
  assert.equal(tagAtOffset("```\n#finance\n```", 6), null);
});

test("formatJsonDocument pretty-prints objects and json fences", () => {
  assert.equal(formatJsonDocument('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatJsonDocument("not json"), null);
  const fenced = formatJsonDocument("intro\n```json\n{\"a\":1}\n```\n");
  assert.match(fenced ?? "", /"a": 1/);
});

test("formatDocument indents javascript when json parse fails", () => {
  assert.equal(formatDocument("if (x) {\ny=1\n}"), "if (x) {\n  y=1\n}");
  assert.equal(formatDocument("if (x) {\n  y=1\n}"), null);
});

test("memo-chrome computes palettes and renders stack header template", () => {
  assert.match(paperAt("light", 48), /^hsl\(48 /);
  assert.match(paperAt("dark", 200), /^hsl\(200 /);
  assert.equal(tabFill("light", 48), "hsl(48 100% 64%)");
  assert.equal(tabFill("dark", 210), "hsl(210 82% 46%)");
  assert.equal(baseColors("light")["--paper"], "#fff4b8");
  assert.equal(baseColors("dark")["--paper"], "#25282c");
  const tinted = palette("dark", 180);
  assert.ok(tinted["--paper"].includes("180"));
  assert.ok(themeGlyph(true).includes("circle"));
  assert.ok(themeGlyph(false).includes("path"));
  assert.ok(stackHeaderHtml().includes("class=\"brand-name\""));
  assert.ok(huePopHtml().includes("hue-slider"));
  assert.ok(huePopHtml().includes("hue-slot"));
  assert.deepEqual(clampHueSwatches([48, 400, 48, 210, 12]), [48, 210, 12]);
});

test("release versions and Tauri IPC command contracts stay in sync without dangling handlers", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const pkgLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
    version: string;
    packages?: Record<string, { version?: string }>;
  };
  const tauriConf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
    version: string;
    bundle?: {
      macOS?: {
        signingIdentity?: string;
      };
    };
  };
  const cargoToml = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLock = fs.readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8");
  const cargoLockVersion = cargoLock.match(/name = "memose"\r?\nversion = "([^"]+)"/)?.[1];

  assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  assert.ok(
    tauriConf.version === pkg.version || tauriConf.version === "../package.json",
    "tauri.conf.json version must match package.json or reference ../package.json",
  );
  assert.ok(
    Boolean(tauriConf.bundle?.macOS?.signingIdentity),
    "tauri.conf.json bundle.macOS.signingIdentity must be set so macOS app bundles are signed",
  );
  assert.equal(pkg.version, cargoVersion, "package.json and Cargo.toml versions must match");
  assert.equal(pkg.version, cargoLockVersion, "package.json and Cargo.lock versions must match");
  assert.equal(pkg.version, pkgLock.version, "package.json and package-lock.json root versions must match");
  assert.equal(
    pkg.version,
    pkgLock.packages?.[""]?.version,
    "package.json and package-lock.json workspace versions must match",
  );

  const releaseWorkflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
  ]) {
    assert.ok(releaseWorkflow.includes(target), `release.yml must build target ${target}`);
  }

  const libRs = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  const handlerBlock = libRs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  const registered = [...handlerBlock.matchAll(/commands::([a-z0-9_]+)/g)].map((m) => m[1]).sort();

  const tsFiles = walkTs(path.join(root, "src"));
  const invokedSet = new Set<string>();
  for (const file of tsFiles) {
    const src = fs.readFileSync(file, "utf8");
    for (const match of src.matchAll(/\binvoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)) {
      invokedSet.add(match[1]);
    }
  }
  const invoked = [...invokedSet].sort();
  assert.deepEqual(
    registered,
    invoked,
    "Every registered Tauri command must be used by the frontend and every frontend invoke() must be registered",
  );
});

