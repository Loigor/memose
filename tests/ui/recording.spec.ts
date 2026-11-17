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

function chunk(page: Page, sessionId: string, seq: number, text: string) {
  return emitEvent(page, "speech-chunk", { sessionId, seq, text });
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

test("recording settings download the model and pick the microphone", async ({ page }) => {
  await openSettings(page);
  await page.locator("#tab-recording").click();
  await expect(page.locator("#speech-engine-status")).toContainText("one-time download of 510 MB");
  await page.locator("#speech-download").click();
  await expect(page.locator("#settings-status")).toHaveText("The speech model is ready.");
  await expect(page.locator("#speech-engine-status")).toContainText("Ready.");
  await expect(page.locator("#speech-remove")).toBeVisible();
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

test("a recording of words put inside a line goes to the end of the memo", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "Shopping list\nmilk\nbread" },
    speech: { ...ready, keepAudio: true, audio: voice },
  });
  await page.locator("#blocks .md-row").first().click();
  await page.keyboard.press("End");
  const record = page.locator("#rec-anchor .rec-toggle");
  await record.click();
  await chunk(page, "speech-1", 0, "for the weekend");
  await expect(page.locator("#blocks")).toContainText("Shopping list for the weekend");
  await record.click();
  await expect.poll(async () => lastDraft(page)).toBe(`Shopping list for the weekend\nmilk\nbread\n${voice}`);
});
