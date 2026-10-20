import { expect, test, type Page } from "@playwright/test";

import { composerTextarea, openComposer, openPinned } from "./helpers";
import { emitEvent, type NoteSeed } from "./tauri-harness";

test.describe("@scale memory and DOM budgets", () => {
  test.describe.configure({ timeout: 120_000 });

  async function metrics(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics: rows } = await cdp.send("Performance.getMetrics");
    const map = Object.fromEntries(rows.map((row) => [row.name, row.value]));
    return {
      heap: map.JSHeapUsedSize ?? 0,
      nodes: map.Nodes ?? 0,
      listeners: map.JSEventListeners ?? 0,
    };
  }

  test("@scale recent list of 200 memos stays within DOM and heap budgets", async ({ page }) => {
    await openComposer(page, { noteCount: 1000 });
    await page.locator("#recent-more").click();
    await expect(page.locator("#recent li")).toHaveCount(200);
    const after = await metrics(page);
    expect(after.nodes).toBeLessThan(25_000);
    expect(after.heap).toBeLessThan(40 * 1024 * 1024);
    const started = Date.now();
    await page.locator("#recent-search").fill("Memo 00012");
    await expect(page.locator("#recent li")).toHaveCount(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("@scale 1000-row recent list stress render", async ({ page }) => {
    await openComposer(page, { noteCount: 1000, listRecentLimit: 1000 });
    await page.locator("#recent-more").click();
    await expect(page.locator("#recent li")).toHaveCount(1000);
    const after = await metrics(page);
    expect(after.nodes).toBeLessThan(80_000);
    expect(after.heap).toBeLessThan(80 * 1024 * 1024);
    const started = Date.now();
    await page.locator("#recent-search").fill("Memo 00042");
    await expect(page.locator("#recent li")).toHaveCount(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("@scale notes-changed churn does not leak DOM or heap", async ({ page }) => {
    await openComposer(page, { noteCount: 200 });
    await page.locator("#recent-more").click();
    await expect(page.locator("#recent li")).toHaveCount(200);
    const baseline = await metrics(page);
    for (let i = 0; i < 50; i += 1) {
      await emitEvent(page, "notes-changed");
    }
    await expect(page.locator("#recent li")).toHaveCount(200);
    const after = await metrics(page);
    expect(after.nodes).toBeLessThan(baseline.nodes * 1.2 + 50);
    expect(after.heap - baseline.heap).toBeLessThan(8 * 1024 * 1024);
    expect(after.listeners - baseline.listeners).toBeLessThan(200);
  });

  test("@scale large memo preview loop and undo cap stay bounded", async ({ page }) => {
    const tasks = Array.from({ length: 100 }, (_, i) => `- [ ] task ${i}`).join("\n");
    const content = `${tasks}\n${"x".repeat(Math.max(0, 8192 - tasks.length - 1))}`;
    await openComposer(page);
    const area = await composerTextarea(page);
    await area.fill(content);
    const mode = page.locator("#mode-toggle");
    if (!(await mode.isVisible())) {
      await page.locator("#editor-menu-toggle").click();
    }
    const baseline = await metrics(page);
    for (let i = 0; i < 50; i += 1) {
      await mode.click();
    }
    await expect(page.locator("#preview, #blocks textarea").first()).toBeVisible();
    for (let i = 0; i < 70; i += 1) {
      await area.fill(`edit ${i}\n${content.slice(0, 200)}`);
    }
    await page.keyboard.press("ControlOrMeta+Z");
    const after = await metrics(page);
    expect(after.heap - baseline.heap).toBeLessThan(12 * 1024 * 1024);
  });

  test("@scale eight-guest stack stays in one heap", async ({ page }) => {
    const host: NoteSeed = {
      id: "scale-host",
      content: "# Host\n" + "- [ ] item\n".repeat(20),
      pinned: true,
    };
    const guests: NoteSeed[] = [];
    let parent = "scale-host";
    for (let i = 0; i < 8; i += 1) {
      const id = `scale-guest-${i}`;
      guests.push({
        id,
        content: `# Guest ${i}\n` + "paragraph\n".repeat(30),
        stackHost: parent,
      });
      parent = id;
    }
    await openPinned(page, "scale-host", { notes: [host, ...guests] });
    await expect(page.locator(".stack-note")).toHaveCount(8);
    await page.locator("#fold-toggle").click();
    await page.locator("#fold-toggle").click();
    const after = await metrics(page);
    expect(after.heap).toBeLessThan(80 * 1024 * 1024);
    expect(after.nodes).toBeLessThan(30_000);
  });
});
