// Pure logic, no `vscode` import, so it can be tested with plain node.

export type Mode = "fim" | "chat" | "anthropic" | "responses";
export interface ProviderDef { label: string; baseUrl: string; model: string; mode: Mode; fimPath?: string; needsKey: boolean; oauth?: boolean; }

// ponytail: defaults are best-effort; every one is overridable in settings (baseUrl / model / mode).
export const PROVIDERS: Record<string, ProviderDef> = {
  // Sign in with ChatGPT (OAuth). Model comes from the account's own /models list, so it is empty here.
  chatgpt:    { label: "ChatGPT",    baseUrl: "https://api.openai.com/v1",        model: "",                        mode: "responses", needsKey: false, oauth: true },
  openai:    { label: "OpenAI",     baseUrl: "https://api.openai.com/v1",        model: "gpt-4o-mini",             mode: "chat", needsKey: true },
  deepseek:   { label: "DeepSeek",   baseUrl: "https://api.deepseek.com/beta",    model: "deepseek-chat",           mode: "fim", fimPath: "/completions", needsKey: true },
  anthropic:  { label: "Anthropic",  baseUrl: "https://api.anthropic.com/v1",     model: "claude-haiku-5-5",        mode: "anthropic", needsKey: true },
  mistral:    { label: "Mistral",    baseUrl: "https://api.mistral.ai/v1",        model: "codestral-latest",        mode: "fim", fimPath: "/fim/completions", needsKey: true },
  gemini:     { label: "Gemini",     baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", mode: "chat", needsKey: true },
  groq:       { label: "Groq",       baseUrl: "https://api.groq.com/openai/v1",   model: "llama-3.1-8b-instant",    mode: "chat", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",     model: "deepseek/deepseek-chat",  mode: "chat", needsKey: true },
  ollama:     { label: "Ollama",     baseUrl: "http://localhost:11434/v1",        model: "qwen2.5-coder:1.5b",      mode: "chat", needsKey: false },
  custom:     { label: "Custom",     baseUrl: "",                                 model: "",                        mode: "chat", needsKey: true },
};

export interface Cfg { provider: string; baseUrl: string; model: string; mode: string; maxTokens: number; effort?: string; instructions?: string; }
export interface Req { url: string; headers: Record<string, string>; body: unknown; parse: (json: any) => string; stream?: boolean; }

// --- context -----------------------------------------------------------------

/** Cut the code around the cursor to a small window, on line boundaries. */
export function trimContext(text: string, offset: number, prefixChars: number) {
  let prefix = text.slice(Math.max(0, offset - prefixChars), offset);
  if (offset > prefixChars) prefix = prefix.slice(prefix.indexOf("\n") + 1);
  const suffixChars = Math.floor(prefixChars / 4);
  let suffix = text.slice(offset, offset + suffixChars);
  if (text.length > offset + suffixChars) suffix = suffix.slice(0, Math.max(0, suffix.lastIndexOf("\n")));
  return { prefix, suffix };
}

/** Files that must never leave the machine. */
export const isSecretFile = (path: string) =>
  /(^|[\\/])\.env(\.[^\\/]*)?$|\.(pem|key|p12|pfx|pkcs12)$|id_(rsa|ed25519|ecdsa)|[\\/]\.(npmrc|netrc|pypirc)$|credentials|secrets?\.[a-z]+$/i.test(path);

/** Like Copilot: multi-line whenever the cursor is at the end of its line; mid-line insertions stay one line. */
export const wantsMultiline = (restOfLine: string) => restOfLine.trim() === "";

/** Models often re-type what is already there; remove that echo at both ends. */
export function dedupe(text: string, lineBefore: string, suffix: string): string {
  const typed = lineBefore.trim();
  const lead = text.trimStart();
  if (typed.length >= 2 && lead.startsWith(typed)) text = lead.slice(typed.length);
  const next = suffix.trimStart().split("\n")[0].trimEnd(); // the line that follows the cursor in the file
  const body = text.trimEnd();
  const nl = body.lastIndexOf("\n");
  if (next && nl >= 0 && body.slice(nl + 1).trim() === next) {
    text = body.slice(0, nl); // the model re-wrote the closing line (`}`, `</table>`, `end`) that is already there
  } else if (next.length >= 2 && body.endsWith(next)) {
    text = body.slice(0, body.length - next.length);
    if (/^[ \t]*\n/.test(suffix)) text = text.replace(/\s+$/, ""); // the document already has the line break
  }
  return text;
}

/** Autocomplete wants a fast model: prefer a small/fast looking one, else the first the server lists. */
export const pickDefaultModel = (slugs: string[]) => slugs.find((s) => /(mini|nano|lite|fast|spark|flash|haiku)/i.test(s)) ?? slugs[0] ?? "";

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

// --- request / response ------------------------------------------------------

const SYSTEM =
  "Inline code completion at <CURSOR>. Output only the text to insert: no markdown, never repeat code before <CURSOR>. " +
  "Write what the programmer would write next, using the names, types, imports and helpers that already appear in the code above. " +
  "Finish the current line, then keep going for as many lines as are clearly implied (the whole block, function, element or list, up to about 15 lines). " +
  "Never use placeholders: no TODO, no `condition`, no `your code here`, no empty bodies. Write real, working logic for THIS file. " +
  "If only the start of a construct is typed (a letter, `if`, `for`, `<t`), complete it fully. " +
  "If a <RELATED> block follows the code, it holds snippets from the user's other files: reuse their names, helpers and style where they fit. " +
  "If a <DRAFT> block follows the code, it is real code from another project: keep its shape and length, but rewrite every name, condition, value and body so it fits this file. " +
  "Stop at the end of a logical unit.";

/**
 * `draft` = a real block of code from another project (the instant suggestion). The model is told to keep its shape and
 * length but rewrite every name and value to fit THIS file, which is how the instant block becomes file-specific.
 */
export function buildRequest(cfg: Cfg, key: string, lang: string, file: string, prefix: string, suffix: string, multi: boolean, draft?: string, related?: string): Req {
  const user = `${lang} ${file}\n${prefix}<CURSOR>${suffix}` + (related ? `\n<RELATED>\n${related}` : "") + (draft ? `\n<DRAFT>\n${draft}` : "");
  const p = PROVIDERS[cfg.provider] ?? PROVIDERS.custom;
  const base = (cfg.baseUrl || p.baseUrl).replace(/\/+$/, "");
  const model = cfg.model || p.model;
  const mode: Mode = cfg.mode === "auto" ? p.mode : (cfg.mode as Mode);
  const max_tokens = multi ? cfg.maxTokens : Math.min(cfg.maxTokens, 40);
  // user's own style rules (settings) ride along in the system prompt; FIM providers have no system prompt
  const sys = cfg.instructions ? `${SYSTEM}\nStyle rules: ${cfg.instructions}` : SYSTEM;
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (mode === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    return {
      url: base + "/messages", headers,
      body: { model, max_tokens, temperature: 0, system: sys, messages: [{ role: "user", content: user }] },
      parse: (j) => j?.content?.[0]?.text ?? "",
    };
  }

  if (key) headers.authorization = "Bearer " + key;

  if (mode === "responses") {
    // ChatGPT-plan route: store=false, stream=true, `instructions` (not a system item), and none of
    // temperature / max_output_tokens (rejected). Output length is capped client-side by aborting the stream.
    return {
      url: base + "/responses", headers, stream: true,
      body: {
        model, instructions: sys, input: [{ role: "user", content: user }], store: false, stream: true,
        ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}), // optional: lower effort = faster on reasoning models
      },
      parse: () => "",
    };
  }

  if (mode === "fim") {
    return {
      url: base + (p.fimPath ?? "/completions"), headers,
      body: { model, prompt: prefix, suffix, max_tokens, temperature: 0, stop: multi ? ["\n\n\n"] : ["\n"] },
      parse: (j) => j?.choices?.[0]?.text ?? j?.choices?.[0]?.message?.content ?? "",
    };
  }

  return {
    url: base + "/chat/completions", headers,
    body: { model, max_tokens, temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: user }] },
    parse: (j) => j?.choices?.[0]?.message?.content ?? "",
  };
}

/** Split a server-sent-events buffer into parsed `data:` JSON events; `rest` is the unfinished tail. */
export function sseEvents(buf: string): { events: any[]; rest: string } {
  const blocks = buf.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  const events: any[] = [];
  for (const b of blocks) {
    const data = b.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch { /* ignore a malformed event */ }
  }
  return { events, rest };
}

export const deltaText = (ev: any): string => (ev?.type === "response.output_text.delta" ? String(ev.delta ?? "") : "");

/** Strip markdown fences, keep one line unless multi. */
export function cleanCompletion(raw: string, multi: boolean): string {
  let t = raw.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
  if (!multi) t = t.split("\n")[0];
  return t.replace(/\s+$/, "");
}

/** Map an HTTP status / thrown error to the three error screens. */
export function classifyError(status: number | undefined): { kind: "key" | "quota" | "offline"; retryMs: number } {
  if (status === 401 || status === 403) return { kind: "key", retryMs: 0 };       // stays paused until key is updated / Retry
  if (status === 429 || status === 402) return { kind: "quota", retryMs: 12_000 }; // auto-resumes
  return { kind: "offline", retryMs: 15_000 };
}

/** Tiny LRU. */
export class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max = 50) {}
  get(k: string) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k: string, v: V) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string); }
}
