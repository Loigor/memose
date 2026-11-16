import { expect, test } from "@playwright/test";

import { composerTextarea, editorText, invokedCmds, openComposer, openSettings, revealEditorButton } from "./helpers";

const localModel = { llmEnabled: true, llmBaseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b" };

test("the AI button stays hidden until model edits are on", async ({ page }) => {
  await openComposer(page, { draft: { content: "plain memo" } });
  await expect(page.locator("#mode-toggle")).toBeVisible();
  await expect(page.locator("#ai-anchor")).toBeHidden();
  await expect.poll(async () => invokedCmds(page)).toContain("get_ai_settings");
  await expect(page.locator("#ai-anchor")).toBeHidden();
});

test("a prompt shows a diff and accept all applies it", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "teh first line\nkept line\n![pic](memose-media/a.png)" },
    ai: { ...localModel, llmReply: "the first line\nkept line" },
  });
  const toggle = page.locator("#ai-anchor .ai-toggle");
  await revealEditorButton(page, toggle);
  await toggle.click();
  await page.locator("#ai-anchor .ai-pop button", { hasText: "Clean up wording" }).click();
  await expect(page.locator(".ai-review .ai-removed")).toHaveText("teh first line");
  await expect(page.locator(".ai-review .ai-added")).toHaveText("the first line");
  await expect(page.locator(".ai-review")).not.toContainText("memose-media");
  await page.locator(".ai-review button", { hasText: "Accept all" }).click();
  await expect(page.locator(".ai-review")).toHaveCount(0);
  await expect.poll(async () => editorText(composerTextarea(page))).toContain("the first line");
  await expect(page.locator("#blocks")).toContainText("kept line");
  await expect.poll(async () => invokedCmds(page)).toContain("llm_edit");
});

test("cancel leaves the memo as it was", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "one\ntwo" },
    ai: { ...localModel, llmReply: "ONE\ntwo" },
  });
  const toggle = page.locator("#ai-anchor .ai-toggle");
  await revealEditorButton(page, toggle);
  await toggle.click();
  await page.locator("#ai-anchor .ai-ask input").fill("Shout the first line");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ai-review .ai-added")).toHaveText("ONE");
  await page.locator(".ai-review button", { hasText: "Cancel" }).click();
  await expect(page.locator(".ai-review")).toHaveCount(0);
  await expect.poll(async () => editorText(composerTextarea(page))).toContain("one");
});

test("models tab saves the server and lists models", async ({ page }) => {
  await openSettings(page, { ai: { models: ["llama3.2:3b"] } });
  await page.locator("#tab-models").click();
  await page.locator("#llm-base-url").fill("http://localhost:11434/v1");
  await page.locator("#llm-model").fill("qwen2.5:7b");
  await page.locator("#llm-refresh").click();
  await expect(page.locator("#settings-status")).toHaveText("Connected. 1 model found.");
  await expect(page.locator("#llm-model-hint")).toContainText("ollama pull qwen2.5:7b");
  await expect(page.locator("#llm-where")).toContainText("stays on this computer");
  await page.locator("#llm-enabled").check();
  await expect(page.locator("#settings-status")).toHaveText("Model edits are on.");
});
