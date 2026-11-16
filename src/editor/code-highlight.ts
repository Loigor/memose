// Token colors for common languages: a small rule-driven lexer per language, not a grammar.
// Only colors change (never weight or style), so the overlay keeps the textarea's exact glyph grid.

import { highlightMarkdown } from "./md-highlight.ts";

const ALIAS: Record<string, string> = {
  javascript: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  node: "js",
  typescript: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  jsonc: "json",
  json5: "json",
  py: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  shellscript: "bash",
  ps1: "powershell",
  pwsh: "powershell",
  yml: "yaml",
  md: "markdown",
  cpp: "c",
  cc: "c",
  cxx: "c",
  h: "c",
  hpp: "c",
  "c++": "c",
  objc: "c",
  cs: "csharp",
  "c#": "csharp",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  xml: "html",
  svg: "html",
  htm: "html",
  vue: "html",
  scss: "scss",
  sass: "scss",
  less: "scss",
  ini: "toml",
  cfg: "toml",
  conf: "toml",
  properties: "toml",
  env: "bash",
  dotenv: "bash",
  docker: "dockerfile",
  patch: "diff",
  gql: "graphql",
  plaintext: "text",
  txt: "text",
  plain: "text",
  text: "text",
};

export function languageName(lang: string): string {
  const token = (lang.trim().split(/\s+/)[0] ?? "").toLowerCase();
  return ALIAS[token] ?? token;
}

/* ------------------------------------------------------------------------------------------ */
/* Lexer                                                                                       */

type Piece = [cls: string, text: string];

type Ctx = {
  text: string;
  /** Last identifier when nothing but whitespace followed it, else "". */
  prevWord: string;
  /** Last non-whitespace character outside comments. */
  prevSig: string;
  /** Only whitespace (or a kept marker) since the line began. */
  lineStart: boolean;
  /** Index where the current line begins. */
  lineAt: number;
  /** Per-language scratch state (brace depth, inside a tag, …). */
  depth: number;
  inValue: boolean;
  inTag: boolean;
};

type RuleResult = string | Piece[] | null;

type Rule = {
  re: RegExp;
  cls: string | ((match: RegExpExecArray, ctx: Ctx) => RuleResult);
  /** Characters the match can start with; a cheap filter before running the regex. */
  first?: string;
  /** Only where nothing but whitespace precedes on the line. */
  bol?: boolean;
  /** Only at column 0. */
  col0?: boolean;
  /** The line still counts as "at start" after this token (YAML `- ` list markers). */
  keepBol?: boolean;
  when?: (ctx: Ctx) => boolean;
  after?: (match: string, ctx: Ctx) => void;
};

type Lang = {
  rules: Rule[];
  ident: RegExp;
  keywords: Set<string>;
  literals: Set<string>;
  types: Set<string>;
  builtins: Set<string>;
  /** The identifier after one of these names a function. */
  defs: Set<string>;
  /** The identifier after one of these names a type. */
  typeDefs: Set<string>;
  /** Capitalized identifiers are types, ALL_CAPS ones are constants. */
  capTypes: boolean;
  caseless: boolean;
  /** Called for plain punctuation, so languages can track nesting. */
  onChar?: (ch: string, ctx: Ctx) => void;
  /** Overrides identifier coloring; return undefined to fall back to the defaults. */
  word?: (word: string, ctx: Ctx, next: string) => string | undefined;
};

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The lexer sets this before running rules so `when` hooks can peek around the current position.
let ctxIndex = 0;

function prevChar(ctx: Ctx): string {
  return ctx.text[ctxIndex - 1] ?? "\n";
}

function restOfLine(ctx: Ctx): string {
  const end = ctx.text.indexOf("\n", ctxIndex);
  return ctx.text.slice(ctxIndex, end < 0 ? undefined : end);
}

const sticky = (source: string, flags = ""): RegExp => new RegExp(source, `y${flags}`);

function lineComment(prefix: string, when?: Rule["when"]): Rule {
  return { re: sticky(`${escapeRe(prefix)}[^\\n]*`), cls: "tok-cmt", first: prefix[0], when };
}

function blockComment(open: string, close: string): Rule {
  return { re: sticky(`${escapeRe(open)}[\\s\\S]*?(?:${escapeRe(close)}|$)`), cls: "tok-cmt", first: open[0] };
}

/** A quoted string; `multi` lets it run past line breaks (template literals, Go raw strings). */
function quoted(quote: string, multi = false, escapes = true, cls = "tok-str"): Rule {
  const q = escapeRe(quote);
  const body = escapes ? `\\\\[\\s\\S]|(?!${q})[^\\\\${multi ? "" : "\\n"}]` : `(?!${q})[^${multi ? "" : "\\n"}]`;
  const end = multi ? `(?:${q}|$)` : `(?:${q}|(?=\\n)|$)`;
  return { re: sticky(`${q}(?:${body})*${end}`), cls, first: quote[0] };
}

function tripleQuoted(quote: string, prefix = ""): Rule {
  const q = escapeRe(quote.repeat(3));
  return {
    re: sticky(`${prefix}${q}[\\s\\S]*?(?:${q}|$)`),
    cls: "tok-str",
    first: prefix ? undefined : quote,
  };
}

const NUMBER: Rule = {
  re: sticky(
    "(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?|\\.\\d[\\d_]*(?:[eE][+-]?\\d+)?)[a-zA-Z]*",
  ),
  cls: "tok-num",
  first: "0123456789.",
  when: (ctx) => !/[\w$]/.test(prevChar(ctx)),
};

const DECORATOR: Rule = { re: sticky("@[A-Za-z_][\\w.]*"), cls: "tok-meta", first: "@" };

const DQ = quoted('"');
const SQ = quoted("'");

/** `#` starts a comment only after whitespace or at line start (so `a#b` and `$#` stay code). */
const HASH_COMMENT = lineComment("#", (ctx) => ctx.lineStart || /\s/.test(prevChar(ctx)));

function makeLang(spec: Partial<Lang> & { rules: Rule[] }): Lang {
  return {
    ident: sticky("[A-Za-z_$][\\w$]*"),
    keywords: new Set(),
    literals: new Set(),
    types: new Set(),
    builtins: new Set(),
    defs: new Set(),
    typeDefs: new Set(),
    capTypes: false,
    caseless: false,
    ...spec,
  };
}

function tokenize(text: string, lang: Lang): Piece[] {
  const out: Piece[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      out.push(["", plain]);
      plain = "";
    }
  };
  const ctx: Ctx = {
    text,
    prevWord: "",
    prevSig: "",
    lineStart: true,
    lineAt: 0,
    depth: 0,
    inValue: false,
    inTag: false,
  };
  const emit = (cls: string, raw: string) => {
    if (!cls) {
      plain += raw;
      return;
    }
    flush();
    out.push([cls, raw]);
  };
  let i = 0;
  outer: while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\n") {
      plain += ch;
      ctx.lineStart = true;
      ctx.lineAt = i + 1;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      plain += ch;
      i += 1;
      continue;
    }
    ctxIndex = i;
    for (const rule of lang.rules) {
      if (rule.first && !rule.first.includes(ch)) {
        continue;
      }
      if ((rule.bol && !ctx.lineStart) || (rule.col0 && i !== ctx.lineAt) || (rule.when && !rule.when(ctx))) {
        continue;
      }
      rule.re.lastIndex = i;
      const match = rule.re.exec(text);
      if (!match || match[0].length === 0) {
        continue;
      }
      const result = typeof rule.cls === "string" ? rule.cls : rule.cls(match, ctx);
      if (result === null) {
        continue;
      }
      const raw = match[0];
      if (typeof result === "string") {
        emit(result, raw);
      } else {
        for (const [cls, part] of result) {
          emit(cls, part);
        }
      }
      if (result !== "tok-cmt") {
        const trimmed = raw.trimEnd();
        ctx.prevSig = trimmed[trimmed.length - 1] ?? ctx.prevSig;
        ctx.prevWord = "";
      }
      rule.after?.(raw, ctx);
      const newline = raw.lastIndexOf("\n");
      if (newline >= 0) {
        ctx.lineAt = i + newline + 1;
      }
      ctx.lineStart = Boolean(rule.keepBol) || (newline >= 0 && raw.slice(newline + 1).trim() === "");
      i += raw.length;
      continue outer;
    }
    lang.ident.lastIndex = i;
    const ident = lang.ident.exec(text);
    if (ident && ident[0].length > 0) {
      const word = ident[0];
      const end = i + word.length;
      emit(classifyWord(word, lang, ctx, text, end), word);
      ctx.prevWord = word;
      ctx.prevSig = word[word.length - 1] ?? "";
      ctx.lineStart = false;
      i = end;
      continue;
    }
    plain += ch;
    lang.onChar?.(ch, ctx);
    ctx.prevSig = ch;
    ctx.prevWord = "";
    ctx.lineStart = false;
    i += 1;
  }
  flush();
  return out;
}

function nextSignificant(text: string, from: number): string {
  let k = from;
  while (text[k] === " " || text[k] === "\t") {
    k += 1;
  }
  return text[k] ?? "";
}

function classifyWord(word: string, lang: Lang, ctx: Ctx, text: string, end: number): string {
  const next = nextSignificant(text, end);
  const custom = lang.word?.(word, ctx, next);
  if (custom !== undefined) {
    return custom;
  }
  const key = lang.caseless ? word.toLowerCase() : word;
  const prev = lang.caseless ? ctx.prevWord.toLowerCase() : ctx.prevWord;
  if (prev && lang.typeDefs.has(prev) && !lang.keywords.has(key)) {
    return "tok-type";
  }
  if (prev && lang.defs.has(prev) && !lang.keywords.has(key)) {
    return "tok-fn";
  }
  if (lang.keywords.has(key)) {
    return "tok-kw";
  }
  if (lang.literals.has(key)) {
    return "tok-lit";
  }
  if (lang.types.has(key)) {
    return "tok-type";
  }
  if (next === "(" || lang.builtins.has(key)) {
    return "tok-fn";
  }
  if (lang.capTypes && /^[A-Z]/.test(word)) {
    if (word.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(word)) {
      return "tok-lit";
    }
    return "tok-type";
  }
  return "";
}

/* ------------------------------------------------------------------------------------------ */
/* Languages                                                                                   */

const C_COMMENTS = [blockComment("/*", "*/"), lineComment("//")];

/** Regex literals: a `/` where an expression may start. */
const JS_REGEX: Rule = {
  re: sticky("\\/(?![*/])(?:\\\\.|\\[(?:\\\\.|[^\\]\\\\\\n])*\\]|[^/\\\\\\n[])+\\/[a-z]*"),
  cls: "tok-re",
  first: "/",
  when: (ctx) =>
    ctx.prevSig === "" ||
    "(,=:[!&|?{};+-*%<>~^".includes(ctx.prevSig) ||
    ["return", "typeof", "case", "in", "of", "delete", "void", "throw", "yield", "await"].includes(ctx.prevWord),
};

const JS_KEYWORDS =
  "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield";
const TS_KEYWORDS = `${JS_KEYWORDS} abstract as asserts declare enum implements infer interface is keyof module namespace override private protected public readonly satisfies type unique`;

const js = (keywords: string, types = ""): Lang =>
  makeLang({
    rules: [...C_COMMENTS, quoted("`", true), DQ, SQ, JS_REGEX, NUMBER, DECORATOR],
    keywords: words(keywords),
    literals: words("true false null undefined NaN Infinity"),
    types: words(types),
    defs: words("function"),
    typeDefs: words("class interface type enum extends implements new namespace"),
    capTypes: true,
  });

const JSON_LANG = makeLang({
  rules: [
    ...C_COMMENTS,
    {
      re: sticky('"(?:\\\\.|[^"\\\\\\n])*(?:"|(?=\\n)|$)'),
      cls: (match, ctx) => (nextSignificant(ctx.text, match.index + match[0].length) === ":" ? "tok-key" : "tok-str"),
      first: '"',
    },
    NUMBER,
  ],
  literals: words("true false null"),
});

const PYTHON = makeLang({
  rules: [
    HASH_COMMENT,
    tripleQuoted('"', "(?:[rRbBuUfF]{1,2})?"),
    tripleQuoted("'", "(?:[rRbBuUfF]{1,2})?"),
    { re: sticky("(?:[rRbBuUfF]{1,2})?(\"|')(?:\\\\.|(?!\\1)[^\\\\\\n])*(?:\\1|(?=\\n)|$)"), cls: "tok-str" },
    NUMBER,
    DECORATOR,
  ],
  ident: sticky("[A-Za-z_]\\w*"),
  keywords: words(
    "and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield",
  ),
  literals: words("True False None self cls NotImplemented Ellipsis"),
  types: words("int float str bool bytes list dict set tuple object complex frozenset bytearray type"),
  builtins: words(
    "print len range open isinstance issubclass enumerate zip map filter sorted reversed sum min max abs any all repr hasattr getattr setattr super iter next input",
  ),
  defs: words("def"),
  typeDefs: words("class"),
  capTypes: true,
});

const RUBY = makeLang({
  rules: [
    HASH_COMMENT,
    { re: sticky("^=begin[\\s\\S]*?(?:^=end|$)", "m"), cls: "tok-cmt", first: "=", col0: true },
    DQ,
    SQ,
    { re: sticky("@@?[A-Za-z_]\\w*|\\$[A-Za-z_]\\w*"), cls: "tok-var", first: "@$" },
    {
      re: sticky(":[A-Za-z_]\\w*[?!]?"),
      cls: "tok-lit",
      first: ":",
      when: (ctx) => prevChar(ctx) !== ":" && !/\w/.test(prevChar(ctx)),
    },
    NUMBER,
  ],
  ident: sticky("[A-Za-z_]\\w*[?!]?"),
  keywords: words(
    "alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo require rescue retry return super then undef unless until when while yield attr_accessor attr_reader attr_writer include extend",
  ),
  literals: words("true false nil self"),
  builtins: words("puts print p raise lambda proc loop"),
  defs: words("def"),
  typeDefs: words("class module"),
  capTypes: true,
});

const RUST = makeLang({
  rules: [
    ...C_COMMENTS,
    { re: sticky('r#*"[\\s\\S]*?(?:"#*|$)'), cls: "tok-str", first: "r", when: (ctx) => !/\w/.test(prevChar(ctx)) },
    { re: sticky('b?"(?:\\\\[\\s\\S]|[^"\\\\])*(?:"|$)'), cls: "tok-str", first: 'b"' },
    { re: sticky("b?'(?:\\\\.|[^\\\\'\\n])'"), cls: "tok-str", first: "b'" },
    { re: sticky("'[A-Za-z_]\\w*"), cls: "tok-meta", first: "'" },
    { re: sticky("#!?\\[[^\\]\\n]*\\]?"), cls: "tok-meta", first: "#" },
    { re: sticky("[A-Za-z_]\\w*!(?=\\s*[([{])"), cls: "tok-fn" },
    NUMBER,
  ],
  ident: sticky("[A-Za-z_]\\w*"),
  keywords: words(
    "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while",
  ),
  literals: words("true false self Self"),
  types: words(
    "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet",
  ),
  builtins: words("Some None Ok Err"),
  defs: words("fn"),
  typeDefs: words("struct enum trait impl type union"),
  capTypes: true,
});

const GO = makeLang({
  rules: [...C_COMMENTS, quoted("`", true, false), DQ, SQ, NUMBER],
  ident: sticky("[A-Za-z_]\\w*"),
  keywords: words(
    "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
  ),
  literals: words("true false nil iota"),
  types: words(
    "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any",
  ),
  builtins: words("len cap make new append copy delete panic recover print println close min max clear"),
  defs: words("func"),
  typeDefs: words("type"),
  capTypes: true,
});

const cLike = (spec: {
  keywords: string;
  literals: string;
  types?: string;
  defs?: string;
  typeDefs?: string;
  extra?: Rule[];
  ident?: RegExp;
}): Lang =>
  makeLang({
    rules: [...C_COMMENTS, ...(spec.extra ?? []), DQ, SQ, NUMBER],
    ident: spec.ident ?? sticky("[A-Za-z_]\\w*"),
    keywords: words(spec.keywords),
    literals: words(spec.literals),
    types: words(spec.types ?? ""),
    defs: words(spec.defs ?? ""),
    typeDefs: words(spec.typeDefs ?? "class interface struct enum extends implements new"),
    capTypes: true,
  });

const C = cLike({
  keywords:
    "auto break case catch class const constexpr continue default delete do else enum explicit export extern for friend goto if inline mutable namespace new noexcept operator private protected public register return sizeof static static_assert static_cast dynamic_cast reinterpret_cast const_cast struct switch template this throw try typedef typename union using virtual override final volatile while",
  literals: "true false NULL nullptr",
  types:
    "void char short int long float double signed unsigned bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t wchar_t auto string vector map std",
  typeDefs: "class struct enum union typename namespace",
  extra: [{ re: sticky("#\\s*[A-Za-z]+[^\\n]*"), cls: "tok-meta", first: "#", bol: true }],
});

const JAVA = cLike({
  keywords:
    "abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public record return sealed permits static strictfp super switch synchronized this throw throws transient try var volatile while yield",
  literals: "true false null",
  types: "boolean byte char double float int long short void String Object Integer Long Double Boolean List Map Set",
  extra: [DECORATOR, tripleQuoted('"')],
});

const CSHARP = cLike({
  keywords:
    "abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach get goto if implicit in init interface internal is lock namespace new operator out override params private protected public readonly record ref return sealed set sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using var virtual void volatile when where while yield",
  literals: "true false null",
  types: "bool byte char decimal double float int long object sbyte short string uint ulong ushort dynamic nint nuint",
  extra: [{ re: sticky('\\$?@?"(?:""|\\\\.|[^"\\\\\\n])*"?'), cls: "tok-str", first: '$@"' }],
});

const KOTLIN = cLike({
  keywords:
    "as break by catch class companion const constructor continue data do else enum finally for fun if import in init interface internal is lateinit object open operator out override package private protected public return sealed super suspend this throw try typealias val var vararg when where while",
  literals: "true false null",
  types: "Any Unit Nothing Int Long Short Byte Double Float Boolean Char String List Map Set Array",
  defs: "fun",
  typeDefs: "class interface object typealias",
  extra: [tripleQuoted('"'), DECORATOR],
});

const SWIFT = cLike({
  keywords:
    "actor associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in init inout internal is let mutating open operator override private protocol public repeat rethrows return some static struct subscript super switch throw throws try typealias var where while",
  literals: "true false nil self Self",
  types: "Int Double Float Bool String Character Array Dictionary Set Optional Any AnyObject Void",
  defs: "func",
  typeDefs: "class struct enum protocol extension actor typealias",
  extra: [tripleQuoted('"'), DECORATOR],
});

const SCALA = cLike({
  keywords:
    "abstract case catch class def do else enum extends final finally for given if implicit import lazy match new object override package private protected return sealed super then this throw trait try type using val var while with yield",
  literals: "true false null",
  defs: "def",
  typeDefs: "class object trait type extends with new enum",
  extra: [tripleQuoted('"'), DECORATOR],
});

const DART = cLike({
  keywords:
    "abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory final finally for get if implements import in is late library mixin new on operator part required rethrow return set show static super switch sync this throw try typedef var void while with yield",
  literals: "true false null",
  types: "int double num bool String List Map Set Future Stream Object dynamic void",
  extra: [tripleQuoted('"'), tripleQuoted("'"), DECORATOR],
});

const PHP = makeLang({
  rules: [
    ...C_COMMENTS,
    HASH_COMMENT,
    { re: sticky("<\\?(?:php|=)?|\\?>"), cls: "tok-meta", first: "<?" },
    { re: sticky("\\$[A-Za-z_]\\w*"), cls: "tok-var", first: "$" },
    DQ,
    SQ,
    NUMBER,
  ],
  ident: sticky("[A-Za-z_]\\w*"),
  keywords: words(
    "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
  ),
  literals: words("true false null"),
  types: words("int float string bool array object mixed void never iterable"),
  defs: words("function fn"),
  typeDefs: words("class interface trait enum extends implements new"),
  capTypes: true,
  caseless: true,
});

const BASH = makeLang({
  rules: [
    {
      re: sticky("\\$(?:\\{[^}\\n]*\\}?|\\(\\(?|[A-Za-z_]\\w*|[0-9#?$!@*-])"),
      cls: "tok-var",
      first: "$",
    },
    HASH_COMMENT,
    { re: sticky('"(?:\\\\[\\s\\S]|[^"\\\\])*(?:"|$)'), cls: "tok-str", first: '"' },
    { re: sticky("'[^']*(?:'|$)"), cls: "tok-str", first: "'" },
    { re: sticky("[A-Za-z_]\\w*(?==)"), cls: "tok-var", bol: true },
    { re: sticky("--?[A-Za-z][\\w-]*"), cls: "tok-attr", first: "-", when: (ctx) => /\s/.test(prevChar(ctx)) },
    NUMBER,
  ],
  ident: sticky("[A-Za-z_][\\w.-]*"),
  keywords: words(
    "if then else elif fi for while until do done case esac function return in select time local export declare readonly unset break continue",
  ),
  literals: words("true false"),
  builtins: words(
    "echo printf cd pwd source alias read test exit set shift eval exec trap sudo ls cat grep sed awk find mkdir rmdir rm cp mv chmod chown curl wget git npm npx pnpm yarn node python python3 pip docker kubectl make tar ssh scp brew apt cargo go touch head tail sort uniq wc xargs tee kill ps env which",
  ),
  defs: words("function"),
});

const POWERSHELL = makeLang({
  rules: [
    blockComment("<#", "#>"),
    lineComment("#"),
    { re: sticky("\\$(?:\\{[^}\\n]*\\}|[A-Za-z_][\\w:]*|[?^$_])"), cls: "tok-var", first: "$" },
    DQ,
    SQ,
    { re: sticky("-[A-Za-z][\\w]*"), cls: "tok-attr", first: "-", when: (ctx) => /\s/.test(prevChar(ctx)) },
    { re: sticky("[A-Za-z]+-[A-Za-z]\\w*"), cls: "tok-fn" },
    NUMBER,
  ],
  ident: sticky("[A-Za-z_]\\w*"),
  keywords: words(
    "begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using while",
  ),
  defs: words("function filter"),
  caseless: true,
});

const SQL = makeLang({
  rules: [
    lineComment("--"),
    blockComment("/*", "*/"),
    quoted("'", true, false),
    { re: sticky('"[^"\\n]*"?|`[^`\\n]*`?|\\[[^\\]\\n]*\\]'), cls: "tok-key", first: '"`[' },
    NUMBER,
  ],
  ident: sticky("[A-Za-z_][\\w$]*"),
  keywords: words(
    "select from where and or not insert into values update set delete join left right inner outer full cross on using group by order asc desc limit offset as create table view index drop alter add column primary key foreign references unique constraint default check if exists distinct union all having case when then else end begin commit rollback transaction with recursive returning grant revoke truncate replace like ilike between is in over partition window",
  ),
  literals: words("null true false"),
  types: words(
    "int integer smallint bigint serial bigserial decimal numeric real float double precision char varchar text boolean bool date time timestamp timestamptz interval uuid json jsonb blob bytea",
  ),
  caseless: true,
});

const LUA = makeLang({
  rules: [
    blockComment("--[[", "]]"),
    lineComment("--"),
    { re: sticky("\\[(=*)\\[[\\s\\S]*?(?:\\]\\1\\]|$)"), cls: "tok-str", first: "[" },
    DQ,
    SQ,
    NUMBER,
  ],
  ident: sticky("[A-Za-z_]\\w*"),
  keywords: words("and break do else elseif end for function goto if in local not or repeat return then until while"),
  literals: words("true false nil self"),
  builtins: words("print pairs ipairs require type tostring tonumber setmetatable getmetatable error assert pcall"),
  defs: words("function"),
});

const GRAPHQL = makeLang({
  rules: [
    lineComment("#"),
    tripleQuoted('"'),
    DQ,
    { re: sticky("\\$[A-Za-z_]\\w*"), cls: "tok-var", first: "$" },
    DECORATOR,
    NUMBER,
  ],
  ident: sticky("[A-Za-z_]\\w*"),
  keywords: words(
    "query mutation subscription fragment on type input enum interface union scalar schema extend implements directive repeatable",
  ),
  literals: words("true false null"),
  typeDefs: words("type input enum interface union scalar fragment implements on"),
  capTypes: true,
});

const DOCKERFILE = makeLang({
  rules: [
    lineComment("#", (ctx) => ctx.lineStart),
    {
      re: sticky(
        "(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\\b",
        "i",
      ),
      cls: "tok-kw",
      bol: true,
    },
    { re: sticky("\\bAS\\b", "i"), cls: "tok-kw", first: "aA" },
    { re: sticky("\\$(?:\\{[^}\\n]*\\}?|[A-Za-z_]\\w*)"), cls: "tok-var", first: "$" },
    { re: sticky("--[A-Za-z][\\w-]*"), cls: "tok-attr", first: "-" },
    DQ,
    SQ,
    NUMBER,
  ],
  ident: sticky("[A-Za-z_][\\w.-]*"),
});

const YAML = makeLang({
  rules: [
    HASH_COMMENT,
    { re: sticky("(?:---|\\.\\.\\.)(?=\\s|$)"), cls: "tok-meta", col0: true, first: "-." },
    { re: sticky("-(?=\\s)"), cls: "", first: "-", bol: true, keepBol: true },
    {
      re: sticky("(?:\"[^\"\\n]*\"|'[^'\\n]*'|[^\\s#'\"{}\\[\\],&*!|>%@`][^:\\n#]*?)(?=\\s*:(?:\\s|$))"),
      cls: "tok-key",
      bol: true,
    },
    { re: sticky("[&*][\\w-]+"), cls: "tok-meta", first: "&*" },
    { re: sticky("!!?[\\w-]*"), cls: "tok-meta", first: "!" },
    DQ,
    SQ,
    NUMBER,
  ],
  ident: sticky("[A-Za-z_][\\w-]*"),
  literals: words("true false null yes no on off True False Null TRUE FALSE NULL ~"),
});

const TOML = makeLang({
  rules: [
    lineComment("#"),
    lineComment(";", (ctx) => ctx.lineStart),
    { re: sticky("\\[\\[?[^\\]\\n]*\\]?\\]?"), cls: "tok-type", first: "[", bol: true },
    { re: sticky('(?:"[^"\\n]*"|[\\w.-]+)(?=\\s*[=:])'), cls: "tok-key", bol: true },
    tripleQuoted('"'),
    tripleQuoted("'"),
    DQ,
    SQ,
    {
      re: sticky("\\d{4}-\\d{2}-\\d{2}(?:[T ][\\d:.]+(?:Z|[+-]\\d{2}:\\d{2})?)?"),
      cls: "tok-num",
      first: "0123456789",
    },
    NUMBER,
  ],
  ident: sticky("[A-Za-z_][\\w-]*"),
  literals: words("true false"),
});

const DIFF = makeLang({
  rules: [
    {
      re: sticky("(?:diff|index|\\+\\+\\+|---|similarity|rename|new file|deleted file)[^\\n]*"),
      cls: "tok-meta",
      col0: true,
    },
    { re: sticky("@@[^\\n]*"), cls: "tok-meta", col0: true, first: "@" },
    { re: sticky("\\+[^\\n]*"), cls: "tok-add", col0: true, first: "+" },
    { re: sticky("-[^\\n]*"), cls: "tok-del", col0: true, first: "-" },
    { re: sticky("[^\\n]+"), cls: "", col0: true },
  ],
  ident: sticky("(?!)"),
});

/** CSS tracks braces so selectors, property names and values color differently. */
const css = (lineComments: boolean): Lang =>
  makeLang({
    rules: [
      blockComment("/*", "*/"),
      ...(lineComments ? [lineComment("//", (ctx) => prevChar(ctx) !== ":")] : []),
      DQ,
      SQ,
      { re: sticky("@[\\w-]+"), cls: "tok-kw", first: "@" },
      { re: sticky("![\\w]+"), cls: "tok-kw", first: "!" },
      { re: sticky("\\$[\\w-]+"), cls: "tok-var", first: "$" },
      { re: sticky("--[\\w-]+"), cls: "tok-var", first: "-" },
      { re: sticky("#[\\da-fA-F]{3,8}\\b"), cls: "tok-num", first: "#", when: (ctx) => ctx.inValue },
      {
        re: sticky("-?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|[a-zA-Z]+)?"),
        cls: "tok-num",
        first: "-.0123456789",
        when: (ctx) => !/[\w-]/.test(prevChar(ctx)),
      },
      { re: sticky("[.#][A-Za-z_-][\\w-]*"), cls: "tok-type", first: ".#", when: (ctx) => !ctx.inValue },
      {
        // `a:hover {` is a selector; `color:red;` inside a rule is a declaration.
        re: sticky("::?[A-Za-z-]+"),
        cls: "tok-meta",
        first: ":",
        when: (ctx) =>
          !ctx.inValue &&
          /[\w)&\]*]/.test(prevChar(ctx)) &&
          (ctx.depth === 0 || /^[^;]*[{,]\s*$/.test(restOfLine(ctx))),
      },
      { re: sticky("&"), cls: "tok-meta", first: "&" },
    ],
    ident: sticky("-?[A-Za-z_][\\w-]*"),
    onChar: (ch, ctx) => {
      if (ch === "{") {
        ctx.depth += 1;
        ctx.inValue = false;
      } else if (ch === "}") {
        ctx.depth = Math.max(0, ctx.depth - 1);
        ctx.inValue = false;
      } else if (ch === ";") {
        ctx.inValue = false;
      } else if (ch === ":" && ctx.depth > 0 && !ctx.inValue) {
        ctx.inValue = true;
      }
    },
    word: (_word, ctx, next) => {
      if (next === "(") {
        return "tok-fn";
      }
      if (ctx.inValue) {
        return "tok-lit";
      }
      if (ctx.depth > 0 && next === ":") {
        return "tok-attr";
      }
      return "tok-type";
    },
  });

/** HTML/XML: tag names, attributes and their values; entities outside tags. */
const MARKUP = makeLang({
  rules: [
    blockComment("<!--", "-->"),
    { re: sticky("<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)"), cls: "tok-str", first: "<" },
    { re: sticky("<[!?][^>]*>?"), cls: "tok-meta", first: "<" },
    {
      re: sticky("(<\\/?)([A-Za-z][\\w:.-]*)"),
      cls: (match) => [
        ["", match[1] ?? ""],
        ["tok-kw", match[2] ?? ""],
      ],
      first: "<",
      after: (_raw, ctx) => {
        ctx.inTag = true;
      },
    },
    {
      re: sticky("\\/?>"),
      cls: "",
      first: "/>",
      when: (ctx) => ctx.inTag,
      after: (_raw, ctx) => {
        ctx.inTag = false;
      },
    },
    { re: sticky("\"[^\"]*\"?|'[^']*'?"), cls: "tok-str", first: "\"'", when: (ctx) => ctx.inTag },
    { re: sticky("[^\\s=/>\"']+"), cls: "tok-attr", when: (ctx) => ctx.inTag },
    { re: sticky("&[#\\w]+;"), cls: "tok-lit", first: "&" },
  ],
  ident: sticky("(?!)"),
});

const GENERIC = makeLang({
  rules: [...C_COMMENTS, HASH_COMMENT, quoted("`", true), DQ, SQ, NUMBER, DECORATOR],
  keywords: words(
    "if else elif for while do return break continue function func fn def class struct enum interface import from export package use let const var new try catch finally throw switch case default match in of and or not public private static async await yield",
  ),
  literals: words("true false null nil none None True False undefined this self"),
  defs: words("function func fn def"),
  typeDefs: words("class struct enum interface"),
  capTypes: true,
});

const LANGS: Record<string, Lang> = {
  js: js(JS_KEYWORDS),
  ts: js(TS_KEYWORDS, "string number boolean any unknown never object symbol bigint void"),
  json: JSON_LANG,
  python: PYTHON,
  ruby: RUBY,
  rust: RUST,
  go: GO,
  c: C,
  java: JAVA,
  csharp: CSHARP,
  kotlin: KOTLIN,
  swift: SWIFT,
  scala: SCALA,
  dart: DART,
  php: PHP,
  bash: BASH,
  powershell: POWERSHELL,
  sql: SQL,
  lua: LUA,
  graphql: GRAPHQL,
  dockerfile: DOCKERFILE,
  yaml: YAML,
  toml: TOML,
  diff: DIFF,
  css: css(false),
  scss: css(true),
  html: MARKUP,
  generic: GENERIC,
};

/* ------------------------------------------------------------------------------------------ */
/* Detection for untagged blocks                                                               */

/** Best guess at the language of an untagged code block; "generic" when nothing stands out. */
export function detectLanguage(text: string): string {
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  const trimmed = sample.trim();
  if (!trimmed) {
    return "text";
  }
  const shebang = /^#!.*\b(bash|sh|zsh|python3?|node|ruby|php)\b/.exec(trimmed);
  if (shebang) {
    return languageName(shebang[1] ?? "");
  }
  if (/^[[{]/.test(trimmed)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // not strict JSON, keep guessing
    }
  }
  if (/^(?:diff --git|--- a\/|@@ -\d)/m.test(sample)) {
    return "diff";
  }
  if (/^<(?:!doctype|\?xml|[a-z][\w-]*[\s>])/i.test(trimmed)) {
    return "html";
  }
  if (
    /^\s*(?:select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|create\s+(?:table|index|view)|delete\s+from)\b/im.test(
      sample,
    )
  ) {
    return "sql";
  }
  if (/^\s*(?:FROM|RUN|COPY|WORKDIR|ENTRYPOINT)\s/m.test(sample) && /^\s*FROM\s/m.test(sample)) {
    return "dockerfile";
  }
  if (
    /^\s*(?:def \w+\(.*\)\s*(?:->.*)?:|class \w+(?:\(.*\))?:|from [\w.]+ import |import \w+\s*$|if __name__ ==)/m.test(
      sample,
    )
  ) {
    return "python";
  }
  if (/^\s*package main\b|\bfunc (?:\(\w+ \*?\w+\) )?\w+\(|:=/m.test(sample) && !/\bfunction\b/.test(sample)) {
    return "go";
  }
  if (/\bfn \w+\s*[(<]|\blet mut\b|\bimpl\b.*\{|println!\(/.test(sample)) {
    return "rust";
  }
  if (/^\s*#include\s*[<"]|\bint main\s*\(|\bstd::/m.test(sample)) {
    return "c";
  }
  if (/\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|void|int|String)\b/.test(sample)) {
    return /\busing System\b|\bnamespace \w+/.test(sample) ? "csharp" : "java";
  }
  if (/<\?php/.test(sample)) {
    return "php";
  }
  if (/\b(?:interface \w+\s*\{|type \w+\s*=|: (?:string|number|boolean)\b|as const\b)/.test(sample)) {
    return "ts";
  }
  if (
    /\b(?:function\b|const \w+\s*=|let \w+\s*=|=>|console\.\w+|require\(|import .+ from ['"]|export (?:default|const|function))/.test(
      sample,
    )
  ) {
    return "js";
  }
  if (/^\s*[.#]?[\w-]+(?:[\s,>+~:.#[\]\w-]*)\{\s*$/m.test(sample) && /^\s*[\w-]+\s*:\s*[^;]+;\s*$/m.test(sample)) {
    return "css";
  }
  if (
    /^\s*(?:echo|cd|export|sudo|npm|git|curl|brew|apt(?:-get)?|docker|ls|mkdir)\s/m.test(sample) ||
    /^\$ /m.test(sample)
  ) {
    return "bash";
  }
  if (/^\[[\w.-]+\]\s*$/m.test(sample) && /^\s*[\w.-]+\s*=\s*\S/m.test(sample)) {
    return "toml";
  }
  if (/^\s*(?:- )?[\w.-]+:(?:\s|$)/m.test(sample) && !/[;{}]\s*$/m.test(sample)) {
    return "yaml";
  }
  return "generic";
}

/* ------------------------------------------------------------------------------------------ */
/* Rendering                                                                                   */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineHtml(inner: string): string {
  return `<span class="md-line"><span class="md-line-text">${inner}</span></span>`;
}

/** Joins tokens into one `md-line` per source line; a token that spans lines is split per line. */
function render(pieces: Piece[]): string {
  const lines: string[] = [];
  let current = "";
  for (const [cls, text] of pieces) {
    const parts = text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push(current);
        current = "";
      }
      if (part) {
        current += cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
      }
    });
  }
  lines.push(current);
  return lines.map(lineHtml).join("\n");
}

/** The language actually used for `lang` and `text` (detected when the block has no tag). */
export function resolvedLanguage(text: string, lang: string): string {
  const name = languageName(lang);
  if (!name) {
    return detectLanguage(text);
  }
  if (name === "text" || name === "markdown" || LANGS[name]) {
    return name;
  }
  return "generic";
}

export function highlightCode(text: string, lang: string): string {
  const name = resolvedLanguage(text, lang);
  if (name === "markdown") {
    return highlightMarkdown(text, { tags: false });
  }
  const spec = LANGS[name];
  if (!spec) {
    return text
      .split("\n")
      .map((line) => lineHtml(escapeHtml(line)))
      .join("\n");
  }
  return render(tokenize(text, spec));
}
