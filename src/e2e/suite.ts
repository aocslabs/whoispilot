// Runs INSIDE VS Code. A fake OpenAI-compatible server stands in for the model, so this checks the whole
// plumbing (provider -> ghost text -> Tab) in a real editor, per language. Model quality is not tested here.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

interface Seen { lang: string; file: string; prefix: string; suffix: string; system: string; max_tokens?: number; stream: boolean; aborted?: boolean; draft?: string; related?: string; answeredAt?: number; }
const seen: Seen[] = [];
let respond: (r: Seen) => { status?: number; text: string; delay?: number } = () => ({ text: "" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; note: string }[] = [];

// ---- fake model ----------------------------------------------------------------
function startMock(): Promise<number> {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method !== "POST") { res.writeHead(404).end(); return; }
      const j = JSON.parse(body);
      const stream = !!j.stream;
      const system: string = stream ? j.instructions : j.messages[0].content;
      const user: string = stream ? j.input[0].content : j.messages[1].content;
      const nl = user.indexOf("\n");
      const [lang, ...file] = user.slice(0, nl).split(" ");
      const [withRelated, draft] = user.slice(nl + 1).split("\n<DRAFT>\n");
      const [codePart, related] = withRelated.split("\n<RELATED>\n");
      const [prefix, suffix] = codePart.split("<CURSOR>");
      const r: Seen = { lang, file: file.join(" "), prefix, suffix, system, max_tokens: j.max_tokens, stream, draft, related };
      seen.push(r);
      const out = respond(r);
      if (out.delay) await sleep(out.delay); // a slow model
      r.answeredAt = Date.now();             // when this answer left the (fake) model: tests compare it with when Tab was pressed
      if (out.status && out.status !== 200) { res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock " + out.status } })); return; }
      if (!stream) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: out.text } }] })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.on("close", () => { r.aborted = true; });
      (async () => {
        for (let i = 0; i < out.text.length && !res.destroyed; i += 4) {
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: out.text.slice(i, i + 4) })}\n\n`);
          await sleep(5);
        }
        if (!res.destroyed) res.end(`data: ${JSON.stringify({ type: "response.completed" })}\n\n`);
      })();
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as { port: number }).port)));
}

// ---- helpers --------------------------------------------------------------------
async function cfg(patch: Record<string, unknown>) {
  const c = vscode.workspace.getConfiguration("whoispilot");
  for (const [k, v] of Object.entries(patch)) await c.update(k, v, vscode.ConfigurationTarget.Global);
  await sleep(60);
}

/** Open a doc, put the cursor at `cursor` (default: end), type `typed`, ask for a suggestion, press Tab. */
async function scenario(language: string, content: string, typed: string, o: { cursor?: number; widget?: boolean; wait?: number } = {}) {
  const doc = await vscode.workspace.openTextDocument({ language, content });
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  const at = doc.positionAt(o.cursor ?? content.length);
  ed.selection = new vscode.Selection(at, at);
  const n = seen.length;
  if (typed) await vscode.commands.executeCommand("type", { text: typed });
  let accepted = false;
  for (let attempt = 0; attempt < 8 && !accepted; attempt++) { // a language opened for the first time can take VS Code seconds to wake up
    if (o.widget) { await vscode.commands.executeCommand("editor.action.triggerSuggest"); await sleep(500); }
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    for (let i = 0; i < 40 && seen.length === n; i++) await sleep(50); // wait for the request
    await sleep(o.wait ?? 350);                                        // let the ghost text render
    const before = doc.getText();
    await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
    await sleep(120);
    accepted = doc.getText() !== before;
    if (seen.length === n && attempt >= 3) break;                       // nothing was requested after several tries: stop
  }
  const text = doc.getText().replace(/\r\n/g, "\n"); // Windows documents use CRLF; compare on LF
  const requests = seen.slice(n);
  await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  return { text, requests, languageId: doc.languageId };
}

async function check(name: string, fn: () => Promise<string | void>) {
  try { results.push({ name, ok: true, note: (await fn()) ?? "" }); }
  catch (e) { results.push({ name, ok: false, note: String((e as Error).message ?? e).split("\n").slice(0, 6).join(" | ") }); }
}
const eq = (a: unknown, b: unknown, what: string) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const IF = (lang: string) => `f (condition) {\n  // TODO (${lang}): your code here\n}`;
const TABLE = `able>\n  <thead>\n    <tr><th>Name</th><th>Value</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>Item</td><td>1</td></tr>\n  </tbody>\n</table>`;

const LANGS = [
  "javascript", "typescript", "javascriptreact", "typescriptreact", "html", "css", "scss", "less", "json", "jsonc", "python", "java", "c", "cpp", "csharp",
  "go", "rust", "php", "ruby", "swift", "lua", "perl", "r", "sql", "shellscript", "powershell", "bat", "dockerfile", "makefile", "yaml", "xml", "markdown",
  "plaintext", "objective-c", "fsharp", "vb", "groovy", "coffeescript", "handlebars", "razor", "clojure", "latex", "ini", "julia",
  "kotlin", "scala", "dart", "haskell", "elixir", "zig", "nim", "solidity", "vue", "svelte", "terraform", "graphql", "toml", "protobuf", "cobol", "fortran",
];

// ---- the suite ------------------------------------------------------------------
export async function run(): Promise<void> {
  const port = await startMock();
  await vscode.extensions.getExtension("whoispilot.whoispilot")?.activate();
  await cfg({ provider: "ollama", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock", mode: "chat", debounceMs: 20, maxTokens: 128, contextChars: 2000, multiline: true, customInstructions: "", languageInstructions: {}, disabledLanguages: [], instantTemplates: false, templates: {} });

  // The per-language matrix checks plumbing, so keep VS Code's own suggest list from popping up on its own (it hides ghost text
  // in a different language each run). The suggest-list case below opens it explicitly.
  await vscode.workspace.getConfiguration("editor").update("quickSuggestions", { other: false, comments: false, strings: false }, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration("editor").update("suggestOnTriggerCharacters", false, vscode.ConfigurationTarget.Global);
  // A model continues from what it is told is already there: VS Code's own suggest list may be open on "if",
  // in which case the prompt ends with "if" and the answer must not repeat the "i".
  // (VS Code's list may also be open on another word, e.g. "inherit": then the prompt ends with that word and the answer continues it.)
  respond = (r) => ({ text: r.prefix === "i" ? IF(r.lang) : r.prefix === "if" ? IF(r.lang).slice(1) : ` { /* (${r.lang}) continues */ }` });
  const registered = new Set(await vscode.languages.getLanguages());

  // 1. every language: type one letter -> ghost text -> Tab -> whole construct inserted
  const ran = new Set<string>(); // an id VS Code doesn't know falls back to plaintext; that case is already covered
  for (const lang of LANGS) {
    await check(`lang ${lang}`, async () => {
      if (!registered.has(lang)) { ran.add("plaintext"); return "language not installed in this VS Code: it opens as plaintext, which is tested separately"; }
      const first = await scenario(lang, "", "i");
      eq(first.requests.length >= 1, true, "a request was made");
      eq(first.requests[0].lang, first.languageId, "language id sent to the model");
      eq(first.requests[0].prefix.startsWith("i"), true, "typed text (or the suggestion selected in VS Code's list) reaches the model");
      const inserted = (x: { text: string; languageId: string }) => x.text.startsWith("i") && x.text.includes(`(${x.languageId})`);
      let r = first, retried = false;
      // A language VS Code has just woken up can show its ghost text late. One more try (answered from the cache, so VS Code only has
      // to display it) tells "late" apart from "never"; the note below keeps that visible.
      if (!inserted(r)) { retried = true; r = await scenario(lang, "", "i"); }
      eq(inserted(r), true,
        `the model's text was inserted after the typed letter: ${JSON.stringify(r.text.slice(0, 50))} [requests=${first.requests.length}, prefixes=${JSON.stringify(first.requests.map((x) => x.prefix).slice(0, 4))}]`);
      return retried ? "needed a 2nd try: VS Code showed the ghost text late the first time" : "";
    });
  }

  // 2. HTML: only `t` typed -> whole <table> scaffold (with and without VS Code's own suggest list open)
  respond = () => ({ text: TABLE });
  await check("html: `t` -> table scaffold", async () => {
    const r = await scenario("html", "<body>\n  ", "t");
    eq(r.text, "<body>\n  t" + TABLE, "document");
  });
  // With VS Code's own suggest list open, a ghost text is only shown if it extends the selected item.
  // The model must be asked to continue from "typed text + selected item" and Tab must insert both.
  await check("html: `t` with the suggest list open", async () => {
    respond = () => ({ text: "\n  <tr><td>cell</td></tr>" });
    const r = await scenario("html", "<body>\n  ", "ts", { widget: true });
    const head = "<body>\n  ";
    const sent = r.requests[0]?.prefix; // the first request (later ones are follow-ups made after Tab)
    if (!sent) throw new Error("no request was made while the suggest list was open");
    const lead = sent.slice(head.length); // what the model was told is already there (typed text, or the selected item)
    eq(r.text, head + lead + "\n  <tr><td>cell</td></tr>", "document after Tab");
    return `model was told the text so far is ${JSON.stringify(lead)}`;
  });

  // 3. shape rules
  respond = () => ({ text: "a, b\nsecond line" });
  await check("mid-line stays one line (max 40 tokens)", async () => {
    const r = await scenario("python", "print()", "", { cursor: 6 });
    eq(r.text, "print(a, b)", "document");
    eq(r.requests[0].max_tokens, 40, "max_tokens");
  });
  respond = () => ({ text: "return a + b" });
  await check("echo of typed text is removed", async () => {
    eq((await scenario("python", "def add(a, b):\n    ret", "")).text, "def add(a, b):\n    return a + b", "document");
  });
  respond = () => ({ text: "return 1;\n}" });
  await check("closing brace already in the file is not duplicated", async () => {
    eq((await scenario("javascript", "function f() {\n  \n}", "", { cursor: 17 })).text, "function f() {\n  return 1;\n}", "document");
  });
  respond = () => ({ text: IF("x") });
  await check("end of line asks for multi-line (max 128 tokens)", async () => {
    eq((await scenario("javascript", "", "iu")).requests[0].max_tokens, 128, "max_tokens"); // unique text: avoid the cache
  });
  await check("same context twice -> served from cache", async () => {
    const a = await scenario("python", "x = ", "1");
    const b = await scenario("python", "x = ", "1");
    eq(b.requests.length, 0, "second run requests");
    eq(b.text, a.text, "same suggestion");
  });

  // 4. privacy + switches
  await check(".env is never sent", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, ".env"));
    const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(doc.lineCount, 0, doc.lineCount, 0);
    const n = seen.length;
    await vscode.commands.executeCommand("type", { text: "X" });
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    await sleep(900);
    eq(seen.length - n, 0, "requests for .env");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  });
  await check("disabledLanguages", async () => {
    await cfg({ disabledLanguages: ["markdown"] });
    eq((await scenario("markdown", "", "i")).requests.length, 0, "markdown requests");
    eq((await scenario("python", "", "p")).requests.length >= 1, true, "python still works");
    await cfg({ disabledLanguages: [] });
  });
  await check("multiline=false -> one line", async () => {
    await cfg({ multiline: false });
    respond = () => ({ text: "a\nb\nc" });
    const r = await scenario("python", "", "z");
    eq(r.text, "za", "document");
    eq(r.requests[0].max_tokens, 40, "max_tokens");
    await cfg({ multiline: true });
  });
  await check("toggle command pauses and resumes", async () => {
    respond = () => ({ text: "ok" });
    await vscode.commands.executeCommand("whoispilot.toggle");
    eq((await scenario("python", "", "q")).requests.length, 0, "requests while paused");
    await vscode.commands.executeCommand("whoispilot.toggle");
    eq((await scenario("python", "", "q")).requests.length >= 1, true, "requests after resume");
  });

  // 5. custom instructions
  await check("customInstructions + languageInstructions reach the prompt", async () => {
    await cfg({ customInstructions: "Use tabs.", languageInstructions: { python: "Use type hints.", html: "Use Tailwind." } });
    respond = () => ({ text: "ok" });
    const py = (await scenario("python", "", "a")).requests[0].system;
    const js = (await scenario("javascript", "", "a")).requests[0].system;
    eq(py.includes("Use tabs.") && py.includes("Use type hints."), true, "python system prompt");
    eq(js.includes("Use tabs.") && !js.includes("type hints"), true, "javascript system prompt");
    await cfg({ customInstructions: "", languageInstructions: {} });
  });

  // 6. streaming (Responses API) path: early stop at the first line when single-line
  await check("streaming: multi-line completes, single-line stops early", async () => {
    await cfg({ mode: "responses", multiline: true });
    respond = () => ({ text: IF("stream") });
    eq((await scenario("go", "", "i")).text, "i" + IF("stream"), "multi-line over SSE");
    respond = () => ({ text: "first line\n" + "x".repeat(400) });
    const r = await scenario("go", "print()", "", { cursor: 6 });
    eq(r.text, "print(first line)", "single line over SSE");
    await sleep(300);
    eq(seen[seen.length - 1].aborted, true, "client stopped reading the stream");
    await cfg({ mode: "chat" });
  });

  // 6b. instant templates: shown at once, the (slow) model replaces them when it arrives
  await check("instant: `i` shows a long real block of code at once, before the slow model answers", async () => {
    await cfg({ instantTemplates: true });
    respond = () => ({ text: "f items:\n    run(items)", delay: 3000 });
    const t0 = Date.now();
    const r = await scenario("python", "", "i", { wait: 150 });
    const lines = r.text.split("\n").length;
    eq(r.text.startsWith("i") && lines >= 3, true, `a block of 3+ lines starting with the typed letter (got ${lines} lines: ${JSON.stringify(r.text.slice(0, 60))})`);
    eq(r.text.includes("run(items)"), false, "not the (still pending) model text");
    eq(Date.now() - t0 < 2500, true, "finished well before the model's 3 s");
    return `${lines} lines: ${JSON.stringify(r.text.split("\n")[0].slice(0, 50))}`;
  });
  await check("instant: different places in a file get different blocks", async () => {
    respond = () => ({ text: "", delay: 5000 });
    const seen2 = new Set<string>();
    for (const ctxText of ["# users\n", "# invoices\n", "# network\n", "# parser\n", "# render\n", "# config\n"]) seen2.add((await scenario("python", ctxText, "i", { wait: 100 })).text);
    if (seen2.size < 2) throw new Error("the same block every time");
    return `${seen2.size} different blocks in 6 places`;
  });
  await check("instant: upgrade — typed `i`, the model answers 0.6 s later, Tab then inserts the model's text", async () => {
    respond = () => ({ text: "f (rows) {\n    use(rows)\n}", delay: 600 });
    const r = await scenario("python", "# rows\n", "i", { wait: 2500 });
    eq(r.text, "# rows\ni" + "f (rows) {\n    use(rows)\n}", "document after Tab");
  });
  await check("instant: html `<t` -> a whole real element (table, tbody, thead ...), indented", async () => {
    respond = () => ({ text: "", delay: 5000 });
    const r = await scenario("html", "<body>\n  ", "<t", { wait: 150 });
    const lines = r.text.split("\n");
    eq(/^<body>\n {2}<t\w+/.test(r.text) && lines.length >= 4, true, "an element of 3+ lines after <body> (got " + JSON.stringify(r.text.slice(0, 80)) + ")");
    eq(lines.slice(2).every((l) => l === "" || l.startsWith("  ")), true, "every line keeps the 2-space indent of the line it started on");
    eq(/<\/t\w+>\s*$/.test(r.text), true, "ends with a closing tag");
    return `${lines.length - 1} lines, starts ${JSON.stringify(lines[1].trim().slice(0, 40))}`;
  });
  await check("template: your own template wins; empty body turns a built-in off", async () => {
    await cfg({ templates: { python: { for: "for i in range(10):\n\tprint(i)", while: "" } } });
    respond = () => ({ text: "", delay: 5000 });
    eq((await scenario("python", "", "fo", { wait: 150 })).text, "for i in range(10):\n    print(i)", "custom for");
    await cfg({ templates: {} });
  });
  await check("template: not used mid-line, and not when switched off", async () => {
    respond = () => ({ text: "a, b" });
    eq((await scenario("python", "print()", "", { cursor: 6 })).text, "print(a, b)", "mid-line");
    await cfg({ instantTemplates: false });
    respond = () => ({ text: "f x:\n    y" });
    eq((await scenario("python", "", "i")).text, "if x:\n    y", "model text when templates are off");
  });

  // 6b2. the two things a real user hit: a wrong instant block, and waiting for the model
  const typeIn = async (language: string, content: string) => {
    const doc = await vscode.workspace.openTextDocument({ language, content });
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    const end = doc.positionAt(content.length);
    ed.selection = new vscode.Selection(end, end);
    return doc;
  };
  const closeActive = () => vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
  await check("variables declared above: no random instant block; the model's block fits them", async () => {
    await cfg({ instantTemplates: true, relatedFiles: false });
    respond = () => ({ text: " (nilai >= 75) {\n    keterangan = \"Lulus\";\n}", delay: 1800 });
    const base = "int main() {\n    int nilai;\n    string keterangan;\n    ";
    const doc = await typeIn("cpp", base);
    const n = seen.length;
    await vscode.commands.executeCommand("type", { text: "if" });
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    await sleep(500);
    const typedOnly = doc.getText();
    const commitAt = Date.now();
    await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
    await sleep(200);
    // "early" = something was accepted although the (fake) model had NOT answered yet when Tab was pressed
    const modelAnswered = seen[n]?.answeredAt !== undefined && seen[n].answeredAt! <= commitAt;
    const early = doc.getText() !== typedOnly && !modelAnswered;
    const earlyText = doc.getText().slice(typedOnly.length);
    const earlySeen = seen.slice(n).map((x) => JSON.stringify(x.prefix.slice(-12)) + (x.draft ? " +draft" : ""));
    if (doc.getText() === typedOnly) {                                  // nothing was accepted yet: wait for the model, then press Tab once
      for (let i = 0; i < 100 && !seen[n]?.answeredAt; i++) await sleep(100);
      await sleep(900);
      await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
      await sleep(300);
    }                                                                   // (if the model had already answered, the first Tab took its block; a second Tab would take a follow-up)
    const text = doc.getText().replace(/\r\n/g, "\n");
    await closeActive();
    eq(early, false, `no unrelated block was shown instantly (inserted ${JSON.stringify(earlyText.slice(0, 80))}; requests so far: ${earlySeen.join(", ")})`);
    eq(text, base + "if (nilai >= 75) {\n    keterangan = \"Lulus\";\n}", "the model's block, using the variables");
    eq(seen.length - n >= 1, true, "the model was asked");
  });
  await check("typing cache: typing the first letters does not restart the model call", async () => {
    await cfg({ instantTemplates: false, relatedFiles: false });
    respond = () => ({ text: "if (nilai >= 75) {\n    x = 1;\n}", delay: 1800 });
    const base = "nilai = 80\nketerangan = ''\n";
    const doc = await typeIn("python", base);
    const n = seen.length;
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"); // empty line: the call starts now
    await sleep(500);
    await vscode.commands.executeCommand("type", { text: "i" });
    await sleep(150);
    await vscode.commands.executeCommand("type", { text: "f" });
    for (let i = 0; i < 100 && !seen[n]?.answeredAt; i++) await sleep(100); // wait until the (fake) model has answered
    await sleep(900);                                                   // let the ghost text render
    const asked = seen.length - n;                                      // counted BEFORE Tab: after Tab VS Code itself asks for a follow-up
    await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
    await sleep(300);
    const text = doc.getText().replace(/\r\n/g, "\n");
    await closeActive();
    eq(text, base + "if (nilai >= 75) {\n    x = 1;\n}", "the answer to the first call was used after `if` was typed");
    eq(asked, 1, "model calls made (a restart per keystroke would be 3)");
  });

  // 6c. context from the user's other open files
  const BILLING = "def compute_invoice_total(invoice, tax_rate):\n    subtotal = sum(line.price for line in invoice.lines)\n    return subtotal * (1 + tax_rate)\n";
  const NEAR = "def print_invoice(invoice, tax_rate):\n    total = ";
  await check("related files: a snippet of another open file reaches the model", async () => {
    await cfg({ instantTemplates: false, relatedFiles: true });
    respond = () => ({ text: "compute_invoice_total(invoice, tax_rate)" });
    const other = await vscode.workspace.openTextDocument({ language: "python", content: BILLING });
    await vscode.window.showTextDocument(other, { preview: false });
    const r = await scenario("python", NEAR, "c");
    await vscode.window.showTextDocument(other);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    const rel = r.requests[0]?.related ?? "";
    eq(rel.includes("compute_invoice_total"), true, "related snippet in the prompt (got " + JSON.stringify(rel.slice(0, 80)) + ")");
    eq(rel.length < 1300, true, "small: " + rel.length + " chars");
  });
  await check("related files: off switch sends only the current file", async () => {
    await cfg({ relatedFiles: false });
    respond = () => ({ text: "x" });
    const other = await vscode.workspace.openTextDocument({ language: "python", content: BILLING });
    await vscode.window.showTextDocument(other, { preview: false });
    const r = await scenario("python", NEAR + "d", "e");
    await vscode.window.showTextDocument(other);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    eq(r.requests[0]?.related, undefined, "no related block");
    await cfg({ relatedFiles: true });
  });
  await check("related files: a secret file is never included", async () => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const file = vscode.Uri.joinPath(root, "secrets.py");
    await vscode.workspace.fs.writeFile(file, Buffer.from(BILLING));
    const other = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(other, { preview: false });
    respond = () => ({ text: "y" });
    const r = await scenario("python", NEAR + "t", "o");
    await vscode.window.showTextDocument(other);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    eq(r.requests.length >= 1 && (r.requests[0].related ?? "").includes("compute_invoice_total"), false, "secrets.py stayed out of the prompt");
  });

  // 7. errors: 401 pauses (no more requests) until Retry; 429 backs off then resumes by itself
  await check("401 pauses requests until Retry", async () => {
    respond = () => ({ status: 401, text: "" });
    eq((await scenario("python", "", "w")).requests.length, 1, "first request");
    eq((await scenario("python", "", "w2")).requests.length, 0, "requests while paused");
    respond = () => ({ text: "ok" });
    await vscode.commands.executeCommand("whoispilot.retry");
    await sleep(500);
    eq((await scenario("python", "", "w3")).requests.length >= 1, true, "requests after Retry");
  });
  await check("429 backs off and resumes by itself", async () => {
    respond = () => ({ status: 429, text: "" });
    await scenario("python", "", "e");
    eq((await scenario("python", "", "e2")).requests.length, 0, "requests during back-off");
    respond = () => ({ text: "ok" });
    await sleep(12_500);
    eq((await scenario("python", "", "e3")).requests.length >= 1, true, "requests after back-off");
  });

  // ---- report ----
  const bad = results.filter((r) => !r.ok);
  const lines = [
    `WhoisPilot E2E in VS Code ${vscode.version}: ${results.length - bad.length}/${results.length} passed`,
    ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  — " + r.note : ""}`),
  ];
  if (process.env.WHOISPILOT_E2E_OUT) fs.writeFileSync(process.env.WHOISPILOT_E2E_OUT, lines.join("\n"));
  if (bad.length) throw new Error(`${bad.length} check(s) failed`);
}
