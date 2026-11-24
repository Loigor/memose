import { expect, test, type Page } from "@playwright/test";

import { invokedCmds, openComposer, openPinned, openSettings } from "./helpers";
import { emitEvent } from "./tauri-harness";

const ready = { enabled: true, installed: true };

async function lastDraft(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const calls = window.__memoseHarness?.getInvocations().filter((item) => item.cmd === "upsert_draft") ?? [];
    return (calls[calls.length - 1]?.args as { content?: string } | undefined)?.content;
  });
}

function chunk(page: Page, sessionId: string, seq: number, text: string, pauseMs = 0) {
  return emitEvent(page, "speech-chunk", { sessionId, seq, text, pauseMs });
}

async function setSlider(slider: import("@playwright/test").Locator, value: number) {
  await slider.locator(`.effort-dot[data-level="${value}"]`).click();
}

test("the record button stays hidden until recording is on", async ({ page }) => {
  await openComposer(page, { draft: { content: "plain memo" } });
  await expect.poll(async () => invokedCmds(page)).toContain("get_speech_settings");
  await expect(page.locator("#rec-anchor")).toBeHidden();
});

test("dictation lands at the cursor, grows, and is tidied by the model", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "Shopping list" },
    speech: { ...ready, polishReady: true, polishReply: "Remember the milk and the bread." },
  });
  const record = page.locator("#rec-anchor .rec-toggle");
  await expect(record).toBeVisible();
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  await record.click();
  await expect(record).toHaveClass(/rec-on/);
  await chunk(page, "speech-1", 0, "remember the milk");
  await expect(page.locator("#blocks")).toContainText("Shopping list remember the milk");
  await chunk(page, "speech-1", 1, "and the bred");
  await expect(page.locator("#blocks")).toContainText("Shopping list Remember the milk and the bread.");
  await record.click();
  await expect(record).not.toHaveClass(/rec-on/);
  await expect.poll(async () => lastDraft(page)).toBe("Shopping list Remember the milk and the bread.");
  expect(await invokedCmds(page)).toContain("speech_polish");
});

test("without the chat model the text stays as it was heard, and the sound can be kept", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "Notes" },
    speech: { ...ready, keepAudio: true, audio: "![voice-1.wav](memose-media/12345678-voice-1.wav)" },
  });
  const record = page.locator("#rec-anchor .rec-toggle");
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  await record.click();
  await chunk(page, "speech-1", 0, "first words");
  await expect(page.locator("#blocks")).toContainText("Notes first words");
  await record.click();
  await expect
    .poll(async () => lastDraft(page))
    .toBe("Notes first words\n![voice-1.wav](memose-media/12345678-voice-1.wav)");
  expect(await invokedCmds(page)).not.toContain("speech_polish");
});

test("a prompt can be spoken and is sent when recording stops", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "- [ ] one\n- [ ] two" },
    ai: {
      llmEnabled: true,
      llmBaseUrl: "http://localhost:11434/v1",
      llmModel: "qwen2.5:7b",
      llmReply: "Two tasks.",
      llmKind: "answer",
    },
    speech: ready,
  });
  await page.locator("#ai-anchor .ai-toggle").click();
  const bubble = page.locator("#card .ai-bubble");
  const mic = bubble.locator(".ai-mic");
  await expect(mic).toBeVisible();
  await mic.click();
  await expect(mic).toHaveClass(/rec-on/);
  await chunk(page, "speech-1", 0, "how many tasks");
  await chunk(page, "speech-1", 1, "are there");
  await expect(bubble.locator(".ai-input")).toHaveValue("how many tasks are there");
  await bubble.locator(".ai-send").click();
  await expect(bubble.locator(".ai-q-text")).toHaveText("how many tasks are there");
  await expect(bubble.locator(".ai-answer")).toHaveText("Two tasks.");
  const started = await page.evaluate(
    () => window.__memoseHarness?.getInvocations().find((item) => item.cmd === "speech_start")?.args,
  );
  expect(started).toMatchObject({ purpose: "prompt", noteId: null });
  await expect(page.locator("#blocks")).not.toContainText("how many tasks");
});

test("recording settings list the models, download one, and pick the microphone", async ({ page }) => {
  await openSettings(page);
  await page.locator("#tab-recording").click();
  const parakeet = page.locator(".model-card[data-model='parakeet']");
  const canary = page.locator(".model-card[data-model='canary']");
  await expect(parakeet).toHaveAttribute("data-chosen", "true");
  await expect(parakeet.locator(".model-facts")).toContainText("1.3 GB RAM");
  await expect(parakeet.locator(".model-facts")).toContainText("23× real time");
  await expect(canary.locator(".model-facts")).toContainText("1.8 GB RAM");
  await expect(page.locator("#speech-engine-status")).toContainText("one-time download of 510 MB");
  await parakeet.locator("button", { hasText: "Download (510 MB)" }).click();
  await expect(page.locator("#settings-status")).toHaveText("Parakeet v3 is ready.");
  await expect(parakeet.locator(".model-badge")).toHaveText("In use");
  await expect(parakeet.locator("button", { hasText: "Remove" })).toBeVisible();
  const language = page.locator("#speech-language");
  await expect(language).toHaveValue("");
  await expect(page.locator("#speech-language-hint")).toContainText("finds the language by itself");
  await canary.locator("button", { hasText: "Use" }).click();
  await expect(canary).toHaveAttribute("data-chosen", "true");
  await expect(canary.locator(".model-badge")).toHaveText("Chosen, not downloaded");
  await expect(parakeet.locator(".model-badge")).toHaveText("Downloaded");
  // Canary cannot detect, so it starts from this computer's language and Detect is off.
  await expect(language).toHaveValue("en");
  await expect(language.locator("option[value='']")).toHaveJSProperty("disabled", true);
  await language.selectOption("fi");
  await expect(page.locator("#settings-status")).toContainText("Language saved");
  await expect(page.locator("#speech-language-hint")).toContainText("as Finnish");
  await parakeet.locator("button", { hasText: "Use" }).click();
  await expect(language.locator("option[value='']")).toHaveJSProperty("disabled", false);
  await language.selectOption("");
  await expect(page.locator("#settings-status")).toContainText("found from the speech");
  await page.locator("#speech-device").selectOption("Headset");
  await expect(page.locator("#settings-status")).toContainText("Microphone saved");
  await page.locator("#speech-enabled").check();
  await expect(page.locator("#settings-status")).toHaveText("Recording is on.");
  await page.locator("#speech-source button", { hasText: "Speech server" }).click();
  await expect(page.locator("#speech-server")).toBeVisible();
  await expect(page.locator("#speech-local")).toBeHidden();
  await expect(page.locator("#speech-polish-hint")).toContainText("Needs the chat model");
});

test("the listening mark waits for speech, follows the voice, and goes away at the end", async ({ page }) => {
  await openComposer(page, { draft: { content: "Notes" }, speech: ready });
  const record = page.locator("#rec-anchor .rec-toggle");
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  await record.click();
  const live = page.locator("#card .rec-live");
  await expect(live).toBeVisible();
  await expect(live).toHaveAttribute("data-state", "waiting");
  await expect(live).toContainText("Waiting for speech");
  await emitEvent(page, "speech-level", { sessionId: "speech-1", level: 0.6 });
  await expect(live).toHaveAttribute("data-state", "hearing");
  await chunk(page, "speech-1", 0, "some words");
  await expect(page.locator("#blocks")).toContainText("Notes some words");
  const mark = await live.boundingBox();
  const blocks = await page.locator("#blocks").boundingBox();
  expect(mark && blocks && mark.y >= blocks.y - 4 && mark.y <= blocks.y + blocks.height).toBeTruthy();
  await record.click();
  await expect(live).toBeHidden();
});

test("a stacked memo has its own record button that writes into that memo", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 900 });
  await openPinned(page, "host-1", {
    notes: [
      { id: "host-1", content: "# Host memo\nhost body", pinned: true, updatedAt: Date.now() },
      { id: "guest-1", content: "guest line", stackHost: "host-1", updatedAt: Date.now() - 10 },
    ],
    speech: ready,
  });
  const guest = page.locator(".stack-note[data-id='guest-1']");
  const record = guest.locator(".rec-toggle");
  await expect(record).toBeVisible();
  await guest.locator(".stack-blocks .md-lines").first().click();
  await page.keyboard.press("End");
  await record.click();
  await expect(record).toHaveClass(/rec-on/);
  const started = await page.evaluate(
    () => window.__memoseHarness?.getInvocations().find((item) => item.cmd === "speech_start")?.args,
  );
  expect(started).toMatchObject({ purpose: "memo", noteId: "guest-1" });
  await chunk(page, "speech-1", 0, "spoken words");
  await expect(guest.locator(".stack-blocks")).toContainText("guest line spoken words");
  await expect(page.locator("#blocks")).not.toContainText("spoken words");
  await record.click();
  await expect(record).not.toHaveClass(/rec-on/);
});

test("a microphone that gives no sound is reported", async ({ page }) => {
  await openComposer(page, { draft: { content: "Notes" }, speech: ready });
  await page.locator("#rec-anchor .rec-toggle").click();
  await emitEvent(page, "speech-state", { recording: false, sessionId: "speech-1", noteId: null, purpose: "memo" });
  await emitEvent(page, "speech-done", {
    sessionId: "speech-1",
    noteId: null,
    purpose: "memo",
    audio: null,
    error: "macOS is not letting Memose hear the microphone.",
  });
  await expect(page.locator("#card .rec-message")).toContainText("macOS is not letting Memose hear the microphone");
  await expect(page.locator("#card .rec-live")).toBeHidden();
});

test("settings show the microphone permission and can ask for it", async ({ page }) => {
  await openSettings(page, { speech: { microphone: "unknown" } });
  await page.locator("#tab-recording").click();
  await expect(page.locator("#speech-permission-text")).toContainText("macOS has not asked yet");
  await page.locator("#speech-permission-ask").click();
  await expect(page.locator("#settings-status")).toHaveText("Microphone allowed.");
  await expect(page.locator("#speech-permission-text")).toHaveText("Microphone allowed.");
  await expect(page.locator("#speech-permission-ask")).toBeHidden();
});

test("a refused microphone points to System Settings", async ({ page }) => {
  await openSettings(page, { speech: { microphone: "denied" } });
  await page.locator("#tab-recording").click();
  await expect(page.locator("#speech-permission-text")).toContainText("does not let Memose use the microphone");
  await page.locator("#speech-permission-open").click();
  await expect(page.locator("#settings-status")).toContainText("System Settings is open");
  expect(await invokedCmds(page)).toContain("speech_open_privacy");
});

test("the caret follows the dictated text", async ({ page }) => {
  await openComposer(page, { draft: { content: "First line\nLast line" }, speech: ready });
  await page.locator("#blocks .md-row").first().click();
  await page.keyboard.press("End");
  await page.locator("#rec-anchor .rec-toggle").click();
  await chunk(page, "speech-1", 0, "and more");
  await chunk(page, "speech-1", 1, "words here");
  await expect(page.locator("#blocks")).toContainText("First line and more words here");
  await page.keyboard.type("!");
  await expect.poll(async () => lastDraft(page)).toBe("First line and more words here!\nLast line");
  await page.locator("#rec-anchor .rec-toggle").click();
});

const voice = "![voice-1.wav](memose-media/12345678-voice-1.wav)";

test("a recording goes right under dictation that has lines of its own", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "Intro\n\nOutro" },
    speech: { ...ready, keepAudio: true, audio: voice },
  });
  await page.locator("#blocks .md-row").nth(1).click();
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  await chunk(page, "speech-1", 0, "a new paragraph");
  await expect(page.locator("#blocks")).toContainText("a new paragraph");
  await record.click();
  await expect.poll(async () => lastDraft(page)).toBe(`Intro\na new paragraph\n${voice}\nOutro`);
  // The player is on a row of its own: the text after it is not placed beside it.
  await expect(page.locator("#blocks .media-row .md-field")).toHaveCount(0);
  await expect(page.locator("#blocks")).toContainText("Outro");
});

test("recordings of words put into a text block go under that block, in order", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "Shopping list\nmilk\n\nOther notes" },
    speech: { ...ready, keepAudio: true, audio: voice },
  });
  await page.locator("#blocks .md-row").first().click();
  await page.keyboard.press("End");
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  await chunk(page, "speech-1", 0, "for the weekend");
  await expect(page.locator("#blocks")).toContainText("Shopping list for the weekend");
  await record.click();
  await expect.poll(async () => lastDraft(page)).toBe(`Shopping list for the weekend\nmilk\n${voice}\n\nOther notes`);
});

const rec = "12345678-voice-1.wav";
const recLine = `![voice-1.wav](memose-media/${rec})`;

test("a recording shows its words and can be re-analyzed into a diff to accept", async ({ page }) => {
  await openComposer(page, {
    draft: { content: `Notes\nwe ship friday\n${recLine}\nEnd` },
    speech: {
      ...ready,
      recordings: { [rec]: { heard: "we ship friday", text: "we ship friday" } },
      transcribe: "We ship on Thursday.",
    },
  });
  const tools = page.locator("#blocks .rec-tools");
  await expect(tools.locator(".rec-snippet")).toHaveText("“we ship friday”");
  await tools.locator("button", { hasText: /^Re-analyze$/ }).click();
  await expect(tools.locator(".rec-note")).toHaveText("Re-analyzed (Low effort):");
  await expect(tools.locator(".rec-diff del").first()).toBeVisible();
  await expect(tools.locator(".rec-diff ins").first()).toBeVisible();
  await tools.locator("button", { hasText: "Accept" }).click();
  await expect.poll(async () => lastDraft(page)).toBe(`Notes\nWe ship on Thursday.\n${recLine}\nEnd`);
  await expect(page.locator("#blocks .rec-snippet")).toHaveText("“We ship on Thursday.”");
});

test("accepting a re-analysis replaces words that were edited after recording", async ({ page }) => {
  await openComposer(page, {
    draft: { content: `Notes\nwe ship this friday!\n${recLine}\nEnd` },
    speech: { ...ready, recordings: { [rec]: { text: "we ship friday" } }, transcribe: "We ship on Thursday." },
  });
  const tools = page.locator("#blocks .rec-tools");
  await tools.locator("button", { hasText: /^Re-analyze$/ }).click();
  await expect(tools.locator(".rec-diff del").first()).toBeVisible();
  await expect(tools.locator(".rec-note")).toHaveCount(1);
  await tools.locator("button", { hasText: "Accept" }).click();
  await expect.poll(async () => lastDraft(page)).toBe(`Notes\nWe ship on Thursday.\n${recLine}\nEnd`);
});

test("a recording made right after another starts on its own line, and each re-analysis replaces its own words", async ({
  page,
}) => {
  await openComposer(page, {
    draft: { content: "Notes" },
    speech: {
      ...ready,
      keepAudio: true,
      polishReady: true,
      polishReplies: { "first dictation": "First dictation.", "second dictation": "Second dictation." },
      transcribe: "Brand new text.",
      audio: "![voice-{n}.wav](memose-media/1234567{n}-voice-{n}.wav)",
    },
  });
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const record = page.locator("#rec-anchor .rec-toggle");
  const one = "![voice-1.wav](memose-media/12345671-voice-1.wav)";
  const two = "![voice-2.wav](memose-media/12345672-voice-2.wav)";
  await record.click();
  await chunk(page, "speech-1", 0, "first dictation");
  await record.click();
  await expect(page.locator("#blocks .rec-tools")).toHaveCount(1);
  // The caret is after the first recording. The next words go under it, not on its line.
  await record.click();
  await chunk(page, "speech-2", 0, "second dictation");
  await record.click();
  await expect.poll(async () => lastDraft(page)).toBe(`Notes\nFirst dictation.\n${one}\nSecond dictation.\n${two}`);
  const tools = page.locator("#blocks .rec-tools").first();
  await tools.locator("button", { hasText: /^Re-analyze$/ }).click();
  await tools.locator("button", { hasText: "Accept" }).click();
  await expect.poll(async () => lastDraft(page)).toBe(`Notes\nBrand new text.\n${one}\nSecond dictation.\n${two}`);
});

test("declining a re-analysis leaves the memo as it was", async ({ page }) => {
  await openComposer(page, {
    draft: { content: `we ship friday\n${recLine}` },
    speech: { ...ready, recordings: { [rec]: { text: "we ship friday" } }, transcribe: "something else" },
  });
  const tools = page.locator("#blocks .rec-tools");
  await tools.locator("button", { hasText: /^Re-analyze$/ }).click();
  await tools.locator("button", { hasText: "Decline" }).click();
  await expect(tools.locator(".rec-diff")).toHaveCount(0);
  await expect(page.locator("#blocks")).toContainText("we ship friday");
  expect(await invokedCmds(page)).not.toContain("upsert_draft");
});

test("re-analyzing at the context level refines the new text with the memo around it", async ({ page }) => {
  await openComposer(page, {
    draft: { content: `Meeting notes\nwe ship friday\n${recLine}` },
    speech: {
      ...ready,
      polishReady: true,
      polishReply: "We ship on Thursday.",
      recordings: { [rec]: { text: "we ship friday" } },
      transcribe: "we ship on thursday",
    },
  });
  const tools = page.locator("#blocks .rec-tools");
  const slider = tools.locator(".effort-slider [role='slider']");
  await expect(slider).toHaveAttribute("aria-valuenow", "2");
  await expect(tools.locator(".effort-name")).toHaveText("(Medium)");
  await setSlider(slider, 4);
  await expect(tools.locator(".effort-name")).toHaveText("(Max)");
  await tools.locator("button", { hasText: "Re-analyze" }).click();
  await expect(tools.locator(".rec-note")).toHaveText("Re-analyzed (Max effort):");
  const polished = await page.evaluate(
    () => window.__memoseHarness?.getInvocations().find((item) => item.cmd === "speech_polish")?.args,
  );
  expect(polished).toMatchObject({ dictated: "we ship on thursday", before: "Meeting notes\n", level: 4 });
  await tools.locator("button", { hasText: "Accept" }).click();
  await expect.poll(async () => lastDraft(page)).toBe(`Meeting notes\nWe ship on Thursday.\n${recLine}`);
  await expect(page.locator("#blocks .rec-tools .effort-slider [role='slider']")).toHaveAttribute("aria-valuenow", "2");
});

test("the effort slider explains its level on hover and follows the arrow keys", async ({ page }) => {
  await openComposer(page, {
    draft: { content: `Meeting notes\nwe ship friday\n${recLine}` },
    speech: { ...ready, polishReady: true, recordings: { [rec]: { text: "we ship friday" } } },
  });
  const slider = page.locator("#blocks .rec-tools .effort-slider");
  const tip = page.locator("body > .effort-tip");
  await expect(slider).toBeVisible();
  await expect(tip).toHaveCount(0);
  await slider.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText("Medium · Punctuation, capitals, and clear mistakes. Dialect stays.");
  const track = slider.locator("[role='slider']");
  await track.focus();
  await page.keyboard.press("ArrowRight");
  await expect(track).toHaveAttribute("aria-valuenow", "3");
  await expect(slider.locator(".effort-name")).toHaveText("(High)");
  await expect(tip).toContainText("High · Medium, then spelling and grammar");
  await setSlider(track, 1);
  await expect(tip).toContainText("Low · As heard. No chat model.");
  await page.mouse.move(0, 0);
  await track.blur();
  await expect(tip).toHaveCount(0);
});

test("audio that was not recorded in the app gets no tools", async ({ page }) => {
  await openComposer(page, { draft: { content: "Song\n![song.mp3](memose-media/abcd1234-song.mp3)" }, speech: ready });
  await expect(page.locator("#blocks .media-audio")).toBeVisible();
  await expect.poll(async () => invokedCmds(page)).toContain("recordings_info");
  await expect(page.locator("#blocks .rec-tools")).toHaveCount(0);
});

function marked(page: Page, kind: string): Promise<string[]> {
  return page.evaluate((name) => {
    const highlight = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get(name);
    return highlight ? [...highlight].map((range) => range.toString()) : [];
  }, kind);
}

test("dictation far down a long memo keeps it scrolled there and marks the words", async ({ page }) => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  await openComposer(page, { draft: { content: lines.join("\n") }, speech: ready });
  const row = page.locator("#blocks .md-row", { hasText: /^line 50$/ });
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.keyboard.press("End");
  const scroller = page.locator("#blocks");
  const before = await scroller.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(200);
  await page.locator("#rec-anchor .rec-toggle").click();
  for (const [seq, text] of ["first words", "second words", "third words"].entries()) {
    await chunk(page, "speech-1", seq, text);
    await expect(page.locator("#blocks")).toContainText(text);
    const top = await scroller.evaluate((el) => el.scrollTop);
    expect(Math.abs(top - before)).toBeLessThan(120);
  }
  await expect(
    page.locator("#blocks .md-row", { hasText: "line 50 first words second words third words" }),
  ).toBeInViewport();
  await expect.poll(async () => marked(page, "dictation")).toEqual(["first words second words third words"]);
  await page.locator("#rec-anchor .rec-toggle").click();
  await expect.poll(async () => marked(page, "dictation")).toEqual([]);
});

test("clicking the listening mark stops the recording", async ({ page }) => {
  await openComposer(page, { draft: { content: "Notes" }, speech: ready });
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  await page.locator("#card .rec-live .rec-pill").click();
  await expect(record).not.toHaveClass(/rec-on/);
  await expect(page.locator("#card .rec-live")).toBeHidden();
  expect(await invokedCmds(page)).toContain("speech_stop");
});

test("Enter stops the recording instead of starting a new line", async ({ page }) => {
  await openComposer(page, { draft: { content: "Notes" }, speech: ready });
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  await chunk(page, "speech-1", 0, "said words");
  await expect(page.locator("#blocks")).toContainText("Notes said words");
  await page.keyboard.press("Enter");
  await expect(record).not.toHaveClass(/rec-on/);
  await expect.poll(async () => lastDraft(page)).toBe("Notes said words");
  await page.keyboard.press("Enter");
  await expect.poll(async () => lastDraft(page)).toBe("Notes said words\n");
});

test("the words a re-analysis would replace are marked until it is accepted", async ({ page }) => {
  await openComposer(page, {
    draft: { content: `Notes\nwe ship friday\n${recLine}` },
    speech: { ...ready, recordings: { [rec]: { text: "we ship friday" } }, transcribe: "We ship on Thursday." },
  });
  const tools = page.locator("#blocks .rec-tools");
  await tools.locator("button", { hasText: /^Re-analyze$/ }).click();
  await expect.poll(async () => marked(page, "rewording")).toEqual(["we ship friday"]);
  await tools.locator("button", { hasText: "Accept" }).click();
  await expect.poll(async () => marked(page, "rewording")).toEqual([]);
});

test("a long pause starts a new paragraph, and each ended paragraph gets the full pass", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "" },
    speech: {
      ...ready,
      polishReady: true,
      polishLevel: 3,
      polishReplies: {
        "first part": "First part.",
        "First part.": "First part, proof-read.",
        "second part": "Second part.",
        "Second part.": "Second part, proof-read.",
      },
    },
  });
  await page.locator("#blocks .md-lines").first().click();
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  await chunk(page, "speech-1", 0, "first part");
  await expect(page.locator("#blocks")).toContainText("First part.");
  await chunk(page, "speech-1", 1, "second part", 3200);
  await expect.poll(async () => lastDraft(page)).toContain("First part, proof-read.\n\n");
  await record.click();
  await expect.poll(async () => lastDraft(page)).toBe("First part, proof-read.\n\nSecond part, proof-read.");
  const levels = await page.evaluate(() =>
    window.__memoseHarness
      ?.getInvocations()
      .filter((item) => item.cmd === "speech_polish")
      .map((item) => (item.args as { level: number }).level),
  );
  expect(levels).toContain(2);
  expect(levels).toContain(3);
});

for (const level of [2, 3] as const) {
  test(`a sentence said again after a pause ${level >= 3 ? "replaces" : "does not replace"} its first try at level ${level}`, async ({
    page,
  }) => {
    await openComposer(page, {
      draft: { content: "" },
      speech: {
        ...ready,
        polishReady: true,
        polishLevel: level,
        polishReplies: {
          "what is the worst time": "What is the worst? Time.",
          "when is the worst time": "When is the worst time?",
          // The full pass of the first paragraph sees the second one say it again.
          "What is the worst? Time.|when is the worst time": "",
        },
      },
    });
    await page.locator("#blocks .md-lines").first().click();
    const record = page.locator("#rec-anchor .rec-toggle");
    await record.click();
    await chunk(page, "speech-1", 0, "what is the worst time");
    await expect(page.locator("#blocks")).toContainText("What is the worst? Time.");
    await chunk(page, "speech-1", 1, "when is the worst time", 3200);
    await record.click();
    if (level >= 3) {
      await expect.poll(async () => lastDraft(page)).toBe("When is the worst time?");
    } else {
      await expect.poll(async () => lastDraft(page)).toBe("What is the worst? Time.\n\nWhen is the worst time?");
    }
    const sent = await page.evaluate(() =>
      window.__memoseHarness
        ?.getInvocations()
        .filter((item) => item.cmd === "speech_polish")
        .map((item) => item.args as { corrections: boolean; later: string }),
    );
    expect(sent?.every((args) => args.corrections === level >= 3)).toBe(true);
    expect(sent?.some((args) => args.later === "when is the worst time")).toBe(level >= 3);
  });
}

test("the slider under the listening mark changes the level and keeps it for the next recording", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "Notes" },
    speech: { ...ready, polishReady: true, polishLevel: 2 },
  });
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  const slider = page.locator("#card .rec-live .effort-slider [role='slider']");
  await expect(slider).toHaveAttribute("aria-valuenow", "2");
  await setSlider(slider, 1);
  await expect(page.locator("#card .rec-live .effort-name")).toHaveText("(Low)");
  await chunk(page, "speech-1", 0, "plain words");
  await expect(page.locator("#blocks")).toContainText("Notes plain words");
  await record.click();
  expect(await invokedCmds(page)).not.toContain("speech_polish");
  const saved = await page.evaluate(
    () =>
      window.__memoseHarness
        ?.getInvocations()
        .filter((item) => item.cmd === "save_speech_settings")
        .pop()?.args,
  );
  expect(saved).toMatchObject({ polishLevel: 1 });
  await record.click();
  await expect(page.locator("#card .rec-live .effort-slider [role='slider']")).toHaveAttribute("aria-valuenow", "1");
  await record.click();
});

test("without the chat model there is no slider and the words stay as heard", async ({ page }) => {
  await openComposer(page, { draft: { content: "Notes" }, speech: ready });
  await page.locator("#blocks .md-lines").first().click();
  await page.locator("#rec-anchor .rec-toggle").click();
  await expect(page.locator("#card .rec-live .rec-pill")).toBeVisible();
  await expect(page.locator("#card .rec-live .effort-slider")).toBeHidden();
});

test("a second recording started while the first is still finishing keeps both in order", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "Notes" },
    speech: {
      ...ready,
      keepAudio: true,
      polishReady: true,
      polishDelayMs: 700,
      audio: "![voice-{n}.wav](memose-media/1234567{n}-voice-{n}.wav)",
    },
  });
  await page.locator("#blocks .md-lines").first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  await chunk(page, "speech-1", 0, "first dictation");
  await expect(page.locator("#blocks")).toContainText("first dictation");
  await record.click();
  // The first recording is still waiting for its last pass. A second one starts on a new line.
  await page.keyboard.press("Enter");
  await record.click();
  await expect(record).toHaveClass(/rec-on/);
  await chunk(page, "speech-2", 0, "second dictation");
  await expect(page.locator("#blocks")).toContainText("second dictation");
  await page.locator("#card .rec-live .rec-pill").click();
  await expect(record).not.toHaveClass(/rec-on/);
  const one = "![voice-1.wav](memose-media/12345671-voice-1.wav)";
  const two = "![voice-2.wav](memose-media/12345672-voice-2.wav)";
  await expect.poll(async () => lastDraft(page), { timeout: 8000 }).toContain(two);
  const final = (await lastDraft(page)) ?? "";
  expect(final.indexOf("first dictation")).toBeLessThan(final.indexOf(one));
  expect(final.indexOf(one)).toBeLessThan(final.indexOf("second dictation"));
  expect(final.indexOf("second dictation")).toBeLessThan(final.indexOf(two));
  for (const line of final.split("\n")) {
    const hasAudio = line.includes("memose-media/");
    expect(!hasAudio || /^!\[[^\]]*\]\(memose-media\/[^)]+\)$/.test(line), `audio on its own line: ${line}`).toBe(true);
  }
});

test("recordings that follow each other join into one bubble", async ({ page }) => {
  await openComposer(page, {
    draft: {
      content:
        "Palaveri\nsovittiin\n![v1.wav](memose-media/12345671-v1.wav)\n![v2.wav](memose-media/12345672-v2.wav)\nLopuksi\n![v3.wav](memose-media/12345673-v3.wav)",
    },
    speech: {
      ...ready,
      recordings: {
        "12345671-v1.wav": { text: "sovittiin" },
        "12345672-v2.wav": { text: "lisää" },
        "12345673-v3.wav": { text: "Lopuksi" },
      },
    },
  });
  await expect(page.locator("#blocks .rec-tools")).toHaveCount(3);
  const rows = page.locator("#blocks .media-row:has(.rec-tools)");
  await expect(rows.nth(0)).toHaveClass(/rec-joins-next/);
  await expect(rows.nth(1)).toHaveClass(/rec-joined/);
  await expect(rows.nth(2)).not.toHaveClass(/rec-joined/);
  const first = await rows.nth(0).boundingBox();
  const second = await rows.nth(1).boundingBox();
  expect(first && second && Math.abs(second.y - (first.y + first.height)) < 4).toBeTruthy();
});
