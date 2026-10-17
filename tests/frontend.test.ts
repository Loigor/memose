import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyCode,
  applyTask,
  applyTitle,
  displayFileName,
  ensureTextSlots,
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
} from "../src/markdown-edit.ts";
import { baseColors, palette, paperAt, stackHeaderHtml, themeGlyph } from "../src/memo-chrome.ts";
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
  assert.equal(indented.value, "    - [ ] item");

  const outdented = tabOnMarkdown(indented.value, indented.start, indented.end, true);
  assert.equal(outdented.value, "- [ ] item");

  const strippedPrefix = tabOnMarkdown("- [ ] item", 6, 6, true);
  assert.equal(strippedPrefix.value, "item");
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
});

test("memo-chrome computes palettes and renders stack header template", () => {
  assert.match(paperAt("light", 48), /^hsl\(48 /);
  assert.match(paperAt("dark", 200), /^hsl\(200 /);
  assert.equal(baseColors("light")["--paper"], "#fff4b8");
  assert.equal(baseColors("dark")["--paper"], "#25282c");
  const tinted = palette("dark", 180);
  assert.ok(tinted["--paper"].includes("180"));
  assert.ok(themeGlyph(true).includes("circle"));
  assert.ok(themeGlyph(false).includes("path"));
  assert.ok(stackHeaderHtml().includes("class=\"brand-name\""));
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

  const tsFiles = ["src/main.ts", "src/settings.ts"];
  const invokedSet = new Set<string>();
  for (const rel of tsFiles) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
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

