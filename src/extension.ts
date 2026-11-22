import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { runEditorCases, runSession, REAL, Step } from "./selftest";
import { matchUserTemplate, disabledByUser, triggerToken, render, UserTemplates } from "./templates";
import { pickBlock } from "./snippets";
import { relatedSnippets, trimToBlock, dropRepetition } from "./context";
import { PROVIDERS, Cfg, Req, buildRequest, trimContext, isSecretFile, wantsMultiline, cleanCompletion, dedupe, pickDefaultModel, classifyError, estimateTokens, sseEvents, deltaText, Lru } from "./core";
import { Creds, signIn, refresh, listModels } from "./chatgpt";

const KEY = "whoispilot.key";       // API key (all providers except ChatGPT)
const CRED = "whoispilot.chatgpt";  // ChatGPT OAuth credentials (JSON)
const BILLING: Record<string, string> = {
  chatgpt: "https://chatgpt.com/settings/usage",
  openai: "https://platform.openai.com/settings/organization/billing",
  deepseek: "https://platform.deepseek.com/top_up",
  anthropic: "https://console.anthropic.com/settings/billing",
  mistral: "https://console.mistral.ai/billing",
  groq: "https://console.groq.com/settings/billing",
  openrouter: "https://openrouter.ai/credits",
};
type Err = { kind: "key" | "quota" | "offline"; status?: number; msg: string; until: number }; // until 0 = stays until fixed
type Model = { slug: string; name: string };

export function activate(ctx: vscode.ExtensionContext) {
  let enabled = ctx.globalState.get("enabled", true);
  let err: Err | undefined;
  let forceLogin = false;
  let lastMs = 0;
  const modelCache: Record<string, Model[]> = ctx.globalState.get("modelCache", {}); // model lists per provider
  const stats = { requests: 0, accepted: 0, sent: 0, saved: 0 };
  let cache = new Lru<string>();
  let testOverride: { model?: string; effort?: string; instant?: boolean } = {}; // only ever set by the development-mode self-test below
  let effortOff = false; // set when the server rejects the reasoning-effort value
  // The model call for the spot the user is typing at. It keeps running while he types the first letters of what it will say, and its
  // answer is reused ("typing cache") instead of being cancelled and restarted on every keystroke.
  interface Spec { uri: string; lang: string; offset: number; tail: string; afterHead: string; multi: boolean; ac: AbortController; promise: Promise<string>; text?: string; }
  let spec: Spec | undefined;
  const conf = () => vscode.workspace.getConfiguration("whoispilot");
  const getCfg = (): Cfg => {
    const provider = conf().get<string>("provider", "deepseek");
    return {
      provider, baseUrl: conf().get("baseUrl", ""),
      // ChatGPT: no model chosen yet -> a small/fast one from the account's list, not the biggest.
      model: testOverride.model || conf().get("model", "") ||
        (provider === "chatgpt" ? ctx.globalState.get<{ model: string }>("fastModel")?.model ?? pickDefaultModel((modelCache.chatgpt ?? []).map((m) => m.slug)) : ""),
      mode: conf().get("mode", "auto"), maxTokens: conf().get("maxTokens", 320),
      // "none" = no thinking: measured as the fastest or equal on the models tried (the server accepts none, low, medium, high, xhigh)
      effort: testOverride.effort ?? (effortOff ? "" : conf().get("reasoningEffort", "none")),
    };
  };

  /** GET {base}/models. Best effort: the list is a convenience, typing a model name always works. */
  async function fetchModels(cfg: Cfg, key: string): Promise<Model[]> {
    const p = PROVIDERS[cfg.provider] ?? PROVIDERS.custom;
    const headers: Record<string, string> = {};
    let url = (cfg.baseUrl || p.baseUrl).replace(/\/+$/, "").replace(/\/beta$/, "") + "/models"; // DeepSeek lists models outside /beta
    if (p.mode === "anthropic") { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
    else if (cfg.provider === "gemini") { headers["x-goog-api-key"] = key; url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"; }
    else if (key) headers.authorization = "Bearer " + key;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j: any = await res.json();
    const rows: any[] = (j.data ?? j.models ?? []).filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"));
    return rows.map((m) => String(m.id ?? m.name ?? "").replace(/^models\//, "")).filter(Boolean).sort().map((slug) => ({ slug, name: slug }));
  }

  async function refreshModels(provider = getCfg().provider) {
    try {
      const key = await credential(provider);
      const list = provider === "chatgpt" ? await listModels(key) : await fetchModels({ ...getCfg(), provider }, key);
      if (list.length) { modelCache[provider] = list; await ctx.globalState.update("modelCache", modelCache); }
      if (provider === "chatgpt" && list.length) void autoPickModel().then(() => push());
    } catch { /* keep the old list */ }
  }

  /**
   * No model chosen by the user? Time tiny requests per model once and keep the fastest.
   * Redone only when the account's model list changes (or on "Refresh list"). Each model gets up to two samples;
   * the second is skipped for models already clearly slower than the best.
   */
  let picking: Promise<string[]> | undefined; // never two timing runs at once: they would slow each other (and your suggestions)
  function autoPickModel(force = false): Promise<string[]> {
    picking ??= pickFastest(force).finally(() => { picking = undefined; });
    return picking;
  }
  async function pickFastest(force: boolean): Promise<string[]> {
    const log: string[] = [];
    const list = modelCache.chatgpt ?? [];
    const sig = list.map((m) => m.slug).join(",") + "|" + getCfg().effort; // timing depends on the effort used: redo it when that changes
    if (!list.length || (!force && ctx.globalState.get<{ sig: string }>("fastModel")?.sig === sig)) return log;
    const key = await chatgptToken(), cfg = getCfg();
    const once = async (slug: string) => {
      const t0 = Date.now();
      const r = buildRequest({ ...cfg, model: slug }, key, "javascript", "ping.js", "function add(a, b) {\n  return ", "\n}", false);
      await callStream(r, undefined, false, 16);
      return Date.now() - t0;
    };
    let best: { slug: string; ms: number } | undefined;
    for (const m of list.slice(0, 12)) {
      try {
        let ms = await once(m.slug);
        if (!best || ms < best.ms * 1.5) ms = Math.min(ms, await once(m.slug));
        log.push(`  ${m.slug.padEnd(24)} ${ms} ms`);
        if (!best || ms < best.ms) best = { slug: m.slug, ms };
      } catch (e) { log.push(`  ${m.slug.padEnd(24)} error ${(e as { status?: number }).status ?? (e as Error).message.slice(0, 60)}`); }
    }
    if (best) await ctx.globalState.update("fastModel", { sig, model: best.slug, ms: best.ms });
    return log;
  }

  // ---- ChatGPT credentials ------------------------------------------------------
  const loadCreds = async (): Promise<Creds | undefined> => {
    try { const s = await ctx.secrets.get(CRED); return s ? (JSON.parse(s) as Creds) : undefined; } catch { return undefined; }
  };
  const saveCreds = (c: Creds) => Promise.resolve(ctx.secrets.store(CRED, JSON.stringify(c)));
  let refreshing: Promise<Creds> | undefined; // one refresh at a time: the refresh token rotates

  async function chatgptToken(): Promise<string> {
    let c = await loadCreds();
    if (!c) return "";
    if (c.expires_at - 60_000 < Date.now()) {
      const old = c;
      refreshing ??= refresh(old)
        .then(async (n) => { await saveCreds(n); return n; })
        .catch(async (e) => {
          if (e.code === "invalid_grant" || e.status === 400 || e.status === 401) { await ctx.secrets.delete(CRED); e.status = 401; }
          throw e;
        })
        .finally(() => { refreshing = undefined; });
      c = await refreshing;
    }
    return c.access_token;
  }

  const credential = async (provider: string) => (provider === "chatgpt" ? chatgptToken() : (await ctx.secrets.get(KEY)) ?? "");

  // ---- network ---------------------------------------------------------------
  async function call(req: Req, signal?: AbortSignal): Promise<string> {
    const t0 = Date.now();
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    let res: Response;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: sig });
    } catch (e) {
      throw Object.assign(new Error(String(e)), { status: undefined, aborted: signal?.aborted });
    }
    if (!res.ok) throw Object.assign(new Error((await res.text()).slice(0, 200)), { status: res.status });
    lastMs = Date.now() - t0;
    return req.parse(await res.json());
  }

  /** Streaming (Responses API). Output length can't be capped by the API here, so stop reading early. */
  async function callStream(req: Req, signal: AbortSignal | undefined, multi: boolean, maxChars: number): Promise<string> {
    const t0 = Date.now();
    const ac = new AbortController();
    signal?.addEventListener("abort", () => ac.abort());
    const sig = AbortSignal.any([ac.signal, AbortSignal.timeout(25_000)]);
    // A slow answer is just "no suggestion this time", not an outage: it must not pause autocomplete.
    const aborted = () => Object.assign(new Error("aborted"), { aborted: true });
    let res: Response;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: sig });
    } catch (e) {
      throw signal?.aborted || (e as Error).name === "TimeoutError" ? aborted() : Object.assign(new Error(String(e)), { status: undefined });
    }
    if (!res.ok) throw Object.assign(new Error((await res.text()).slice(0, 200)), { status: res.status });
    let text = "", buf = "", done = false;
    const reader = res.body!.getReader(), dec = new TextDecoder();
    try {
      while (!done) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        const parsed = sseEvents(buf);
        buf = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.type === "response.failed") {
            const code = String(ev.response?.error?.code ?? "failed");
            throw Object.assign(new Error(code), { status: /usage_limit|usage_unavailable/.test(code) ? 429 : 500 });
          }
          text += deltaText(ev);
          if (ev.type === "response.completed") done = true;
        }
        if ((!multi && text.includes("\n")) || text.length >= maxChars) done = true;
      }
    } catch (e) {
      if (signal?.aborted || (e as Error).name === "TimeoutError") throw aborted();
      throw e;
    } finally {
      ac.abort(); // stop the stream we no longer need
    }
    lastMs = Date.now() - t0;
    return text;
  }

  function setErr(e: { status?: number; message: string }) {
    const { kind, retryMs } = classifyError(e.status);
    err = { kind, status: e.status, msg: e.message, until: retryMs ? Date.now() + retryMs : 0 };
    if (retryMs) setTimeout(() => { if (err?.until && Date.now() >= err.until) { err = undefined; void push(); } }, retryMs + 50);
    void push();
  }

  async function ping() {
    try {
      let cfg = getCfg();
      const key = await credential(cfg.provider);
      if (cfg.provider === "chatgpt" && !modelCache.chatgpt?.length) {
        await refreshModels("chatgpt");
        cfg = getCfg();
      }
      if (cfg.provider === "chatgpt" && !cfg.model) throw Object.assign(new Error("no models available for this ChatGPT account"), { status: 403 });
      const req = buildRequest(cfg, key, "javascript", "ping.js", "function add(a, b) {\n  return ", "\n}", false);
      if (req.stream) await callStream(req, undefined, false, 16);
      else { (req.body as { max_tokens: number }).max_tokens = 8; await call(req); }
      err = undefined;
      if (cfg.provider !== "chatgpt") void refreshModels(cfg.provider).then(() => push());
    } catch (e) { setErr(e as Error); }
    await push();
  }

  // ---- inline completion -------------------------------------------------------
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(doc, pos, ictx, token) {
      if (!enabled || (err && (err.until === 0 || Date.now() < err.until))) return;
      if (conf().get<string[]>("disabledLanguages", []).includes(doc.languageId) || isSecretFile(doc.fileName)) return;

      const instructions = [conf().get<string>("customInstructions", ""), conf().get<Record<string, string>>("languageInstructions", {})[doc.languageId]].filter(Boolean).join(" ");
      const cfg = { ...getCfg(), instructions };
      const def = PROVIDERS[cfg.provider] ?? PROVIDERS.custom;
      let key = "";
      try { key = await credential(cfg.provider); } catch (e) { setErr(e as Error); return; }
      if ((def.needsKey || def.oauth) && !key) return;
      if (def.oauth && !cfg.model) return;

      // While the suggest widget is open (e.g. typing `table` in HTML) VS Code only shows a completion that
      // extends the selected item. So continue from "typed text + selected item" and replace the same range.
      const sel = ictx.selectedCompletionInfo;
      const from = sel ? sel.range.start : pos, to = sel ? sel.range.end : pos, lead = sel ? sel.text : "";
      const beforeLine = doc.lineAt(from.line).text.slice(0, from.character) + lead;
      const restLine = doc.lineAt(to.line).text.slice(to.character);
      if (/\w/.test(restLine[0] ?? "")) return; // cursor inside a word

      const chars = conf().get("contextChars", 3000);
      const fromOff = doc.offsetAt(from), toOff = doc.offsetAt(to), docLen = doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end);
      const before = doc.getText(new vscode.Range(doc.positionAt(Math.max(0, fromOff - chars - 1)), from)) + lead;
      const after = doc.getText(new vscode.Range(to, doc.positionAt(Math.min(docLen, toOff + Math.floor(chars / 4) + 1))));
      const { prefix, suffix } = trimContext(before + after, before.length, chars);
      if (!prefix.trim() && !suffix.trim()) return;

      const multi = conf().get("multiline", true) && wantsMultiline(restLine);
      const ck = `${cfg.provider}\0${cfg.model}\0${doc.languageId}\0${instructions}\0${multi}\0${prefix}\0${suffix}`; // language matters: same text, different suggestion
      let text = cache.get(ck);

      // Typing cache: a model call already started for this spot, where the user has only typed the first letters of what it will say.
      const typedSince = (s: Spec) => doc.getText(new vscode.Range(doc.positionAt(s.offset), from));
      const sameSpot = (s: Spec) =>
        !sel && s.uri === doc.uri.toString() && s.lang === doc.languageId && s.multi === multi && fromOff >= s.offset && fromOff - s.offset <= 40 &&
        after.slice(0, 200) === s.afterHead &&
        doc.getText(new vscode.Range(doc.positionAt(Math.max(0, s.offset - 200)), doc.positionAt(s.offset))) === s.tail &&
        !typedSince(s).includes("\n");
      let reuse = text === undefined && spec && sameSpot(spec) ? spec : undefined;
      if (reuse?.text !== undefined) {
        const typed = typedSince(reuse);
        if (reuse.text.startsWith(typed) && reuse.text.length > typed.length) text = reuse.text.slice(typed.length);
        else reuse = undefined; // typed something else: that answer no longer applies
      }

      // One model call, used by the normal path and by the background upgrade of a template.
      const ask = async (signal: AbortSignal, draft?: string): Promise<string> => {
        // snippets of the user's other open files that share names with this code (never secret files)
        const related = conf().get("relatedFiles", true)
          ? relatedSnippets(before.slice(-1500), vscode.workspace.textDocuments
              .filter((d) => d !== doc && !d.isClosed && (d.uri.scheme === "file" || d.uri.scheme === "untitled") && !isSecretFile(d.fileName) &&
                d.getText().length < 200_000 && !conf().get<string[]>("disabledLanguages", []).includes(d.languageId))
              .slice(0, 8).map((d) => ({ name: vscode.workspace.asRelativePath(d.fileName), text: d.getText() })))
          : "";
        const req = buildRequest(cfg, key, doc.languageId, vscode.workspace.asRelativePath(doc.fileName), prefix, suffix, multi, draft, related || undefined);
        const maxChars = (multi ? cfg.maxTokens : Math.min(cfg.maxTokens, 40)) * 4;
        const raw = req.stream ? await callStream(req, signal, multi, maxChars) : await call(req, signal);
        // cut at the end of a block if the length limit stopped it, and drop anything that starts to loop
        const out = dedupe(dropRepetition(trimToBlock(cleanCompletion(raw, multi), multi && raw.length >= maxChars * 0.9)), beforeLine, suffix);
        cache.set(ck, out);
        const sent = estimateTokens(prefix + suffix);
        stats.requests++; stats.sent += sent;
        stats.saved += Math.max(0, estimateTokens(" ".repeat(docLen)) - sent); // vs sending the whole file
        void push();
        return out;
      };
      const fail = async (e: unknown) => {
        if ((e as { aborted?: boolean }).aborted) return;
        // this model refuses the reasoning-effort value: stop sending it instead of failing every request
        if (def.oauth && (e as { status?: number }).status === 400 && cfg.effort && /reasoning|effort|unsupported/i.test((e as Error).message)) { effortOff = true; return; }
        if (def.oauth && (e as { status?: number }).status === 401) { const c = await loadCreds(); if (c) await saveCreds({ ...c, expires_at: 0 }); } // force a refresh on Retry
        setErr(e as Error);
      };

      const startSpec = (draft?: string): Spec => {
        spec?.ac.abort();
        const ac = new AbortController();
        const s: Spec = {
          uri: doc.uri.toString(), lang: doc.languageId, offset: fromOff, multi, ac, afterHead: after.slice(0, 200),
          tail: doc.getText(new vscode.Range(doc.positionAt(Math.max(0, fromOff - 200)), from)), promise: Promise.resolve(""),
        };
        // a failed call counts as finished-with-nothing, never as "still running" (that would block every later request)
        s.promise = ask(ac.signal, draft).then((out) => { s.text = out; return out; }, async (e) => { s.text = ""; await fail(e); return ""; });
        spec = s;
        return s;
      };
      // When the model's version is ready and the user is still at the same spot, replace the block that is being shown.
      const swapWhenReady = (s: Spec) => {
        const version = doc.version;
        void s.promise.then((out) => {
          const e = vscode.window.activeTextEditor;
          if (out && spec === s && doc.version === version && e?.document === doc && e.selection.active.isEqual(pos)) {
            // drop the block being shown, then ask again: the provider now finds the model's text
            void vscode.commands.executeCommand("editor.action.inlineSuggest.hide").then(() => vscode.commands.executeCommand("editor.action.inlineSuggest.trigger"));
          }
        });
      };

      // Instant path: type `i`, `for`, `<t`... and a whole starter block shows at once, with no network.
      // The model runs in the background; its version (using the file's real names) then replaces the template.
      if (text === undefined && multi && conf().get("instantTemplates", true) && testOverride.instant !== false) {
        // your own template first; otherwise a real block of open-source code that starts with what you typed
        const user = conf().get<UserTemplates>("templates", {});
        const m = matchUserTemplate(doc.languageId, beforeLine, user) ??
          (disabledByUser(doc.languageId, triggerToken(doc.languageId, beforeLine) ?? "", user)
            ? undefined
            : pickBlock(doc.languageId, beforeLine, before.slice(-1500), after.slice(0, 400))); // most similar to your code, or none
        if (m) {
          const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc);
          const unit = ed && ed.options.insertSpaces === false ? "\t" : " ".repeat(Number(ed?.options.tabSize ?? 4));
          const tpl = render(m, /^\s*/.exec(doc.lineAt(from.line).text)![0], unit);
          // the block rides along as a DRAFT: the model rewrites its names, values and body to fit this file
          const draft = m.body.replace(/^\t+/gm, (t) => unit.repeat(t.length));
          swapWhenReady(reuse ?? startSpec(draft));
          const item = new vscode.InlineCompletionItem(lead + tpl, new vscode.Range(from, to));
          item.command = { command: "whoispilot.accepted", title: "" };
          return [item];
        }
      }

      if (text === undefined) {
        let s = reuse;
        if (!s) {
          await new Promise((r) => setTimeout(r, conf().get("debounceMs", 200)));
          if (token.isCancellationRequested) return;
          s = startSpec();
        }
        // wait for the model; a newer keystroke cancels THIS call only, the model call keeps running and is reused
        const cancelled = new Promise<null>((r) => token.onCancellationRequested(() => r(null)));
        const out = await Promise.race([s.promise, cancelled]);
        if (out === null) return;
        const typed = typedSince(s);
        if (!out.startsWith(typed) || out.length <= typed.length) return;
        text = out.slice(typed.length);
      }
      if (!text) return;
      const item = new vscode.InlineCompletionItem(lead + text, new vscode.Range(from, to));
      item.command = { command: "whoispilot.accepted", title: "" };
      return [item];
    },
  };
  ctx.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider([{ scheme: "file" }, { scheme: "untitled" }], provider));

  // ---- Sign in with ChatGPT ----------------------------------------------------
  async function signInChatGPT() {
    const hostId = ctx.globalState.get<string>("hostId") ?? "urn:uuid:" + randomUUID();
    await ctx.globalState.update("hostId", hostId);
    const saved = await loadCreds();
    try {
      const c = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "WhoisPilot: finish signing in with ChatGPT in your browser", cancellable: true },
        (_p, tok) => {
          const ac = new AbortController();
          tok.onCancellationRequested(() => ac.abort());
          return signIn({ hostId, saved, signal: ac.signal, open: (u) => void vscode.env.openExternal(vscode.Uri.parse(u)) });
        },
      );
      await saveCreds(c);
      await refreshModels("chatgpt");
      const g = vscode.ConfigurationTarget.Global;
      await conf().update("provider", "chatgpt", g);
      await conf().update("baseUrl", "", g);
      await conf().update("model", "", g);
      forceLogin = false; err = undefined; lastMs = 0;
      if (!ctx.globalState.get("welcomed")) {
        await ctx.globalState.update("welcomed", true);
        void vscode.window
          .showInformationMessage("You're using your ChatGPT plan. Autocomplete requests count toward your plan; manage usage in ChatGPT settings.", "Got it", "Manage usage")
          .then((a) => (a === "Manage usage" ? vscode.env.openExternal(vscode.Uri.parse(BILLING.chatgpt)) : undefined));
      }
      await ping();
    } catch (e) {
      const m = (e as Error).message;
      if (m !== "cancelled") void vscode.window.showErrorMessage("WhoisPilot sign-in failed: " + m);
      await push();
    }
  }

  // ---- status bar + commands ---------------------------------------------------
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = "whoispilot.toggle";
  bar.show();
  ctx.subscriptions.push(bar);

  const toggle = async () => { enabled = !enabled; await ctx.globalState.update("enabled", enabled); await push(); };
  ctx.subscriptions.push(
    vscode.commands.registerCommand("whoispilot.toggle", toggle),
    vscode.commands.registerCommand("whoispilot.accepted", () => { stats.accepted++; void push(); }),
    vscode.commands.registerCommand("whoispilot.signInChatGPT", signInChatGPT),
    vscode.commands.registerCommand("whoispilot.retry", () => { err = undefined; return ping(); }),
    vscode.commands.registerCommand("whoispilot.setKey", async () => {
      const k = await vscode.window.showInputBox({ prompt: "API key for WhoisPilot", password: true, ignoreFocusOut: true });
      if (k) { await ctx.secrets.store(KEY, k.trim()); err = undefined; await ping(); }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("whoispilot")) { cache = new Lru<string>(); void push(); } }),
  );

  // ---- sidebar panel -------------------------------------------------------------
  let view: vscode.WebviewView | undefined;

  async function state() {
    const cfg = getCfg(), def = PROVIDERS[cfg.provider] ?? PROVIDERS.custom;
    const creds = def.oauth ? await loadCreds() : undefined;
    const key = def.oauth ? "" : (await ctx.secrets.get(KEY)) ?? "";
    const authed = def.oauth ? !!creds : !def.needsKey || !!key;
    const live = err && (err.until === 0 || Date.now() < err.until) ? err : undefined;
    const total = stats.sent + stats.saved;
    return {
      type: "state",
      view: forceLogin || !authed ? "login" : live ? "error" : "status",
      providers: Object.entries(PROVIDERS).filter(([, p]) => !p.oauth).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model })),
      provider: cfg.provider, label: def.label, plan: !!def.oauth, models: modelCache[cfg.provider] ?? [],
      baseUrl: cfg.baseUrl || def.baseUrl, model: cfg.model,
      keyMask: def.oauth ? creds?.email ?? "ChatGPT account" : key ? "••••" + key.slice(-4) : "",
      modelAuto: def.oauth && !conf().get("model", ""), // true = the fastest-model pick is in use, not a user choice
      modelMs: def.oauth ? ctx.globalState.get<{ ms: number }>("fastModel")?.ms : undefined,
      enabled, lastMs, err: live,
      stats: { ...stats, pct: total ? Math.round((stats.saved / total) * 100) : 0, acceptedPct: stats.requests ? Math.round((stats.accepted / stats.requests) * 100) : 0 },
      settings: { debounceMs: conf().get("debounceMs", 200), maxTokens: conf().get("maxTokens", 320), contextChars: conf().get("contextChars", 3000) },
    };
  }

  async function push() {
    const s = await state();
    bar.text = !enabled ? "$(circle-slash) WhoisPilot" : s.view === "error" ? "$(warning) WhoisPilot" : "$(sparkle) WhoisPilot";
    bar.tooltip = enabled ? "WhoisPilot on. Click to pause." : "WhoisPilot paused. Click to resume.";
    void view?.webview.postMessage(s);
  }

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("whoispilot.panel", {
      resolveWebviewView(v) {
        view = v;
        const media = vscode.Uri.joinPath(ctx.extensionUri, "media");
        v.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const nonce = randomBytes(16).toString("hex");
        v.webview.html = readFileSync(vscode.Uri.joinPath(media, "panel.html").fsPath, "utf8")
          .replaceAll("{{nonce}}", nonce)
          .replaceAll("{{cspSource}}", v.webview.cspSource)
          .replaceAll("{{logo}}", v.webview.asWebviewUri(vscode.Uri.joinPath(media, "logo.png")).toString());
        v.webview.onDidReceiveMessage(async (m) => {
          switch (m.type) {
            case "ready": return push();
            case "toggle": return toggle();
            case "retry": err = undefined; return ping();
            case "changeProvider": forceLogin = true; return push();
            case "chatgpt": return signInChatGPT();
            case "setModel": err = undefined; return void (await conf().update("model", m.model === "__auto__" ? "" : String(m.model ?? ""), vscode.ConfigurationTarget.Global));
            case "refreshModels":
              await refreshModels();
              if (getCfg().provider === "chatgpt") { void autoPickModel(true).then(() => push()); } // re-time the models too
              return push();
            case "signOut":
              await ctx.secrets.delete(PROVIDERS[getCfg().provider]?.oauth ? CRED : KEY);
              forceLogin = false; err = undefined; return push();
            case "billing": return void vscode.env.openExternal(vscode.Uri.parse(BILLING[getCfg().provider] ?? BILLING.openai));
            case "save": {
              const p = PROVIDERS[m.provider]; if (!p || p.oauth) return;
              const g = vscode.ConfigurationTarget.Global;
              await conf().update("provider", m.provider, g);
              await conf().update("baseUrl", m.baseUrl === p.baseUrl ? "" : String(m.baseUrl ?? ""), g);
              await conf().update("model", m.model === p.model ? "" : String(m.model ?? ""), g);
              if (m.key) await ctx.secrets.store(KEY, String(m.key).trim());
              forceLogin = false; err = undefined; lastMs = 0;
              return ping();
            }
          }
        });
        v.onDidDispose(() => { view = undefined; });
      },
    }),
  );
  void push();

  // ---- development-mode self-test (never active in an installed extension) ----------------------------
  // Drop %TEMP%\whoispilot-selftest.request = {"out": "<...>.report.txt", "model"?, "effort"?, "refresh"?, "probe"?}
  // and this window runs real checks with the signed-in account, then writes the report. No secrets are written.
  if (ctx.extensionMode === vscode.ExtensionMode.Development) {
    const wsName = (vscode.workspace.workspaceFolders?.[0]?.name ?? "none").replace(/[^\w.-]/g, "_");
    const flag = path.join(os.tmpdir(), `whoispilot-selftest-${wsName}.request`); // one trigger file per workspace, so two dev windows never race
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || !fs.existsSync(flag)) return;
      busy = true;
      let req: { out?: string; model?: string; effort?: string; refresh?: boolean; probe?: boolean; editor?: boolean; autopick?: boolean; reload?: boolean; bench?: string[]; efforts?: string[]; real?: boolean; instant?: boolean; session?: Step[] } = {};
      try { req = JSON.parse(fs.readFileSync(flag, "utf8")); } catch { /* empty request */ }
      fs.rmSync(flag, { force: true });
      if (req.reload) { await vscode.commands.executeCommand("workbench.action.reloadWindow"); return; } // load freshly compiled code into this same window
      if (req.out?.endsWith(".report.txt")) {
        let report: string;
        try { report = await selfTest(req); } catch (e) { report = "self-test crashed: " + String((e as Error).stack ?? e); }
        fs.writeFileSync(req.out, report);
      }
      busy = false;
    }, 2000);
    ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  async function selfTest(req: { out?: string; model?: string; effort?: string; refresh?: boolean; probe?: boolean; editor?: boolean; autopick?: boolean; bench?: string[]; efforts?: string[]; real?: boolean; instant?: boolean; session?: Step[] }): Promise<string> {
    const L: string[] = [];
    const say = (s: string) => { L.push(s); if (req.out) try { fs.writeFileSync(req.out + ".partial", L.join("\n")); } catch { /* progress file is best effort */ } };
    err = undefined; enabled = true; cache = new Lru<string>();
    testOverride = { model: req.model, effort: req.effort, instant: req.instant };
    try {
      let cfg = getCfg();
      say(`WhoisPilot self-test  ${new Date().toISOString()}  VS Code ${vscode.version}`);
      say(`provider=${cfg.provider}  mode=${cfg.mode}  effort=${JSON.stringify(cfg.effort)}  debounce=${conf().get("debounceMs")}ms  maxTokens=${cfg.maxTokens}`);
      const c = await loadCreds();
      if (cfg.provider === "chatgpt") {
        if (!c) { say("FAIL  not signed in with ChatGPT in this profile"); return L.join("\n"); }
        say(`PASS  signed in as ${c.email ?? c.subject}; access token valid for ${Math.round((c.expires_at - Date.now()) / 1000)} s; scopes: ${c.scopes.join(" ")}`);
        if (req.refresh) {
          try { const n = await refresh(c); await saveCreds(n); say(`PASS  refresh-token exchange works (new token valid ${Math.round((n.expires_at - Date.now()) / 1000)} s)`); }
          catch (e) { say("FAIL  refresh failed: " + (e as Error).message); }
        }
        await refreshModels("chatgpt");
        const list = modelCache.chatgpt ?? [];
        say(list.length ? `PASS  ${list.length} models for this account: ${list.map((m) => m.slug).join(", ")}` : "FAIL  no models returned for this account");
        if (req.autopick) { say("--- auto-pick: fastest model for this account (best of up to 2 samples) ---"); for (const l of await autoPickModel(true)) say(l); }
        cfg = getCfg();
        say(`model used for the editor checks: ${cfg.model || "(none)"}${req.model ? "  (override)" : "  (auto / settings)"}`);
        if (req.probe) {
          say("--- latency probe, one tiny completion per model (first 16 characters) ---");
          const key = await chatgptToken();
          for (const m of list.slice(0, 10)) {
            const t0 = Date.now();
            try {
              const r = buildRequest({ ...cfg, model: m.slug }, key, "javascript", "ping.js", "function add(a, b) {\n  return ", "\n}", false);
              const txt = await callStream(r, undefined, false, 16);
              say(`  ${m.slug.padEnd(28)} ${String(Date.now() - t0).padStart(6)} ms  ${JSON.stringify(txt.slice(0, 24))}`);
            } catch (e) { say(`  ${m.slug.padEnd(28)} ERROR ${(e as { status?: number }).status ?? ""} ${(e as Error).message.slice(0, 120)}`); }
          }
        }
      }
      if (req.bench && cfg.provider === "chatgpt") {
        say("--- bench: realistic prompts, full completion (up to 320 tokens) per model x reasoning effort ---");
        const key = await chatgptToken();
        const prompts: [string, string, string][] = [["python", "names = ['a', 'b']\nfo", ""], ["css", ".btn {\n  b", "\n}"]];
        for (const slug of req.bench) for (const eff of req.efforts ?? ["minimal", "low", ""]) for (const [lang, pre, suf] of prompts) {
          const t0 = Date.now();
          try {
            const r = buildRequest({ ...cfg, model: slug, effort: eff }, key, lang, "a." + lang, pre, suf, true);
            const txt = await callStream(r, undefined, true, 1280);
            say(`  ${slug.padEnd(15)} effort=${(eff || "default").padEnd(8)} ${lang.padEnd(6)} ${String(Date.now() - t0).padStart(6)} ms  ${txt.length} chars  ${JSON.stringify(txt.slice(0, 70))}`);
          } catch (e) { say(`  ${slug.padEnd(15)} effort=${(eff || "default").padEnd(8)} ${lang.padEnd(6)} ${String(Date.now() - t0).padStart(6)} ms  ERROR ${(e as { status?: number }).status ?? ""} ${(e as Error).message.replace(/\s+/g, " ").slice(0, 400)}`); }
        }
      }
      const errNow = (): Err | undefined => err; // (a function, so TypeScript doesn't narrow `err` to "undefined" after the reset above)
      const errText = () => { const e = errNow(); return e ? `${e.kind} ${e.status ?? ""} ${e.msg}`.slice(0, 160) : undefined; };

      // Is anything else (Copilot, Continue, ...) giving inline suggestions here? Negative control: with WhoisPilot OFF
      // every case must come back empty. A suggestion now would not be ours.
      const others = vscode.extensions.all.filter((x) => /copilot|continue|codeium|tabnine|supermaven|cody/i.test(x.id)).map((x) => `${x.id}${x.isActive ? " (ACTIVE)" : " (inactive)"}`);
      say(`other AI extensions visible here: ${others.join(", ") || "none"}`);
      say(`chat.disableAIFeatures = ${vscode.workspace.getConfiguration("chat").get("disableAIFeatures")}`);
      if (req.session) {
        say("--- typing session: the programmer types a few characters, WhoisPilot suggests, Tab accepts ---");
        await runSession(req.session, say);
      } else if (req.real) {
        say("--- REAL CODE, pass 1: the instant block (Tab right away; FAIL = no block resembled this code, so none was shown) ---");
        await runEditorCases(errText, 6_000, 99, say, { cases: REAL });
        say("--- REAL CODE, pass 2: after the model rewrote it for this file (Tab after 9 s) ---");
        await runEditorCases(errText, 20_000, 99, say, { cases: REAL, settleMs: 9_000 });
      } else if (req.editor !== false) {
        say("--- control: WhoisPilot OFF, nothing else may suggest ---");
        enabled = false;
        for (const l of await runEditorCases(errText, 8_000, 3)) say(l.startsWith("FAIL") ? "CONTROL-OK    " + l.replace(/^FAIL\s+/, "") : "CONTROL-LEAK  another inline provider answered: " + l.replace(/^PASS\s+/, ""));
        enabled = true;
        const before = stats.requests;
        say("--- real editor checks (WhoisPilot ON): type, wait for ghost text, press Tab ---");
        await runEditorCases(errText, 20_000, 99, say);
        say(`WhoisPilot made ${stats.requests - before} model requests during the checks above`);
      }
      const e = errNow();
      say(e ? `ended with error state: ${e.kind} ${e.status ?? ""} ${e.msg.slice(0, 160)}` : "ended without error state");
    } finally {
      testOverride = {};
    }
    return L.join("\n");
  }
}

export function deactivate() {}
