// Syntax highlighting for diff lines, as plain tokens (no HTML injected
// into the page). highlight.js output is parsed into {text, cls} runs
// and split at newlines, so a hunk can be highlighted as one block (keeps
// multi-line strings and comments right) and rendered line by line.

import type { HLJSApi, LanguageFn } from "highlight.js";

export interface Token {
  text: string;
  /** highlight.js classes without the prefix, e.g. "keyword", "title function_". */
  cls: string | null;
  /** Part of the intra-line change. */
  mark?: boolean;
}

const EXT: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  dockerfile: "dockerfile",
  gradle: "groovy",
  groovy: "groovy",
  lua: "lua",
  dart: "dart",
  scala: "scala",
};

const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  rust: () => import("highlight.js/lib/languages/rust"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  python: () => import("highlight.js/lib/languages/python"),
  go: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  php: () => import("highlight.js/lib/languages/php"),
  swift: () => import("highlight.js/lib/languages/swift"),
  bash: () => import("highlight.js/lib/languages/bash"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  xml: () => import("highlight.js/lib/languages/xml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  sql: () => import("highlight.js/lib/languages/sql"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  groovy: () => import("highlight.js/lib/languages/groovy"),
  lua: () => import("highlight.js/lib/languages/lua"),
  dart: () => import("highlight.js/lib/languages/dart"),
  scala: () => import("highlight.js/lib/languages/scala"),
};

export function languageFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile") return null;
  const dot = base.lastIndexOf(".");
  return dot < 0 ? null : (EXT[base.slice(dot + 1)] ?? null);
}

let core: Promise<HLJSApi> | null = null;
const loaded = new Map<string, Promise<boolean>>();

/** Load highlight.js and the language; resolves false if unknown. */
export function loadLanguage(lang: string): Promise<boolean> {
  const loader = LOADERS[lang];
  if (!loader) return Promise.resolve(false);
  let p = loaded.get(lang);
  if (!p) {
    core ??= import("highlight.js/lib/core").then((m) => m.default);
    p = Promise.all([core, loader()])
      .then(([hljs, mod]) => {
        hljs.registerLanguage(lang, mod.default);
        return true;
      })
      .catch(() => false);
    loaded.set(lang, p);
  }
  return p;
}

let hljsSync: HLJSApi | null = null;

/** Highlight `lines` as one block. Call after `loadLanguage` resolved
 *  true; returns plain tokens otherwise. */
export async function highlightLines(lines: string[], lang: string): Promise<Token[][]> {
  if (!(await loadLanguage(lang))) return lines.map(plain);
  hljsSync ??= await core!;
  const html = hljsSync.highlight(lines.join("\n"), { language: lang, ignoreIllegals: true }).value;
  const out = parseHighlighted(html);
  // Defensive: the parser must return exactly one entry per input line.
  return out.length === lines.length ? out : lines.map(plain);
}

export function plain(text: string): Token[] {
  return [{ text, cls: null }];
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** Parse highlight.js HTML (only `<span class="hljs-…">`, `</span>`,
 *  escaped text) into token lines. */
export function parseHighlighted(html: string): Token[][] {
  const lines: Token[][] = [[]];
  const stack: string[] = [];
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      stack.push(m[1].replace(/hljs-/g, ""));
    } else if (m[0] === "</span>") {
      stack.pop();
    } else {
      const text = m[2].replace(/&(amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e);
      const cls = stack.length ? stack[stack.length - 1] : null;
      const parts = text.split("\n");
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push({ text: part, cls });
      });
    }
  }
  return lines;
}

/** Mark characters [start, end) of a token line as changed. */
export function markRange(tokens: Token[], start: number, end: number): Token[] {
  if (start >= end) return tokens;
  const out: Token[] = [];
  let pos = 0;
  for (const t of tokens) {
    const a = pos;
    const b = pos + t.text.length;
    pos = b;
    if (b <= start || a >= end) {
      out.push(t);
      continue;
    }
    const s = Math.max(start, a) - a;
    const e = Math.min(end, b) - a;
    if (s > 0) out.push({ ...t, text: t.text.slice(0, s) });
    out.push({ ...t, text: t.text.slice(s, e), mark: true });
    if (e < t.text.length) out.push({ ...t, text: t.text.slice(e) });
  }
  return out;
}

/** The differing middle of two lines, as [start, end) in each, or null
 *  when they share too little for the emphasis to help. */
export function changedRange(a: string, b: string): [[number, number], [number, number]] | null {
  let pre = 0;
  const max = Math.min(a.length, b.length);
  while (pre < max && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const common = pre + suf;
  if (common === 0 || common < Math.min(a.length, b.length) * 0.3) return null;
  return [
    [pre, a.length - suf],
    [pre, b.length - suf],
  ];
}

/** Above this many lines a diff is shown without syntax colours. */
const MAX_HIGHLIGHT_LINES = 8000;

/** Tokens for every line of every hunk (aligned with `hunk.lines`):
 *  syntax colours when the language is known, plus intra-line marks for
 *  paired deletions and additions. */
export async function diffTokens(
  path: string,
  hunks: { lines: { kind: "add" | "del" | "ctx"; text: string }[] }[],
): Promise<Token[][][]> {
  const lang = languageFor(path);
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  const useLang = lang && total <= MAX_HIGHLIGHT_LINES && (await loadLanguage(lang)) ? lang : null;

  const out: Token[][][] = [];
  for (const h of hunks) {
    const oldIdx: number[] = [];
    const newIdx: number[] = [];
    h.lines.forEach((l, i) => {
      if (l.kind !== "add") oldIdx.push(i);
      if (l.kind !== "del") newIdx.push(i);
    });
    const tokens: Token[][] = h.lines.map((l) => plain(l.text));
    if (useLang) {
      const [oldT, newT] = await Promise.all([
        highlightLines(oldIdx.map((i) => h.lines[i].text), useLang),
        highlightLines(newIdx.map((i) => h.lines[i].text), useLang),
      ]);
      oldIdx.forEach((i, k) => {
        if (h.lines[i].kind === "del") tokens[i] = oldT[k];
      });
      newIdx.forEach((i, k) => (tokens[i] = newT[k]));
    }
    // Pair each run of deletions with the additions right after it.
    let i = 0;
    while (i < h.lines.length) {
      if (h.lines[i].kind !== "del") {
        i++;
        continue;
      }
      const dels: number[] = [];
      while (i < h.lines.length && h.lines[i].kind === "del") dels.push(i++);
      const adds: number[] = [];
      while (i < h.lines.length && h.lines[i].kind === "add") adds.push(i++);
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const r = changedRange(h.lines[dels[k]].text, h.lines[adds[k]].text);
        if (!r) continue;
        tokens[dels[k]] = markRange(tokens[dels[k]], r[0][0], r[0][1]);
        tokens[adds[k]] = markRange(tokens[adds[k]], r[1][0], r[1][1]);
      }
    }
    out.push(tokens);
  }
  return out;
}
