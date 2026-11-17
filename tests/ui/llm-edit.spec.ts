import { expect, test } from "@playwright/test";

import { composerTextarea, editorText, invokedCmds, openComposer, openSettings } from "./helpers";

const localModel = { llmEnabled: true, llmBaseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b" };

test("the AI button stays hidden until model prompts are on", async ({ page }) => {
  await openComposer(page, { draft: { content: "plain memo" } });
  await expect(page.locator("#mode-toggle")).toBeVisible();
  await expect.poll(async () => invokedCmds(page)).toContain("get_ai_settings");
  await expect(page.locator("#ai-anchor")).toBeHidden();
});

test("an edit prompt shows a diff in the bubble and accept all applies it", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "teh first line\nkept line\n![pic](memose-media/a.png)" },
    ai: { ...localModel, llmReply: "the first line\nkept line" },
  });
  await page.locator("#ai-anchor .ai-toggle").click();
  const bubble = page.locator("#card .ai-bubble");
  await expect(bubble).toBeVisible();
  await bubble.locator(".ai-chip", { hasText: "Clean up wording" }).click();
  await expect(bubble.locator(".ai-removed")).toHaveText("teh first line");
  await expect(bubble.locator(".ai-added")).toHaveText("the first line");
  await expect(bubble.locator(".ai-diff")).not.toContainText("memose-media");
  await bubble.locator("button", { hasText: "Accept all" }).click();
  await expect(bubble.locator(".ai-entry")).toContainText("Changes applied.");
  await expect.poll(async () => editorText(composerTextarea(page))).toContain("the first line");
  await expect(page.locator("#blocks")).toContainText("kept line");
  await expect.poll(async () => invokedCmds(page)).toContain("llm_mark");
});

test("a question is answered in the bubble and leaves the memo alone", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "- [ ] one\n- [ ] two" },
    ai: { ...localModel, llmReply: "There are 2 tasks.", llmKind: "answer" },
  });
  await page.locator("#ai-anchor .ai-toggle").click();
  const bubble = page.locator("#card .ai-bubble");
  await bubble.locator(".ai-input").fill("How many tasks are there?");
  await page.keyboard.press("Enter");
  await expect(bubble.locator(".ai-q-text")).toHaveText("How many tasks are there?");
  await expect(bubble.locator(".ai-answer")).toHaveText("There are 2 tasks.");
  await expect(bubble.locator(".ai-diff")).toHaveCount(0);
  await expect.poll(async () => editorText(composerTextarea(page))).not.toContain("There are 2 tasks.");
  await bubble.locator("button", { hasText: "Add to memo" }).click();
  await expect(page.locator("#blocks")).toContainText("There are 2 tasks.");
});

test("dismissing a proposed edit leaves the memo as it was", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "one\ntwo" },
    ai: { ...localModel, llmReply: "ONE\ntwo" },
  });
  await page.locator("#ai-anchor .ai-toggle").click();
  const bubble = page.locator("#card .ai-bubble");
  await bubble.locator(".ai-mode").selectOption("edit");
  await bubble.locator(".ai-input").fill("Shout the first line");
  await page.keyboard.press("Enter");
  await expect(bubble.locator(".ai-added")).toHaveText("ONE");
  await bubble.locator("button", { hasText: "Dismiss" }).click();
  await expect(bubble.locator(".ai-entry")).toContainText("Changes dismissed.");
  await expect.poll(async () => editorText(composerTextarea(page))).toContain("one");
});

test("a running prompt spins the AI button and can be cancelled", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "some text" },
    ai: { ...localModel, llmHold: true },
  });
  const toggle = page.locator("#ai-anchor .ai-toggle");
  await toggle.click();
  const bubble = page.locator("#card .ai-bubble");
  await bubble.locator(".ai-chip", { hasText: "Summarize" }).click();
  await expect(bubble.locator(".ai-working")).toContainText("Working");
  await expect(toggle).toHaveClass(/ai-busy/);
  await bubble.locator(".ai-close").click();
  await expect(bubble).toHaveCount(0);
  await expect(toggle).toHaveClass(/ai-busy/);
  await toggle.click();
  await bubble.locator(".ai-working button", { hasText: "Cancel" }).click();
  await expect(bubble.locator(".ai-entry")).toContainText("Cancelled.");
  await expect(toggle).not.toHaveClass(/ai-busy/);
});

test("the bubble fits inside a new memo window", async ({ page }) => {
  await openComposer(page, { draft: { content: "short" }, ai: localModel });
  await page.locator("#ai-anchor .ai-toggle").click();
  const box = await page.locator("#card .ai-bubble").boundingBox();
  const card = await page.locator("#card").boundingBox();
  expect(box && card && box.x >= card.x && box.x + box.width <= card.x + card.width).toBeTruthy();
  expect(box && card && box.y + box.height <= card.y + card.height).toBeTruthy();
  const header = await page.locator("#card > header").boundingBox();
  const pin = await page.locator("#pin-toggle").boundingBox();
  expect(header && pin && pin.x + pin.width <= header.x + header.width).toBeTruthy();
});

test("models tab lists the server's models and picks one", async ({ page }) => {
  await openSettings(page, { ai: { models: ["llama3.2:3b", "qwen2.5:7b"] } });
  await page.locator("#tab-models").click();
  await page.locator("#llm-base-url").fill("http://localhost:11434/v1");
  await page.locator("#llm-model").fill("mistral");
  await page.locator("#llm-refresh").click();
  await expect(page.locator("#settings-status")).toHaveText("Connected. 2 models found.");
  await expect(page.locator("#llm-model-hint")).toContainText("ollama pull mistral");
  await expect(page.locator("#llm-where")).toContainText("stays on this computer");
  await page.locator("#llm-model-choices button", { hasText: "qwen2.5:7b" }).click();
  await expect(page.locator("#llm-model")).toHaveValue("qwen2.5:7b");
  await expect(page.locator("#settings-status")).toHaveText("Model set to qwen2.5:7b.");
  await expect(page.locator("#llm-presets textarea").first()).toHaveAttribute("rows", "4");
  await page.locator("#llm-enabled").check();
  await expect(page.locator("#settings-status")).toHaveText("Model prompts are on.");
});

async function selectLineText(page: import("@playwright/test").Page, needle: string) {
  await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.querySelector("#blocks")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
    }
    throw new Error(`text not found in the editor: ${text}`);
  }, needle);
}

test("escape and a click on the memo close the bubble before anything else", async ({ page }) => {
  await openComposer(page, { draft: { content: "some text" }, ai: localModel });
  const toggle = page.locator("#ai-anchor .ai-toggle");
  const bubble = page.locator("#card .ai-bubble");
  await toggle.click();
  await expect(bubble).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bubble).toHaveCount(0);
  await expect(page.locator("#card")).toBeVisible();
  await expect.poll(async () => invokedCmds(page)).not.toContain("hide_composer");
  await toggle.click();
  await expect(bubble).toBeVisible();
  await page.locator("#blocks").click({ position: { x: 20, y: 10 } });
  await expect(bubble).toHaveCount(0);
});

test("selected text becomes the source and only its lines are changed", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "first line\nteh second line\nthird line" },
    ai: { ...localModel, llmReply: "the second line" },
  });
  await composerTextarea(page).waitFor();
  await selectLineText(page, "teh second line");
  const float = page.locator("#card .ai-float");
  await expect(float).toBeVisible();
  await float.click();
  const bubble = page.locator("#card .ai-bubble");
  await expect(bubble.locator(".ai-scope-label")).toHaveText("Line 2");
  await bubble.locator(".ai-mode").selectOption("edit");
  await bubble.locator(".ai-input").fill("Fix the typo");
  await page.keyboard.press("Enter");
  await expect(bubble.locator(".ai-q .ai-tag").first()).toHaveText("Line 2");
  await expect(bubble.locator(".ai-removed")).toHaveText("teh second line");
  await bubble.locator("button", { hasText: "Accept all" }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__memoseHarness
            ?.getInvocations()
            .filter((i) => i.cmd === "upsert_draft")
            .pop()?.args,
      ),
    )
    .toMatchObject({ content: "first line\nthe second line\nthird line" });
});

test("the selection can be removed to go back to the whole memo", async ({ page }) => {
  await openComposer(page, { draft: { content: "alpha line\nbeta line" }, ai: localModel });
  await composerTextarea(page).waitFor();
  await selectLineText(page, "beta line");
  await page.locator("#card .ai-float").click();
  const bubble = page.locator("#card .ai-bubble");
  await expect(bubble.locator(".ai-scope")).toBeVisible();
  await bubble.locator(".ai-scope-clear").click();
  await expect(bubble.locator(".ai-scope")).toHaveCount(0);
  await expect(bubble.locator(".ai-input")).toHaveAttribute("placeholder", /this memo/);
});

test("an offline-only memo asks before its text goes to a remote model", async ({ page }) => {
  await openComposer(page, {
    draft: { content: "private words", visibility: "OFFLINE_PRIVATE" },
    settings: { visibility: "OFFLINE_PRIVATE" },
    ai: {
      llmEnabled: true,
      llmBaseUrl: "https://api.example.com/v1",
      llmModel: "big-model",
      llmReply: "ok",
      llmKind: "answer",
    },
  });
  await page.locator("#ai-anchor .ai-toggle").click();
  const bubble = page.locator("#card .ai-bubble");
  await bubble.locator(".ai-chip", { hasText: "Summarize" }).click();
  await expect(bubble.locator(".ai-foot")).toContainText("Send its text to api.example.com?");
  expect(await invokedCmds(page)).not.toContain("llm_ask");
  await bubble.locator(".ai-foot button", { hasText: "Cancel" }).click();
  await bubble.locator(".ai-input").fill("Another prompt");
  await page.keyboard.press("Enter");
  await expect(bubble.locator(".ai-foot")).toContainText("Send its text to api.example.com?");
  expect(await invokedCmds(page)).not.toContain("llm_ask");
  await bubble.locator(".ai-foot button", { hasText: "Send" }).click();
  await expect.poll(async () => invokedCmds(page)).toContain("llm_ask");
  await expect(bubble.locator(".ai-answer")).toHaveText("ok");
});

test("a saved key can be removed in settings", async ({ page }) => {
  await openSettings(page, { ai: { llmBaseUrl: "https://api.example.com/v1", hasLlmKey: true } });
  await page.locator("#tab-models").click();
  await expect(page.locator("#llm-key-hint")).toHaveText("A key is saved on this computer.");
  await page.locator("#llm-key-remove").click();
  await expect(page.locator("#settings-status")).toHaveText("Key removed.");
  await expect(page.locator("#llm-key-remove")).toBeHidden();
  await expect(page.locator("#llm-key-hint")).toContainText("No key saved");
});
