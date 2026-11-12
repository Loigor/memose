const SKIP_PREVIEW = new Set([
  "PRE",
  "CODE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "A",
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
  "BUTTON",
]);

function tagPattern(): RegExp {
  return /(?<![#\p{L}\p{N}_/])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
}

export function tagLengthAt(text: string, index: number): number {
  const pattern = tagPattern();
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  if (!match || match.index !== index) {
    return 0;
  }
  return match[0].length;
}

export function wrapTagsHtml(escaped: string): string {
  const skip = new Set(["md-code", "md-fence", "md-link", "md-image"]);
  const stack: string[] = [];
  return escaped.replace(/(<[^>]+>)|([^<]+)/g, (html, tag: string | undefined, text: string | undefined) => {
    if (tag) {
      const open = /^<span class="([^"]+)"/.exec(tag);
      if (open?.[1]) {
        stack.push(open[1]);
      } else if (tag.startsWith("</span") && stack.length > 0) {
        stack.pop();
      }
      return html;
    }
    if (stack.some((cls) => skip.has(cls))) {
      return text ?? "";
    }
    return (text ?? "").replace(tagPattern(), (_full, name: string) => {
      return `<span class="md-tag" data-tag="#${name}">#${name}</span>`;
    });
  });
}

export function tagAtOffset(text: string, offset: number): string | null {
  if (inFence(text, offset)) {
    return null;
  }
  const lineStart = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
  const breakAt = text.indexOf("\n", offset);
  const lineEnd = breakAt === -1 ? text.length : breakAt;
  const line = text.slice(lineStart, lineEnd);
  if (/^#{1,6} /.test(line)) {
    return null;
  }
  const local = offset - lineStart;
  for (const match of line.matchAll(tagPattern())) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (local >= start && local <= end) {
      return match[0];
    }
  }
  return null;
}

export function linkTagsIn(root: ParentNode) {
  if (typeof document === "undefined") {
    return;
  }
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.data) {
        return NodeFilter.FILTER_REJECT;
      }
      let el = node.parentElement;
      while (el && el !== root) {
        if (SKIP_PREVIEW.has(el.tagName) || el.classList.contains("md-tag")) {
          return NodeFilter.FILTER_REJECT;
        }
        el = el.parentElement;
      }
      return tagPattern().test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) {
      nodes.push(node);
    }
  }
  for (const node of nodes) {
    linkTextNode(node);
  }
}

function linkTextNode(node: Text) {
  const text = node.data;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(tagPattern())) {
    const start = match.index ?? 0;
    if (start > last) {
      frag.append(text.slice(last, start));
    }
    const span = document.createElement("span");
    span.className = "md-tag";
    span.dataset.tag = `#${match[1]}`;
    span.textContent = match[0];
    span.setAttribute("role", "link");
    frag.append(span);
    last = start + match[0].length;
  }
  if (last === 0) {
    return;
  }
  if (last < text.length) {
    frag.append(text.slice(last));
  }
  node.replaceWith(frag);
}

function inFence(text: string, index: number): boolean {
  const fences = text.slice(0, index).match(/^```/gm);
  return (fences?.length ?? 0) % 2 === 1;
}
