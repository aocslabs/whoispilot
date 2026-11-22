// Builds media/dataset/<lang>.json: real code blocks (an `if` with its body, a <table> with its rows, a function ...)
// taken verbatim from permissively licensed open-source repositories cloned by fetch-corpus.mjs.
//   node tools/fetch-corpus.mjs <dir>
//   node tools/build-dataset.mjs <dir> [--langs python,html]
// Attribution (repository + license of every block) is written to DATASET-NOTICE.md.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "media", "dataset");
const CORPUS = path.resolve(process.argv[2] ?? "corpus");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = (arg("langs", "") ?? "").split(",").filter(Boolean);
const PER_KEY = 30, PER_LANG = 600, MAXL = 20;
const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "Unlicense", "ISC"]);

const BRACE = /^(if|for|while|switch|try|function|async|class|export|const|let|var|public|private|protected|internal|static|final|abstract|func|fun|fn|pub|impl|struct|enum|match|when|guard|loop|type|defer|select|namespace|template|foreach|int|void|char|double|float|bool|unsigned|override|using|else|do|extension|protocol|init|object|interface)\b/;
const LANGS = {
  python: { exts: [".py"], kind: "indent", start: /^(if|for|while|def|class|try|with|async def)\b.*:\s*$/ },
  javascript: { exts: [".js", ".mjs", ".cjs"], kind: "brace", start: BRACE },
  typescript: { exts: [".ts", ".tsx"], kind: "brace", start: BRACE },
  java: { exts: [".java"], kind: "brace", start: BRACE },
  kotlin: { exts: [".kt"], kind: "brace", start: BRACE },
  csharp: { exts: [".cs"], kind: "brace", start: BRACE },
  c: { exts: [".c", ".h"], kind: "brace", start: BRACE },
  cpp: { exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh"], kind: "brace", start: BRACE },
  go: { exts: [".go"], kind: "brace", start: BRACE },
  rust: { exts: [".rs"], kind: "brace", start: BRACE },
  php: { exts: [".php"], kind: "brace", start: BRACE },
  swift: { exts: [".swift"], kind: "brace", start: BRACE },
  ruby: { exts: [".rb"], kind: "end", start: /^(if|unless|def|class|module|begin|case|while|until)\b|\bdo(\s*\|[^|]*\|)?\s*$/, end: /^end\b/ },
  lua: { exts: [".lua"], kind: "end", start: /^(if|for|while|function|local function|repeat)\b/, end: /^(end|until)\b/ },
  shell: { exts: [".sh", ".bash"], kind: "end", start: /^(if|for|while|case|until)\b|^(function\s+)?\w+\s*\(\)\s*\{\s*$/, end: /^(fi|done|esac)\b|^\}/ },
  css: { exts: [".css", ".scss"], kind: "css" },
  html: { exts: [".html", ".htm"], kind: "html" },
};

const BAD_PATH = /(^|[\\/])(vendor|node_modules|third[_-]?party|bower_components|dist|build|generated|docs?[\\/]_build|\.git|\.github)([\\/]|$)|\.min\.|\.generated\.|\.d\.ts$/i;
const BAD_PATH_HTML = /(^|[\\/])(vendor|node_modules|third[_-]?party|bower_components|\.git|\.github)([\\/]|$)|\.min\./i; // html demo pages live in dist/ in many projects
function* walk(dir, bad = BAD_PATH) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (bad.test(p.slice(CORPUS.length))) continue;
    if (e.isDirectory()) yield* walk(p, bad); else yield p;
  }
}

// ---- block extraction ----------------------------------------------------------------------
const indentOf = (l) => /^[ \t]*/.exec(l)[0].length;

function braceBlocks(lines, start) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!start.test(t)) continue;
    if (!t.endsWith("{") && lines[i + 1]?.trim() !== "{") continue; // `{` at the end of the line, or alone on the next (Allman style)
    let depth = 0, j = i, opened = false;
    for (; j < lines.length && j - i < MAXL; j++) {
      const s = lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
      const o = (s.match(/\{/g) ?? []).length;
      opened ||= o > 0;
      depth += o - (s.match(/\}/g) ?? []).length;
      if (opened && depth <= 0) break;
    }
    if (opened && depth <= 0 && j > i + 1) { out.push(lines.slice(i, j + 1)); i = j; }
  }
  return out;
}
function indentBlocks(lines, start) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!start.test(lines[i].trim()) || /^\s*#/.test(lines[i])) continue;
    const base = indentOf(lines[i]);
    let j = i + 1;
    while (j < lines.length && j - i <= MAXL && (lines[j].trim() === "" || indentOf(lines[j]) > base)) j++;
    const blk = lines.slice(i, j); while (blk.length && blk[blk.length - 1].trim() === "") blk.pop();
    if (blk.length >= 3) { out.push(blk); i = j - 1; }
  }
  return out;
}
function endBlocks(lines, spec) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!spec.start.test(t) || t.startsWith("#") || t.startsWith("--")) continue;
    const base = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length && j - i < MAXL; j++) {
      if (indentOf(lines[j]) === base && spec.end.test(lines[j].trim())) { if (j > i + 1) { out.push(lines.slice(i, j + 1)); i = j; } break; }
    }
  }
  return out;
}
const HTML_SKIP = /^(br|hr|img|input|meta|link|html|head|body|script|style|title|tr|td|th|li|dd|dt|option)$/i; // whole elements people start typing
// A real table has dozens of rows; keep the first two of every run of <tr>/<li>/<option>... so the block stays readable.
function condenseRows(lines) {
  const out = [], runs = new Map();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], ind = indentOf(l);
    const m = /^\s*<(tr|li|option|dt|dd)\b/i.exec(l);
    for (const k of runs.keys()) if (Number(k.split("|")[0]) > ind || (Number(k.split("|")[0]) === ind && !(m && k === `${ind}|${m[1].toLowerCase()}`))) runs.delete(k);
    if (!m) { out.push(l); continue; }
    const key = `${ind}|${m[1].toLowerCase()}`, n = (runs.get(key) ?? 0) + 1;
    runs.set(key, n);
    if (n <= 2) { out.push(l); continue; }
    if (new RegExp(`</${m[1]}>`, "i").test(l)) continue; // the whole row is on this line
    let j = i + 1; while (j < lines.length && !(indentOf(lines[j]) === ind && new RegExp(`^\\s*</${m[1]}>`, "i").test(lines[j]))) j++;
    i = j; // skip the row up to its closing tag
  }
  return out;
}
function htmlBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*<([a-z][a-z0-9]*)\b[^>]*>\s*$/i.exec(lines[i]);
    if (!m || HTML_SKIP.test(m[1])) continue;
    const base = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length && j - i < 1500; j++) {
      if (indentOf(lines[j]) === base && new RegExp(`^\\s*</${m[1]}>`, "i").test(lines[j])) {
        if (j > i + 2) { const blk = condenseRows(lines.slice(i, j + 1)); if (blk.length <= 45) out.push(blk); } // inner elements (a <table> inside a card) are scanned too
        break;
      }
    }
  }
  return out;
}
function cssBlocks(lines) {
  const out = [], decl = /^\s*[\w-]+\s*:\s*[^;{}]+;\s*(\/\*.*\*\/)?\s*$/;
  for (let i = 0; i < lines.length; i++) { // runs of declarations: `display: flex; align-items: ...`
    if (!decl.test(lines[i])) continue;
    let j = i; while (j < lines.length && decl.test(lines[j]) && j - i < 8) j++;
    if (j - i >= 2) out.push(lines.slice(i, j));
    i = j;
  }
  return [...out, ...braceBlocks(lines, /^[.#@\w]/)];
}
function extract(spec, lines) {
  switch (spec.kind) {
    case "brace": return braceBlocks(lines, spec.start);
    case "indent": return indentBlocks(lines, spec.start);
    case "end": return endBlocks(lines, spec);
    case "html": return htmlBlocks(lines);
    case "css": return cssBlocks(lines);
  }
}

// ---- clean up + filters --------------------------------------------------------------------
const RISKY = /(xox[baprs]-|ghp_|github_pat_|AKIA[0-9A-Z]{8}|AIza[0-9A-Za-z_-]{16}|eyJ[A-Za-z0-9_-]{15}|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|BEGIN [A-Z ]*KEY|@[\w-]+\.[a-z]{2,}|\b\d{1,3}(\.\d{1,3}){3}\b|https?:\/\/|copyright|license|author|todo:|fixme|hack)/i;
function normalize(block) {
  const base = indentOf(block[0]);
  const rel = block.map((l) => (l.trim() === "" ? "" : l.slice(Math.min(base, indentOf(l))).replace(/\s+$/, "")));
  const spaces = rel.map((l) => /^( +)\S/.exec(l)?.[1].length).filter(Boolean);
  if (rel.some((l) => /^\t/.test(l)) && spaces.length) return null; // tabs and spaces mixed
  const unit = spaces.length ? Math.min(...spaces) : 0;
  if (unit && ![2, 3, 4, 8].includes(unit)) return null;
  const out = rel.map((l) => (unit ? l.replace(/^( +)/, (s) => (s.length % unit ? "\u0000" : "\t".repeat(s.length / unit))) : l));
  return out.some((l) => l.includes("\u0000")) ? null : out.join("\n"); // "\t" = one indent level
}
function acceptable(text, minLines, maxLines = MAXL, maxChars = 1000) {
  const lines = text.split("\n");
  return lines.length >= minLines && lines.length <= maxLines && text.length <= maxChars && text.length >= 40 &&
    lines.every((l) => l.length <= 110) && !RISKY.test(text) && !/[^\x09\x0a\x20-\x7e]/.test(text);
}
const keyOf = (text) => /^[^\w<@#.]*([\w<@#.-]+)/.exec(text)?.[1]?.toLowerCase() ?? "";

// ---- main ----------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, "corpus.json"), "utf8")).filter((m) => ALLOWED.has(m.license));
const notice = [];
for (const [id, spec] of Object.entries(LANGS)) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  const seen = new Set(), items = [], repos = [], repoIdx = new Map();
  let nFiles = 0, nBlocks = 0;
  for (const m of manifest) {
    for (const file of walk(m.dir, id === "html" ? BAD_PATH_HTML : BAD_PATH)) {
      if (!spec.exts.includes(path.extname(file).toLowerCase())) continue;
      let src; try { if (fs.statSync(file).size > 250_000) continue; src = fs.readFileSync(file, "utf8"); } catch { continue; }
      const lines = src.replace(/\r\n/g, "\n").split("\n");
      if (lines.length > 4000 || (id !== "html" && lines.some((l) => l.length > 300))) continue; // minified / generated (html pages often inline one long script line)
      nFiles++;
      for (const blk of extract(spec, lines)) {
        nBlocks++;
        const text = normalize(blk);
        if (process.env.DEBUG_BLOCK && blk[0].trim().startsWith(process.env.DEBUG_BLOCK)) console.log(`  [debug] ${path.basename(file)}: ${blk.length} lines, normalized=${!!text}, ok=${text ? acceptable(text, 3, 45, 2600) : "-"}, risky=${text ? RISKY.exec(text)?.[0] : "-"}`);
        if (!text || !(id === "html" ? acceptable(text, 3, 45, 2600) : acceptable(text, spec.kind === "css" ? 2 : 3))) continue;
        if (id === "html" && /\{%|\{\{|<\?|<%|<!--\s*generated/i.test(text)) continue; // template-engine syntax is not plain html
        const sig = text.replace(/\s+/g, " ");
        if (seen.has(sig)) continue;
        seen.add(sig);
        const tag = `${m.repo} (${m.license})`;
        if (!repoIdx.has(tag)) { repoIdx.set(tag, repos.length); repos.push(tag); }
        items.push([text, repoIdx.get(tag)]);
      }
    }
  }
  // a varied, mid-length selection: at most PER_KEY per first word, prefer ~8 lines
  const byKey = new Map();
  for (const it of items) { const k = keyOf(it[0]); (byKey.get(k) ?? byKey.set(k, []).get(k)).push(it); }
  const score = (it) => -Math.abs(it[0].split("\n").length - 8);
  let kept = [...byKey.values()].flatMap((g) => g.sort((a, b) => score(b) - score(a)).slice(0, PER_KEY));
  kept = kept.sort((a, b) => score(b) - score(a)).slice(0, PER_LANG);
  const used = [...new Set(kept.map((k) => k[1]))];
  const remap = new Map(used.map((o, n) => [o, n]));
  fs.writeFileSync(path.join(OUT, id + ".json"), JSON.stringify({ v: 1, lang: id, repos: used.map((o) => repos[o]), items: kept.map(([t, r]) => [t, remap.get(r)]) }));
  console.log(`${id.padEnd(11)} files=${String(nFiles).padStart(5)} blocks=${String(nBlocks).padStart(6)} kept=${String(kept.length).padStart(4)} repos=${used.length} firstWords=${byKey.size}`);
  notice.push(`## ${id}\n\n${used.map((o) => "- " + repos[o]).join("\n")}\n`);
}
if (!ONLY.length) {
  fs.writeFileSync(path.join(ROOT, "DATASET-NOTICE.md"),
    "# Dataset notice\n\nThe instant suggestions in `media/dataset/*.json` are whole code blocks taken verbatim from the public GitHub repositories below.\n" +
    "Only repositories under permissive licenses (MIT, Apache-2.0, BSD, Unlicense, ISC) were used. Every block belongs to its original authors and stays under\n" +
    "that repository's license; keep this notice (and the repositories' license texts, available at the URLs `https://github.com/<repo>`) when you redistribute.\n\n" +
    notice.join("\n"));
}
