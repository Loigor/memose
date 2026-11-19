/** Entry of the lazily loaded AI chunk: the prompt bubble, dictation, and recording tools of one memo. */

import { mountDictation, type DictationTarget } from "./dictation";
import { mountLlmBubble, type LlmTarget } from "./llm-edit";
import { mountRecordingTools, type RecordingToolsTarget } from "./recording-tools";

export type MemoAiTarget = {
  aiAnchor: HTMLElement | null;
  recAnchor: HTMLElement | null;
  llm: LlmTarget;
  dictation: DictationTarget;
  tools: RecordingToolsTarget;
};

/** Mounts every AI tool of one memo. The returned function removes them and their listeners. */
export function mountMemoAi(target: MemoAiTarget): () => void {
  const teardown = [
    target.aiAnchor ? mountLlmBubble(target.aiAnchor, target.llm).destroy : null,
    mountRecordingTools(target.tools),
    target.recAnchor ? mountDictation(target.recAnchor, target.dictation) : null,
  ];
  return () => {
    for (const destroy of teardown) {
      destroy?.();
    }
  };
}
