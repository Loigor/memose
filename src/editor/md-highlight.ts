function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrap(cls: string, html: string): string {
  return `<span class="${cls}">${html}</span>`;
}

function highlightInline(escaped: string): string {
  return escaped
    .replace(/`[^`\n]+`/g, (chunk) => wrap("md-code", chunk))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, (chunk) => wrap("md-image", chunk))
    .replace(/\[[^\]]+\]\([^)]*\)/g, (chunk) => wrap("md-link", chunk))
    .replace(/\*\*[^*]+\*\*/g, (chunk) => wrap("md-strong", chunk))
    .replace(/(?<!\*)\*[^*\n]+\*(?!\*)/g, (chunk) => wrap("md-em", chunk));
}

function lineHtml(inner: string): string {
  return `<span class="md-line"><span class="md-line-text">${inner}</span></span>`;
}

export function highlightMarkdown(text: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    const escaped = escapeHtml(line);
    if (escaped.startsWith("```")) {
      fence = !fence;
      out.push(lineHtml(wrap("md-fence", escaped)));
      continue;
    }
    if (fence) {
      out.push(lineHtml(wrap("md-code", escaped)));
      continue;
    }
    if (/^#{1,6} /.test(escaped)) {
      out.push(lineHtml(wrap("md-heading", highlightInline(escaped))));
      continue;
    }
    if (escaped.startsWith("&gt;")) {
      out.push(lineHtml(wrap("md-quote", highlightInline(escaped))));
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(line)) {
      out.push(lineHtml(wrap("md-hr", escaped)));
      continue;
    }
    const list = escaped.match(/^(\s*(?:[-*+]|\d+\.)(?: \[[ xX]\])? )(.*)$/);
    if (list) {
      out.push(lineHtml(`${wrap("md-marker", list[1])}${highlightInline(list[2])}`));
      continue;
    }
    out.push(lineHtml(highlightInline(escaped)));
  }
  return out.join("\n");
}
