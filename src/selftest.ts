// Live check with the REAL provider and the user's real login. Development mode only (see extension.ts).
// Types into real editors, waits for the ghost text and presses Tab, like a user would.
import * as vscode from "vscode";
import { names } from "./snippets";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Case { name: string; lang: string; content: string; typed: string; }

/** Almost-empty files: only plumbing and speed can be judged here. */
export const BASIC: Case[] = [
  { name: "html: t", lang: "html", content: "<body>\n  ", typed: "t" },
  { name: "javascript: i", lang: "javascript", content: "", typed: "i" },
  { name: "python: ret", lang: "python", content: "def add(a, b):\n    ret", typed: "" },
  { name: "go: f", lang: "go", content: "package main\n\nfunc main() {\n\t", typed: "f" },
  { name: "rust: l", lang: "rust", content: "fn main() {\n    ", typed: "l" },
  { name: "css: b", lang: "css", content: ".btn {\n  ", typed: "b" },
];

/** Files with real code before the cursor: the suggestion must use what is already there. */
export const REAL: Case[] = [
  { name: "python: loop over the items", lang: "python", typed: "f",
    content: "def total_price(items, tax_rate):\n    subtotal = 0\n    " },
  { name: "javascript: express handler", lang: "javascript", typed: "i",
    content: "app.get('/users/:id', async (req, res) => {\n  const user = await db.users.findById(req.params.id);\n  " },
  { name: "go: login handler", lang: "go", typed: "i",
    content: "func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {\n\tvar creds Credentials\n\t" },
  { name: "html: login form", lang: "html", typed: "<b",
    content: "<form action=\"/login\" method=\"post\">\n  <label for=\"email\">Email</label>\n  <input type=\"email\" id=\"email\" name=\"email\">\n  <label for=\"password\">Password</label>\n  <input type=\"password\" id=\"password\" name=\"password\">\n  " },
  { name: "rust: config parser", lang: "rust", typed: "l",
    content: "fn parse_config(path: &str) -> Result<Config, Error> {\n    let text = std::fs::read_to_string(path)?;\n    " },
  { name: "java: order service", lang: "java", typed: "r",
    content: "public class OrderService {\n    private final OrderRepository orders;\n\n    public Order find(long id) {\n        " },
  { name: "css: card layout", lang: "css", typed: "g",
    content: ".card {\n  display: flex;\n  flex-direction: column;\n  padding: 16px;\n  " },
  { name: "python: load users", lang: "python", typed: "w",
    content: "import json\n\ndef load_users(path):\n    " },
];

// ---- a typing session: build a real project the way a programmer does ---------------------------------------------
export interface Step {
  file: string;            // path inside the workspace folder, created when missing
  create?: string;         // initial content for a new file
  after?: string;          // put the cursor right after the first occurrence of this text (default: end of file)
  replace?: [string, string]; // a manual fix: replace the first occurrence (counted as typed text)
  type?: string;           // what the programmer types, character by character
  tabs?: number;           // how many times Tab is pressed to accept (default 1)
  settleMs?: number;       // wait before pressing Tab, so the model's version has replaced the instant block (default 7000)
  poll?: boolean;          // measure instead: press Tab every 300 ms until a suggestion is accepted (settleMs = the limit)
  preTriggerMs?: number;   // pause this long at the empty line (suggestion requested) before typing the first letter
  note?: string;
}

export async function runSession(steps: Step[], say: (l: string) => void): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri;
  let typed = 0, inserted = 0, fixes = 0, empty = 0;
  for (const [i, s] of steps.entries()) {
    const uri = vscode.Uri.joinPath(root, s.file);
    try { await vscode.workspace.fs.stat(uri); } catch { await vscode.workspace.fs.writeFile(uri, Buffer.from(s.create ?? "")); }
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    let pos = doc.positionAt(doc.getText().length);
    if (s.after) {
      const k = doc.getText().indexOf(s.after);
      if (k < 0) { say(`#${i} FAIL ${s.file}: marker not found: ${JSON.stringify(s.after.slice(0, 40))}`); continue; }
      pos = doc.positionAt(k + s.after.length);
    }
    ed.selection = new vscode.Selection(pos, pos);
    if (s.replace) {
      const k = doc.getText().indexOf(s.replace[0]);
      if (k < 0) { say(`#${i} FAIL ${s.file}: text to replace not found`); continue; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(k), doc.positionAt(k + s.replace[0].length)), s.replace[1]);
      await vscode.workspace.applyEdit(edit);
      typed += s.replace[1].length; fixes++;
      const end = doc.positionAt(k + s.replace[1].length);
      ed.selection = new vscode.Selection(end, end);
    }
    const startOffset = doc.offsetAt(ed.selection.active);
    if (s.preTriggerMs !== undefined) { // the programmer pauses at the empty line first: the model call can start before the first letter
      await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
      await sleep(s.preTriggerMs);
    }
    const tType = Date.now();
    for (const ch of s.type ?? "") await vscode.commands.executeCommand("type", { text: ch });
    typed += (s.type ?? "").length;
    const afterTyped = doc.getText().length;
    const t0 = Date.now();
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    let accepted = 0, firstMs = 0;
    if (s.poll) {
      // measure: press Tab every 300 ms until something is accepted, and report the time counted from the first typed letter
      for (let w = 0; w < (s.settleMs ?? 25_000) / 300 && !accepted; w++) {
        await sleep(300);
        const before = doc.getText();
        await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
        await sleep(80);
        if (doc.getText() !== before) { accepted = 1; firstMs = Date.now() - tType; }
      }
    } else await sleep(s.settleMs ?? 7000);
    for (let t = 0; !s.poll && t < (s.tabs ?? 1); t++) {
      const before = doc.getText();
      await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
      await sleep(600);
      if (doc.getText() === before) break;
      accepted++;
      if (t + 1 < (s.tabs ?? 1)) { await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"); await sleep(6000); }
    }
    const gained = doc.getText().length - afterTyped;
    if (!accepted) empty++;
    inserted += Math.max(0, gained);
    await doc.save();
    const region = doc.getText().slice(startOffset).replace(/\r\n/g, "\n");
    say(`#${i} ${s.note ?? ""}  [${s.file}]  typed ${JSON.stringify((s.type ?? "").slice(0, 60))}${s.replace ? " + manual fix" : ""}  ->  ${accepted ? `+${gained} chars by Tab` : "NO SUGGESTION"}  (${s.poll ? `first suggestion ${firstMs} ms after the first typed letter` : `${Date.now() - t0} ms`})\n` +
        region.split("\n").slice(0, 40).map((l) => "     | " + l).join("\n"));
  }
  say(`SESSION TOTAL: typed ${typed} chars (${fixes} manual fixes), accepted ${inserted} chars from suggestions, ${empty} steps without a suggestion`);
}

const PLACEHOLDER =/\bTODO\b|your code here|\bcondition\b|\bfoo\b|\bbar\b|\bsomething\b|\bsample\b/i;

export async function runEditorCases(
  getErr: () => string | undefined, timeoutMs = 20_000, first = BASIC.length, onLine?: (l: string) => void,
  o: { cases?: Case[]; settleMs?: number } = {},
): Promise<string[]> {
  const out: string[] = [];
  for (const c of (o.cases ?? BASIC).slice(0, first)) {
    const doc = await vscode.workspace.openTextDocument({ language: c.lang, content: c.content });
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const end = doc.positionAt(c.content.length);
    ed.selection = new vscode.Selection(end, end);
    if (c.typed) await vscode.commands.executeCommand("type", { text: c.typed });
    const typedText = doc.getText();
    const t0 = Date.now();
    let accepted = false;
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"); // once: a new trigger would cancel the request in flight
    if (o.settleMs) await sleep(o.settleMs); // let the model's version replace the instant block
    while (Date.now() - t0 < timeoutMs + (o.settleMs ?? 0) && !accepted) {
      await sleep(400);
      await vscode.commands.executeCommand("editor.action.inlineSuggest.commit"); // no ghost text yet = no-op
      accepted = doc.getText() !== typedText;
      if (!accepted && getErr()) break;
    }
    const ms = Date.now() - t0;
    const finalDoc = doc.getText().replace(/\r\n/g, "\n"); // whole document: a suggestion can also replace the typed text
    const inserted = finalDoc.slice(c.content.replace(/\r\n/g, "\n").length);
    const before = new Set(names(c.content)), used = [...new Set(names(inserted))];
    const shared = used.filter((n) => before.has(n));
    const bad = PLACEHOLDER.exec(inserted)?.[0];
    const lines = inserted.split("\n").length;
    out.push(
      accepted
        ? `PASS  ${c.name}  accepted after ${ms} ms  | ${lines} lines | names from your code: ${shared.length}${shared.length ? " (" + shared.slice(0, 6).join(", ") + ")" : ""}${bad ? " | PLACEHOLDER: " + bad : ""}\n` +
          inserted.split("\n").map((l) => "        | " + l).join("\n")
        : `FAIL  ${c.name}  no suggestion within ${ms} ms${getErr() ? "  (" + getErr() + ")" : ""}`,
    );
    onLine?.(out[out.length - 1]); // progress is visible while the run is still going
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  }
  return out;
}
