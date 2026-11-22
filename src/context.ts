// Three general techniques every inline-completion tool needs, written from scratch (no code from any other product):
//   1. related code from the user's OTHER open files, so the model can reuse their names and helpers
//   2. cutting a suggestion at the end of a block instead of in the middle of a line
//   3. dropping a suggestion that starts to loop
// Pure module (no `vscode` import).
import { names } from "./snippets";

export interface OtherFile { name: string; text: string; }

/**
 * Snippets of other open files that share names with the code around the cursor. Small on purpose: at most `maxSnippets`
 * windows of `maxChars` characters, so the extra context costs a few hundred tokens, not thousands.
 */
export function relatedSnippets(near: string, files: OtherFile[], o: { maxSnippets?: number; maxChars?: number } = {}): string {
  const maxSnippets = o.maxSnippets ?? 2, maxChars = o.maxChars ?? 500;
  const want = new Set(names(near));
  if (want.size < 3) return ""; // nothing to match against
  const found: { score: number; name: string; at: number; chunk: string }[] = [];
  for (const f of files) {
    const lines = f.text.split("\n", 3000);
    for (let i = 0; i < lines.length; i += 6) {
      const chunk = lines.slice(i, i + 14).join("\n").slice(0, maxChars);
      const set = new Set(names(chunk));
      let shared = 0;
      for (const t of set) if (want.has(t)) shared++;
      if (shared >= 2) found.push({ score: shared / Math.sqrt(set.size + 4), name: f.name, at: i, chunk });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const picked: typeof found = [];
  for (const c of found) {
    if (picked.length >= maxSnippets) break;
    if (picked.some((p) => p.name === c.name && Math.abs(p.at - c.at) < 14)) continue; // overlaps one already taken
    picked.push(c);
  }
  return picked.map((p) => `// Path: ${p.name}\n${p.chunk}`).join("\n\n");
}

const OPEN = "([{", CLOSE = ")]}";

/**
 * A suggestion that was cut off by the length limit ends mid-line, usually mid-statement. Drop the partial last line, and if
 * brackets are still open, go back to the last line where everything the suggestion opened was closed again.
 */
export function trimToBlock(text: string, truncated: boolean): string {
  if (!truncated) return text;
  let lines = text.split("\n");
  if (lines.length > 1) lines.pop(); // the last line is incomplete
  const depthAfter: number[] = [];
  let depth = 0;
  for (const l of lines) {
    for (const ch of l.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) { if (OPEN.includes(ch)) depth++; else if (CLOSE.includes(ch)) depth--; }
    depthAfter.push(depth);
  }
  if (depth > 0) {
    let k = depthAfter.length - 1;
    while (k >= 0 && depthAfter[k] > 0) k--;
    if (k >= 0) lines = lines.slice(0, k + 1);
  }
  return lines.join("\n").replace(/\s+$/, "");
}

/** Cut at the point where the model starts repeating itself (the same meaningful line three times, or a two-line pattern twice). */
export function dropRepetition(text: string): string {
  const lines = text.split("\n");
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length >= 8) {
      const n = (seen.get(t) ?? 0) + 1;
      seen.set(t, n);
      if (n >= 3) return lines.slice(0, i).join("\n").replace(/\s+$/, "");
    }
    if (i >= 3 && t.length >= 4 && lines[i - 1].trim() === lines[i - 3].trim() && t === lines[i - 2].trim() && t !== lines[i - 1].trim()) {
      return lines.slice(0, i - 1).join("\n").replace(/\s+$/, ""); // a, b, a, b
    }
  }
  return text;
}
