export function sizeBlockTextarea(area: HTMLTextAreaElement) {
  area.rows = 1;
  const isGrow = area.classList.contains("grow");
  const isInline = area.classList.contains("inline-line-slot");
  const isEmpty = area.value.length === 0;
  area.classList.toggle("empty-slot", isEmpty && !isGrow && !isInline);
  if (isEmpty && !isGrow && !isInline) {
    area.style.height = "";
    return;
  }
  area.style.height = "0px";
  const minH = isGrow ? 64 : 22;
  const needed = Math.max(minH, area.scrollHeight);
  area.style.height = `${needed}px`;
}

export function resizeAllBlockTextareas(root: ParentNode = document) {
  for (const area of root.querySelectorAll<HTMLTextAreaElement>("#blocks textarea, .stack-blocks textarea")) {
    sizeBlockTextarea(area);
  }
}

export type TextLineMetric = {
  text: string;
  startOffset: number;
  endOffset: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export function measureTextareaLines(area: HTMLTextAreaElement): TextLineMetric[] {
  const rect = area.getBoundingClientRect();
  if (area.value.length === 0) {
    const midY = rect.top + Math.min(6, rect.height / 2);
    return [
      {
        text: "",
        startOffset: 0,
        endOffset: 0,
        top: midY,
        bottom: midY,
        left: rect.left,
        right: rect.left,
      },
    ];
  }
  const lines = area.value.split("\n");
  const computed = window.getComputedStyle(area);
  const mirror = document.createElement("div");
  mirror.style.position = "fixed";
  mirror.style.left = "-9999px";
  mirror.style.top = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${Math.max(40, area.clientWidth)}px`;
  mirror.style.padding = computed.padding;
  mirror.style.font = computed.font;
  mirror.style.fontSize = computed.fontSize;
  mirror.style.lineHeight = computed.lineHeight;
  mirror.style.letterSpacing = computed.letterSpacing;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflowWrap = "break-word";

  const lineNodes: { row: HTMLElement; span: HTMLElement; line: string; startOffset: number; endOffset: number }[] = [];
  let offset = 0;
  for (const line of lines) {
    const row = document.createElement("div");
    const span = document.createElement("span");
    span.textContent = line.length > 0 ? line : "\u200b";
    row.append(span);
    mirror.append(row);
    const startOffset = offset;
    const endOffset = offset + line.length;
    lineNodes.push({ row, span, line, startOffset, endOffset });
    offset = endOffset + 1;
  }
  document.body.append(mirror);
  const metrics: TextLineMetric[] = lineNodes.map(({ row, span, line, startOffset, endOffset }) => {
    const top = rect.top - area.scrollTop + row.offsetTop;
    const bottom = top + row.offsetHeight;
    const width = line.length > 0 ? span.offsetWidth : 0;
    return {
      text: line,
      startOffset,
      endOffset,
      top,
      bottom,
      left: rect.left,
      right: rect.left + width,
    };
  });
  mirror.remove();
  return metrics;
}

export function estimateCharOffsetInLine(area: HTMLTextAreaElement, line: TextLineMetric, clientX: number): number {
  if (line.text.length === 0 || clientX <= line.left) {
    return line.startOffset;
  }
  if (clientX >= line.right) {
    return line.endOffset;
  }
  const computed = window.getComputedStyle(area);
  const probe = document.createElement("span");
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  probe.style.font = computed.font;
  probe.style.fontSize = computed.fontSize;
  probe.style.letterSpacing = computed.letterSpacing;
  document.body.append(probe);
  const relX = clientX - line.left;
  let bestIdx = 0;
  let bestDist = relX;
  for (let i = 1; i <= line.text.length; i += 1) {
    probe.textContent = line.text.slice(0, i);
    const w = probe.offsetWidth;
    const dist = Math.abs(relX - w);
    if (dist <= bestDist) {
      bestDist = dist;
      bestIdx = i;
    } else {
      break;
    }
  }
  probe.remove();
  return line.startOffset + bestIdx;
}
