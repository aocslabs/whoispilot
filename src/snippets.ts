// Instant suggestions from REAL code: whole blocks (an `if` with its body, a <table> with its rows, a function ...)
// mined from permissively licensed open-source repositories (tools/build-dataset.mjs -> media/dataset/<lang>.json).
// Nothing here is written by hand. Pure node (no `vscode` import).
//
// Which block? The one that looks most like the code you are writing: shared names (weighted by how rare they are in the
// data, snake_case / camelCase split into words), with the last lines before the cursor counting most. When the file already
// has real code and no block resembles it, nothing is shown instantly and the model answers instead: a block that has
// nothing to do with your code is worse than waiting.
import * as fs from "node:fs";
import * as path from "node:path";
import { Match, baseLang, triggerToken } from "./templates";

interface Index { repos: string[]; items: [string, number][]; toks?: Set<string>[]; idf?: Map<string, number>; }
const cache = new Map<string, Index | null>();
let dir = path.join(__dirname, "..", "media", "dataset");

export const setDatasetDir = (d: string) => { dir = d; cache.clear(); };

const STOP = new Set(["the", "and", "for", "not", "this", "self", "true", "false", "null", "none", "nil", "return", "const", "let", "var", "def", "func", "fun",
  "int", "void", "string", "else", "elif", "import", "from", "class", "new", "public", "private", "static", "final", "try", "catch", "except", "with", "while",
  "then", "end", "use", "pub", "mut", "type", "async", "await", "function", "package", "struct", "enum", "impl", "match", "switch", "case", "default", "break",
  "continue", "div", "span", "class", "href", "src", "style", "px",
  // entry-point boilerplate says nothing about what the next statement does
  "main", "argc", "argv", "args", "init", "run", "test", "iostream", "stdio", "std", "namespace", "using", "include", "stdlib", "string"]);

// A block that declares something at the top level (a function `main`, a class, an import) cannot be what you start typing
// inside an indented body. (Python, Ruby, Lua, shell, css and html nest such things legitimately, so they are exempt.)
const TOP_LEVEL_ONLY = /^(?:(?:int|void|char|double|float|bool|auto|static)\s+\w*\s*main\b|class\b|struct\b|enum\b|interface\b|namespace\b|template\b|package\b|import\b|using\b|#include\b|func\s+main\b|fn\s+main\b)/;
const NESTS_DECLARATIONS = new Set(["python", "ruby", "lua", "shell", "css", "html"]);

/** Names in a piece of code, as lowercase words: `userId` -> userid, user; `get_user_name` -> get_user_name, get, user, name. */
export function names(s: string): string[] {
  const out: string[] = [];
  for (const id of s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    const low = id.toLowerCase();
    if (STOP.has(low)) continue;
    out.push(low);
    const raw = id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_");
    if (raw.length > 1) out.push(...raw.filter((p) => p.length >= 3 && !STOP.has(p))); // runGamma -> gamma (and not "run")
  }
  return out;
}

function load(lang: string): Index | null {
  const id = baseLang(lang);
  if (!cache.has(id)) {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(dir, id + ".json"), "utf8")) as Index;
      idx.toks = idx.items.map(([t]) => new Set(names(t)));
      const df = new Map<string, number>();
      for (const s of idx.toks) for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
      idx.idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + idx.items.length / (1 + n))]));
      cache.set(id, idx);
    } catch { cache.set(id, null); }
  }
  return cache.get(id) ?? null;
}

/** Number of blocks available for a language (0 = none). */
export const datasetSize = (lang: string) => load(lang)?.items.length ?? 0;

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** Context with weights: the last lines before the cursor count 3x, the rest 1x, the first lines after the cursor 1.5x. */
function weigh(before: string, after: string): Map<string, number> {
  const w = new Map<string, number>();
  const add = (text: string, k: number) => { for (const t of names(text)) w.set(t, Math.max(w.get(t) ?? 0, k)); };
  const lines = before.split("\n");
  add(lines.slice(0, -12).join("\n"), 1);
  add(lines.slice(-12).join("\n"), 3);
  add(after.split("\n").slice(0, 6).join("\n"), 1.5);
  return w;
}

const MIN_SIMILARITY = 0.45;  // below this, when there is code right above the cursor, no instant block is shown
const RECENT_NAMES = 2;       // names in the last lines that already say what the next statement is about (variables just declared...)

export function pickBlock(lang: string, lineBefore: string, before: string, after = ""): (Match & { source: string; similarity: number }) | undefined {
  const typed = triggerToken(lang, lineBefore);
  const idx = typed ? load(lang) : null;
  if (!typed || !idx?.toks || !idx.idf) return undefined;
  const ci = baseLang(lang) === "sql";
  const want = ci ? typed.toLowerCase() : typed;
  const ctx = weigh(before, after);
  const seed = hash(before.slice(-400) + "|" + lineBefore);
  const indented = /^\s+/.test(lineBefore) && !NESTS_DECLARATIONS.has(baseLang(lang));
  let best: { score: number; sim: number; i: number } | undefined;
  idx.items.forEach(([block], i) => {
    const first = ci ? block.slice(0, want.length).toLowerCase() : block.slice(0, want.length);
    if (first !== want) return;
    if (indented && TOP_LEVEL_ONLY.test(block)) return; // inside a body: no function / class / import blocks
    const toks = idx.toks![i];
    let sum = 0;
    for (const t of toks) { const wt = ctx.get(t); if (wt) sum += (idx.idf!.get(t) ?? 0) * wt; }
    const sim = sum / Math.sqrt(toks.size + 4);
    const lines = block.split("\n").length;
    const score = sim + (lines >= 4 && lines <= 14 ? 0.15 : 0) + (((hash(String(i)) ^ seed) >>> 0) % 1000) / 1000 * 0.15;
    if (!best || score > best.score) best = { score, sim, i };
  });
  if (!best) return undefined;
  // Variables declared a line or two above (`int nilai; string keterangan;`) mean the next block will use them. A block from other
  // projects cannot, so showing it instantly would only be wrong: say nothing and let the model write it.
  const recent = new Set(names(before.split("\n").slice(-8).join("\n")));
  if (recent.size >= RECENT_NAMES && best.sim < MIN_SIMILARITY) return undefined;
  const [body, repo] = idx.items[best.i];
  return { typed, key: body.split("\n")[0], body, source: idx.repos[repo] ?? "", similarity: best.sim };
}
