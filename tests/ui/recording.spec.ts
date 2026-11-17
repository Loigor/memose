import { expect, test, type Page } from "@playwright/test";

import { invokedCmds, openComposer, openSettings } from "./helpers";
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
