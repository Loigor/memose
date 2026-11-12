// shortcut: token colors, not a grammar. Upgrade when a language needs real parsing.

const ALIAS: Record<string, string> = {
  javascript: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  tsx: "ts",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  cpp: "c",
  cc: "c",
  h: "c",
  hpp: "c",
  "c++": "c",
  kt: "kotlin",
  rb: "ruby",
  xml: "html",
  svg: "html",
  htm: "html",
  scss: "css",
  less: "css",
  plaintext: "text",
  txt: "text",
  plain: "text",
};

const WORDS: Record<string, string> = {
  json: "true false null",
  js: "async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined",
  ts: "abstract as async await break case catch class const continue declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface keyof let namespace never new null of private protected public readonly return satisfies static super switch this throw true try type typeof undefined var void while with yield",
  python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil",
  java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true false try void volatile while",
  kotlin: "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while",
  swift: "as associatedtype break case catch class continue default defer else enum extension false for func guard if import in init internal let nil open operator private protocol public return self static struct switch throw true try typealias var where while",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while",
  css: "important import media keyframes from to if else and or not var",
  bash: "if then else elif fi for while do done case esac function return in local export",
  ruby: "begin class def do else elsif end false for if in module next nil not or redo rescue retry return self super then true unless until when while yield",
  sql: "select from where and or not insert into values update set delete join left right inner outer on group by order limit offset as create table drop alter null is in like between distinct union all having",
  yaml: "true false null yes no",
  html: "",
  markdown: "",
  text: "",
};

const HASH = new Set(["python", "bash", "yaml", "ruby", "toml", "r", "perl"]);
const MARKUP = new Set(["html"]);
const PLAIN = new Set(["text", "markdown"]);

const keywords = new Map<string, Set<string>>(
  Object.entries(WORDS).map(([name, words]) => [name, new Set(words.split(" ").filter(Boolean))]),
);

export function languageName(lang: string): string {
  const token = (lang.trim().split(/\s+/)[0] ?? "").toLowerCase();
  return ALIAS[token] ?? token;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineHtml(inner: string): string {
  return `<span class="md-line"><span class="md-line-text">${inner}</span></span>`;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function readNumber(line: string, index: number): number {
  let j = index;
  if ((line[j] === "-" || line[j] === "+") && isDigit(line[j + 1] ?? "")) {
    const prev = j === 0 ? "" : line[j - 1] ?? "";
    if (prev !== "" && /[\w)]/.test(prev)) {
      return index;
    }
    j += 1;
  }
  if (!isDigit(line[j] ?? "")) {
    return index;
  }
  if (line[j] === "0" && (line[j + 1] === "x" || line[j + 1] === "X")) {
    let k = j + 2;
    while (/[0-9a-fA-F]/.test(line[k] ?? "")) {
      k += 1;
    }
    return k > j + 2 ? k : j + 1;
  }
  j += 1;
  while (isDigit(line[j] ?? "")) {
    j += 1;
  }
  if (line[j] === "." && isDigit(line[j + 1] ?? "")) {
    j += 2;
    while (isDigit(line[j] ?? "")) {
      j += 1;
    }
  }
  if (line[j] === "e" || line[j] === "E") {
    let k = j + 1;
    if (line[k] === "+" || line[k] === "-") {
      k += 1;
    }
    if (isDigit(line[k] ?? "")) {
      j = k + 1;
      while (isDigit(line[j] ?? "")) {
        j += 1;
      }
    }
  }
  return j;
}

function readString(line: string, index: number): number {
  const quote = line[index];
  let j = index + 1;
  while (j < line.length) {
    if (line[j] === "\\") {
      j += 2;
      continue;
    }
    if (line[j] === quote) {
      return j + 1;
    }
    j += 1;
  }
  return line.length;
}

type Carry = "*/" | "-->" | null;

function paintLine(
  line: string,
  name: string,
  words: Set<string> | undefined,
  carry: Carry,
): { html: string; carry: Carry } {
  const json = name === "json";
  const hash = HASH.has(name);
  const markup = MARKUP.has(name);
  let html = "";
  let plain = "";
  const flush = () => {
    if (plain.length > 0) {
      html += escapeHtml(plain);
      plain = "";
    }
  };
  const push = (cls: string, raw: string) => {
    flush();
    html += `<span class="${cls}">${escapeHtml(raw)}</span>`;
  };
  let i = 0;
  if (carry) {
    const end = line.indexOf(carry);
    if (end < 0) {
      push("tok-cmt", line);
      return { html, carry };
    }
    push("tok-cmt", line.slice(0, end + carry.length));
    i = end + carry.length;
    carry = null;
  }
  while (i < line.length) {
    if (!json && !markup && line.startsWith("//", i)) {
      push("tok-cmt", line.slice(i));
      break;
    }
    if (hash && line[i] === "#") {
      push("tok-cmt", line.slice(i));
      break;
    }
    if (!json && line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        push("tok-cmt", line.slice(i));
        carry = "*/";
        break;
      }
      push("tok-cmt", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (markup && line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      if (end < 0) {
        push("tok-cmt", line.slice(i));
        carry = "-->";
        break;
      }
      push("tok-cmt", line.slice(i, end + 3));
      i = end + 3;
      continue;
    }
    const quote = line[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      const end = readString(line, i);
      const raw = line.slice(i, end);
      let cls = "tok-str";
      if (json && quote === '"') {
        let k = end;
        while (line[k] === " " || line[k] === "\t") {
          k += 1;
        }
        if (line[k] === ":") {
          cls = "tok-key";
        }
      }
      push(cls, raw);
      i = end;
      continue;
    }
    const numberEnd = readNumber(line, i);
    if (numberEnd > i) {
      push("tok-num", line.slice(i, numberEnd));
      i = numberEnd;
      continue;
    }
    if (markup && line[i] === "<") {
      const match = /^<\/?([A-Za-z][\w:-]*)/.exec(line.slice(i));
      const tag = match?.[1];
      if (match && tag) {
        const nameAt = i + match[0].lastIndexOf(tag);
        plain += line.slice(i, nameAt);
        push("tok-kw", tag);
        i = nameAt + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(line[i] ?? "")) {
      let j = i + 1;
      while (/[\w$]/.test(line[j] ?? "")) {
        j += 1;
      }
      const word = line.slice(i, j);
      if (words?.has(word)) {
        push("tok-kw", word);
      } else {
        plain += word;
      }
      i = j;
      continue;
    }
    plain += line[i];
    i += 1;
  }
  flush();
  return { html, carry };
}

export function highlightCode(text: string, lang: string): string {
  const name = languageName(lang);
  if (PLAIN.has(name)) {
    return text.split("\n").map((line) => lineHtml(escapeHtml(line))).join("\n");
  }
  const words = keywords.get(name);
  let carry: Carry = null;
  return text
    .split("\n")
    .map((line) => {
      const painted = paintLine(line, name, words, carry);
      carry = painted.carry;
      return lineHtml(painted.html);
    })
    .join("\n");
}
