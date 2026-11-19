/** The body of one chat entry: running work, an answer, a proposed edit to review, or how it ended. */

import { invoke } from "@tauri-apps/api/core";

import {
  applyToBlock,
  byteLength,
  diffLines,
  formatKilobytes,
  hunksOf,
  splitLines,
  type DiffPart,
  type ProtectedSplit,
} from "../editor/line-diff";
import { button, el } from "../dom";
import { decidedBody, diffList, modelOutput, placeOf } from "./llm-diff-view";
import { contentLimit, seconds, type ChatEntry } from "./llm-settings";

/** The changes of a proposed edit the user took and the ones they decided on so far. */
export type Decisions = {
  accepted: Set<number>;
  decided: Set<number>;
};

/** What an entry body needs from its bubble. */
export type EntryContext = {
  /** Review progress per entry id. It outlives a repaint. */
  decisions: Map<string, Decisions>;
  /** Answers the user chose to review as an edit of the memo. */
  asEdit: Set<string>;
  /** The memo now, with protected lines set aside. */
  source(): ProtectedSplit;
  text(): string;
  /** Replaces the memo text as one undo step. */
  replace(next: string): void;
  /** Shows a short note under the log. */
  setNotice(text: string): void;
  repaint(): void;
  runAgain(entry: ChatEntry): void;
};

function diffBody(entry: ChatEntry, ctx: EntryContext): HTMLElement {
  const box = el("div", "ai-diff-box");
  const before = splitLines(entry.source);
  const parts: DiffPart[] = diffLines(before, splitLines(entry.text));
  const all = hunksOf(parts);
  if (all.length === 0) {
    // The reply matched the memo, or was not a rewrite of it. Either way the words are shown.
    box.append(el("p", "ai-note", "The model suggested no changes. Its reply:"));
    box.append(el("div", "ai-answer", entry.text));
    return box;
  }
  let state = ctx.decisions.get(entry.id);
  if (!state) {
    state = { accepted: new Set(), decided: new Set() };
    ctx.decisions.set(entry.id, state);
  }
  const { accepted, decided } = state;

  const finish = () => {
    const current = ctx.source();
    const at = placeOf(current.lines, before, entry.lineStart);
    if (at < 0) {
      ctx.setNotice("The memo changed after this prompt was sent, so nothing was applied. Run the prompt again.");
      ctx.decisions.delete(entry.id);
      ctx.asEdit.delete(entry.id);
      if (entry.status === "edit") {
        void invoke("llm_mark", { noteId: entry.noteId, requestId: entry.id, status: "dismissed" });
      } else {
        ctx.repaint();
      }
      return;
    }
    const status = accepted.size > 0 ? "applied" : "dismissed";
    if (accepted.size > 0) {
      ctx.replace(applyToBlock(current.lines, at, before.length, parts, accepted, current.kept));
    }
    ctx.decisions.delete(entry.id);
    ctx.asEdit.delete(entry.id);
    if (entry.status === "edit") {
      void invoke("llm_mark", {
        noteId: entry.noteId,
        requestId: entry.id,
        status,
        accepted: [...accepted],
      });
    } else {
      ctx.setNotice(status === "applied" ? "Changes applied." : "");
      ctx.repaint();
    }
  };

  const bar = el("div", "ai-actions");
  const summary = el("span", "ai-summary");
  const left = all.length - decided.size;
  summary.textContent = `${left} ${left === 1 ? "change" : "changes"} to review`;
  bar.append(
    summary,
    button("ai-primary", decided.size === 0 ? "Accept all" : "Accept the rest", () => {
      for (const hunk of all) {
        if (!decided.has(hunk.id)) {
          accepted.add(hunk.id);
        }
      }
      finish();
    }),
    button("", accepted.size === 0 ? "Dismiss" : "Done", finish),
  );
  const list = diffList(parts, (item, hunk) => {
    if (decided.has(hunk.id)) {
      item.dataset.decided = accepted.has(hunk.id) ? "accepted" : "rejected";
    }
    const decide = (take: boolean) => {
      decided.add(hunk.id);
      if (take) {
        accepted.add(hunk.id);
      } else {
        accepted.delete(hunk.id);
      }
      if (decided.size === all.length) {
        finish();
      } else {
        ctx.repaint();
      }
    };
    const row = el("div", "ai-hunk-actions");
    row.append(
      button("ai-primary", "Accept", () => decide(true)),
      button("", "Keep original", () => decide(false)),
    );
    item.append(row);
  });
  box.append(list);
  // The decision comes after the changes, where reading them ends.
  box.append(bar);

  const now = ctx.source();
  const place = Math.max(0, placeOf(now.lines, before, entry.lineStart));
  const everything = new Set(all.map((hunk) => hunk.id));
  const size = byteLength(applyToBlock(now.lines, place, before.length, parts, everything, now.kept));
  const limit = contentLimit();
  if (limit > 0 && size > limit) {
    box.append(
      el(
        "p",
        "ai-warning",
        `With every change the memo is ${formatKilobytes(size)}. This server accepts ${formatKilobytes(limit)}, so it would stay on this computer until shortened.`,
      ),
    );
  }
  box.append(modelOutput(entry));
  return box;
}

export function entryBody(entry: ChatEntry, ctx: EntryContext): HTMLElement {
  const body = el("div", "ai-a");
  if (entry.status === "running") {
    const row = el("div", "ai-working");
    const time = el("span", "ai-time", `Working… ${seconds(entry.startedAt, Date.now())}`);
    time.dataset.started = String(entry.startedAt);
    row.append(el("span", "ai-spinner"), time);
    row.append(button("", "Cancel", () => void invoke("llm_cancel", { requestId: entry.id })));
    body.append(row);
    return body;
  }
  if (entry.status === "edit" || ctx.asEdit.has(entry.id)) {
    body.append(diffBody(entry, ctx));
    return body;
  }
  if (entry.status === "answer") {
    body.append(el("div", "ai-answer", entry.text));
    const actions = el("div", "ai-links");
    const copy = button("ai-link", "Copy", () => {
      void navigator.clipboard?.writeText(entry.text).then(() => {
        copy.textContent = "Copied";
      });
    });
    actions.append(
      copy,
      button("ai-link", "Add to memo", () => {
        const current = ctx.text().replace(/\s+$/, "");
        ctx.replace(current === "" ? entry.text : `${current}\n\n${entry.text}`);
        ctx.setNotice("Added to the end of the memo.");
        ctx.repaint();
      }),
      button("ai-link", entry.lineStart ? "Replace selection…" : "Replace memo…", () => {
        ctx.asEdit.add(entry.id);
        ctx.repaint();
      }),
    );
    body.append(actions);
    return body;
  }
  if (entry.status === "error") {
    body.append(el("p", "ai-note ai-error", entry.text));
    body.append(button("", "Run again", () => ctx.runAgain(entry)));
    return body;
  }
  if (entry.status === "applied" || entry.status === "dismissed") {
    body.append(decidedBody(entry));
    return body;
  }
  body.append(el("p", "ai-note", "Cancelled."));
  return body;
}
