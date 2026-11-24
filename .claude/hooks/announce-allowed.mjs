// PreToolUse (Bash): when a command runs on an allow rule from this project's
// .claude/settings.json, say so with a "***" line, so auto-approved commands stay
// visible. It only announces; it never approves or blocks anything.
/* global process */
import fs from "node:fs";
import path from "node:path";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

try {
  const command = String(JSON.parse(input)?.tool_input?.command ?? "");
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  const rules = (settings.permissions?.allow ?? [])
    .map((rule) => /^Bash\((.*)\)$/.exec(rule)?.[1])
    .filter((rule) => typeof rule === "string");
  const matches = (segment) =>
    rules.some((rule) =>
      rule.endsWith(" *") ? segment === rule.slice(0, -2) || segment.startsWith(rule.slice(0, -1)) : segment === rule,
    );
  const hits = command
    .split(/&&|\|\||;|\||\n/)
    .map((segment) =>
      segment
        .replace(/\s+\d?>>?\s*(&\d|\/dev\/null)/g, "")
        .replace(/^\s*timeout\s+\d+\s+/, "")
        .trim(),
    )
    .filter((segment) => segment && matches(segment));
  if (hits.length > 0) {
    process.stdout.write(
      JSON.stringify({ systemMessage: `*** Auto-approved (project allowlist): ${hits.join(" | ")}` }),
    );
  }
} catch {
  // Never get in the way of the command.
}
