import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { test, type Locator, type Page } from "@playwright/test";

import { composerTextarea, openComposer, revealEditorButton } from "../ui/helpers";
import type { HarnessSeed, NoteSeed } from "../ui/tauri-harness";

const NOW = Date.now();
const OUT = path.resolve("docs/demo.mp4");

const notes: NoteSeed[] = [
  {
    id: "standup",
    content: "# Standup\n- [x] Ship tray capture\n- [ ] Review pin tabs\n#work #ship",
    updatedAt: NOW,
    hueLight: 48,
  },
  {
    id: "groceries",
    content: "Groceries #home\n- [ ] Oat milk\n- [ ] Sourdough",
    updatedAt: NOW - 8_000,
    hueLight: 92,
  },
  {
    id: "auth",
    content: "# Auth notes\nToken lives in the keychain.\n#work",
    updatedAt: NOW - 20_000,
    hueLight: 210,
  },
  {
    id: "call",
    content: "Call mom Sunday #home",
    updatedAt: NOW - 40_000,
    hueLight: 28,
  },
];

const stackNotes: NoteSeed[] = [
  {
    id: "design",
    content: "# Design notes\nPaper hue lives on the memo.\nKeep stacks thin.",
    pinned: true,
    updatedAt: NOW,
    hueLight: 48,
    winW: 400,
    winH: 520,
  },
  {
    id: "snip",
    content: "# Snippets\n```js\ninvoke(\"set_pinned\", { id, pinned: true })\n```",
    stackHost: "design",
    collapsed: true,
    updatedAt: NOW - 10,
    hueLight: 210,
  },
  {
    id: "ship",
    content: "# Ship list\n- [ ] README demo\n- [ ] Tag the release",
    stackHost: "snip",
    collapsed: true,
    updatedAt: NOW - 20,
    hueLight: 16,
  },
];

const seed: HarnessSeed = {
  notes: [...notes, ...stackNotes],
  hueSwatches: [48, 210, 16, 160, 280, 92],
  settings: { markdownHighlight: true, coderEditor: false },
  pinTabs: {
    version: 1,
    activeId: "tab-work",
    tabs: [
      { id: "tab-work", name: "Work", hue: 210, notes: [{ id: "design" }] },
      { id: "tab-home", name: "Home", hue: 40, notes: [] },
      { id: "tab-ideas", name: "Ideas", hue: 280, notes: [] },
    ],
  },
};

test("readme demo", async ({ page }) => {
  await page.addInitScript(() => {
    const apply = () => {
      if (document.getElementById("demo-base")) {
        return;
      }
      const style = document.createElement("style");
      style.id = "demo-base";
      style.textContent = `
        html, body { background: #1b2433 !important; }
        body { padding: 0 !important; display: flex; align-items: center; justify-content: center; }
        .resize-handle { display: none !important; }
        #frame { width: 428px !important; height: 548px !important; }
      `;
      document.documentElement.appendChild(style);
      document.documentElement.style.background = "#1b2433";
    };
    apply();
    document.addEventListener("DOMContentLoaded", apply);
  });
  await sceneComposer(page);
  await sceneStack(page);
  await sceneTabs(page);
  await hold(page, 900);

  const video = page.video();
  await page.close();
  if (!video) {
    throw new Error("Playwright did not record a video");
  }
  const webm = await video.path();
  mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      webm,
      "-ss",
      "0.45",
      "-vf",
      "fps=24,scale=1280:720:flags=lanczos",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "high",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      "-an",
      OUT,
    ],
    { stdio: "inherit" },
  );
});

async function sceneComposer(page: Page) {
  await openComposer(page, seed);
  await dress(page, "composer");
  await hold(page, 200);
  await intro(page, "Memose", "Sticky notes for the desktop");
  await caption(page, "Capture a memo from anywhere");
  const area = await composerTextarea(page);
  await clickAt(page, area);
  await area.pressSequentially("# Friday ship", { delay: 38 });
  await page.keyboard.press("Enter");
  await area.pressSequentially("- [ ] Record the demo", { delay: 32 });
  await page.keyboard.press("Enter");
  await area.pressSequentially("Polish the README #ship", { delay: 30 });
  await hold(page, 400);

  await caption(page, "Markdown toolbar, preview, and tasks");
  await area.evaluate((el: HTMLTextAreaElement) => {
    const from = el.value.indexOf("Polish");
    const until = el.value.indexOf("README") + 6;
    el.focus();
    el.setSelectionRange(from, until);
  });
  await openMarkdown(page);
  await clickAt(page, page.locator('#md-toolbar button[data-markdown="bold"]'));
  await hold(page, 280);

  const preview = page.locator("#mode-toggle");
  await revealEditorButton(page, preview);
  await clickAt(page, preview);
  await page.locator("#preview input[type='checkbox']").first().waitFor();
  await hold(page, 500);
  await clickAt(page, page.locator("#preview input[type='checkbox']").first());
  await hold(page, 1000);
  await clickAt(page, preview);
  await page.locator("#blocks .md-lines, #blocks textarea").first().waitFor();

  await caption(page, "Search recent memos by tag");
  const ship = page.locator("#blocks .md-row", { hasText: "#ship" });
  const shipPoint = await ship.evaluate((el) => {
    const text = el.textContent ?? "";
    const at = text.lastIndexOf("#ship");
    const node = [...el.childNodes].find((child) => child.nodeType === Node.TEXT_NODE);
    if (!(node instanceof Text) || at < 0) {
      return null;
    }
    const range = el.ownerDocument.createRange();
    range.setStart(node, at);
    range.setEnd(node, Math.min(node.data.length, at + 5));
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (!shipPoint) {
    throw new Error("tag");
  }
  await page.mouse.click(shipPoint.x, shipPoint.y);
  await page.locator("#recent-search").waitFor();
  await hold(page, 500);
  await clickAt(page, page.locator("#recent .title", { hasText: "Standup" }));
  await hold(page, 1400);
}

async function sceneStack(page: Page) {
  await page.goto("/?pin=design");
  await page.locator("html.pin-window").waitFor();
  await page.locator("#card").waitFor();
  await dress(page, "stack");
  await caption(page, "Pin memos and stack them together");
  await page.locator(".stack-note").first().waitFor();
  await hold(page, 700);

  await caption(page, "Hover a folded memo to peek");
  const folded = page.locator(".stack-note[data-id='snip']");
  await moveTo(page, folded.locator("header"));
  await hold(page, 1200);
  await clickAt(page, folded.locator("header"));
  await hold(page, 700);

  await caption(page, "Paper hue, per memo");
  const theme = page.locator("#theme-toggle");
  await revealEditorButton(page, theme);
  await clickAt(page, theme);
  await page.locator("#color-pop").waitFor();
  const slider = page.locator("#hue-slider");
  await moveTo(page, slider);
  await slider.fill("200");
  await hold(page, 500);
  await clickAt(page, page.locator("#hue-add"));
  await hold(page, 400);
  await page.mouse.click(40, 360);
  await hold(page, 250);

  await caption(page, "Fold the stack when you need the desk");
  await clickAt(page, page.locator("#fold-toggle"));
  await hold(page, 900);
  await clickAt(page, page.locator(".stack-note[data-id='ship'] header"));
  await hold(page, 1000);
}

async function sceneTabs(page: Page) {
  await page.goto("/pin-tabs.html");
  await page.locator("#strip").waitFor();
  await dress(page, "tabs");
  await caption(page, "Pinned-mode tabs across desks");
  await hold(page, 400);
  await moveTo(page, page.locator("#strip"), 18);
  await page.locator("html.is-open").waitFor();
  await hold(page, 500);
  await clickAt(page, page.locator(".pin-tab", { hasText: "Home" }));
  await hold(page, 600);
  await clickAt(page, page.locator("#tab-add"));
  await hold(page, 500);
  const work = page.locator(".pin-tab", { hasText: "Work" });
  await moveTo(page, work);
  await work.dblclick();
  await page.locator("#tab-menu").waitFor();
  const name = page.locator("#tab-name");
  await clickAt(page, name);
  await name.fill("");
  await name.pressSequentially("Desk", { delay: 70 });
  await hold(page, 900);
  await caption(page, "Memose — notes that stay out of the way");
}

async function dress(page: Page, scene: "composer" | "stack" | "tabs") {
  await page.addStyleTag({ content: demoCss(scene) });
  await page.evaluate((kind) => {
    document.documentElement.dataset.demo = kind;
    if (!document.getElementById("demo-cursor")) {
      const cursor = document.createElement("div");
      cursor.id = "demo-cursor";
      document.documentElement.appendChild(cursor);
      window.addEventListener(
        "mousemove",
        (event) => {
          cursor.style.left = `${event.clientX}px`;
          cursor.style.top = `${event.clientY}px`;
        },
        true,
      );
    }
    if (!document.getElementById("demo-brand")) {
      const brand = document.createElement("div");
      brand.id = "demo-brand";
      brand.textContent = "Memose";
      document.documentElement.appendChild(brand);
    }
    if (!document.getElementById("demo-caption")) {
      const cap = document.createElement("div");
      cap.id = "demo-caption";
      document.documentElement.appendChild(cap);
    }
  }, scene);
}

async function intro(page: Page, title: string, line: string) {
  await page.evaluate(
    ([heading, sub]) => {
      const wrap = document.createElement("div");
      wrap.id = "demo-intro";
      wrap.innerHTML = `<strong>${heading}</strong><span>${sub}</span>`;
      document.documentElement.appendChild(wrap);
    },
    [title, line],
  );
  await hold(page, 1600);
  await page.evaluate(() => {
    document.getElementById("demo-intro")?.classList.add("out");
  });
  await hold(page, 380);
  await page.evaluate(() => document.getElementById("demo-intro")?.remove());
}

async function caption(page: Page, text: string) {
  await page.evaluate((value) => {
    const el = document.getElementById("demo-caption");
    if (el) {
      el.textContent = value;
    }
  }, text);
}

async function openMarkdown(page: Page) {
  const toggle = page.locator("#markdown-toggle");
  await revealEditorButton(page, toggle);
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await clickAt(page, toggle);
  }
}

async function clickAt(page: Page, locator: Locator) {
  await locator.waitFor({ state: "attached" });
  await moveTo(page, locator);
  await hold(page, 120);
  await locator.click({ force: true });
}

async function moveTo(page: Page, locator: Locator, steps = 14) {
  const box = await locator.boundingBox();
  if (!box) {
    return;
  }
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 18), { steps });
}

function hold(page: Page, ms: number) {
  return page.waitForTimeout(ms);
}

function demoCss(scene: "composer" | "stack" | "tabs"): string {
  const frame =
    scene === "stack"
      ? `#frame { width: 400px !important; height: 620px !important; --open-h: 250px; }`
      : scene === "composer"
        ? `#frame { width: 428px !important; height: 548px !important; }`
        : "";
  const tabs =
    scene === "tabs"
      ? `
html.pin-tabs-window, html.pin-tabs-window body {
  display: block !important;
  padding: 0 !important;
  align-items: stretch !important;
  justify-content: flex-start !important;
}
#strip {
  position: absolute; top: 0; left: 72px; right: 72px; height: 40px;
  border-radius: 0 0 10px 10px;
  background: color-mix(in srgb, #1b2433 35%, transparent);
}
html.pin-tabs-window #demo-brand { display: none; }
`
      : "";
  return `
html, body {
  background:
    radial-gradient(900px 560px at 12% 0%, #3b4c66 0%, transparent 55%),
    radial-gradient(800px 520px at 100% 100%, #2a3a32 0%, transparent 50%),
    linear-gradient(165deg, #243044 0%, #1b2433 58%, #151c28 100%) !important;
}
body { padding: 0 !important; display: flex; align-items: center; justify-content: center; }
.resize-handle { display: none !important; }
${frame}
${tabs}
#demo-brand {
  position: fixed; top: 28px; left: 40px; z-index: 2147483646;
  color: rgba(255,255,255,.5); font: 600 12px/1 system-ui, sans-serif;
  letter-spacing: .18em; text-transform: uppercase; pointer-events: none;
}
#demo-caption {
  position: fixed; left: 40px; right: 40px; bottom: 32px; z-index: 2147483646;
  color: rgba(255,255,255,.9); font: 500 20px/1.3 "Avenir Next", "Segoe UI", sans-serif;
  text-shadow: 0 2px 14px rgba(0,0,0,.45); pointer-events: none;
}
#demo-cursor {
  position: fixed; left: 0; top: 0; z-index: 2147483647; width: 14px; height: 14px;
  margin: -2px 0 0 -2px; border-radius: 50%;
  background: #fff; border: 2px solid #1b2433;
  box-shadow: 0 2px 8px rgba(0,0,0,.4); pointer-events: none;
}
#demo-intro {
  position: fixed; inset: 0; z-index: 2147483645; display: grid; place-items: center;
  background: rgba(21, 28, 40, .88); pointer-events: none;
  transition: opacity 320ms ease;
}
#demo-intro.out { opacity: 0; }
#demo-intro strong, #demo-intro span { display: block; text-align: center; color: #fff; }
#demo-intro strong { font: 600 52px/1.1 "Avenir Next", "Segoe UI", sans-serif; letter-spacing: -.02em; }
#demo-intro span { margin-top: 12px; font: 400 20px/1.3 "Avenir Next", "Segoe UI", sans-serif; color: rgba(255,255,255,.78); }
`;
}
