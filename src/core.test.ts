import assert from "node:assert/strict";
import { trimContext, isSecretFile, wantsMultiline, dedupe, pickDefaultModel, buildRequest, cleanCompletion, classifyError, Lru, PROVIDERS, sseEvents, deltaText } from "./core";

// context window stays small and on line boundaries
const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
const off = big.length >> 1;
const { prefix, suffix } = trimContext(big, off, 400);
assert.ok(prefix.length <= 400 && suffix.length <= 100, "context is bounded");
assert.ok(prefix.startsWith("line"), "prefix starts at a line boundary");
assert.equal(trimContext("abc", 3, 400).prefix, "abc", "short file is sent whole");

// secrets never leave
for (const f of ["/a/.env", "C:\\p\\.env.local", "x/server.pem", "id_rsa", "a/credentials.json", "a/secrets.yml"]) assert.ok(isSecretFile(f), f);
for (const f of ["a/main.rs", "environment.ts", "a/keyboard.ts"]) assert.ok(!isSecretFile(f), f);

// multi-line only when it makes sense
assert.ok(wantsMultiline("") && wantsMultiline("   "), "cursor at end of line -> multi-line");
assert.ok(!wantsMultiline(")") && !wantsMultiline(" + b"), "mid-line -> single line");

// echo removal and default-model pick
assert.equal(dedupe("table>\n  <tr></tr>\n</table>", "table", ""), ">\n  <tr></tr>\n</table>", "repeat of typed text is dropped");
assert.equal(dedupe(" b) {", "function f(a,", ""), " b) {", "no echo, unchanged");
assert.equal(dedupe("\n  <tr></tr>\n</table>", "<table>", "\n</table>"), "\n  <tr></tr>", "closing tag already in the document is dropped");
assert.equal(dedupe("return 1;\n}", "  ", "\n}"), "return 1;", "single-character closing line already in the file");
assert.equal(dedupe("x = 1\nend", "", "\nend"), "x = 1", "`end` already in the file");
assert.equal(dedupe("a\n}", "  ", "\n  more()\n}"), "a\n}", "different next line is kept");
assert.equal(pickDefaultModel(["big-1", "big-1-mini", "big-0"]), "big-1-mini");
assert.equal(pickDefaultModel(["a", "b"]), "a");
assert.equal(pickDefaultModel([]), "");

// every provider shape builds a valid request
const base = { model: "", baseUrl: "", mode: "auto", maxTokens: 64 };
const ds = buildRequest({ ...base, provider: "deepseek" }, "k", "ts", "a.ts", "const a = ", "\n", false);
assert.equal(ds.url, "https://api.deepseek.com/beta/completions");
assert.deepEqual((ds.body as any).stop, ["\n"]);
assert.equal((ds.body as any).suffix, "\n");
assert.equal(ds.headers.authorization, "Bearer k");
assert.equal(buildRequest({ ...base, provider: "mistral" }, "k", "py", "a.py", "x", "", true).url, "https://api.mistral.ai/v1/fim/completions");
const an = buildRequest({ ...base, provider: "anthropic" }, "k", "go", "a.go", "x", "", true);
assert.equal(an.url, "https://api.anthropic.com/v1/messages");
assert.equal(an.headers["x-api-key"], "k");
assert.equal(an.parse({ content: [{ text: "hi" }] }), "hi");
const oa = buildRequest({ ...base, provider: "openai" }, "k", "c", "a.c", "x", "y", true);
assert.ok(oa.url.endsWith("/chat/completions") && JSON.stringify(oa.body).includes("<CURSOR>"));
assert.equal(oa.parse({ choices: [{ message: { content: "z" } }] }), "z");
assert.equal(buildRequest({ ...base, provider: "ollama" }, "", "c", "a.c", "x", "", false).headers.authorization, undefined, "no key, no auth header");
assert.equal(buildRequest({ ...base, provider: "custom", baseUrl: "http://h/v1/" }, "k", "c", "a.c", "x", "", false).url, "http://h/v1/chat/completions");
assert.equal(buildRequest({ ...base, provider: "deepseek", mode: "chat" }, "k", "c", "a.c", "x", "", false).url, "https://api.deepseek.com/beta/chat/completions", "mode override");
assert.equal((buildRequest({ ...base, provider: "openai" }, "k", "c", "a.c", "x", "", false).body as any).max_tokens, 40, "single-line cap");
assert.equal(Object.keys(PROVIDERS).length, 10);
assert.equal(buildRequest({ ...base, provider: "gemini" }, "k", "c", "a.c", "x", "", false).url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
const eff = buildRequest({ ...base, provider: "chatgpt", model: "m", effort: "low" }, "t", "c", "a.c", "x", "", false).body as any;
assert.deepEqual(eff.reasoning, { effort: "low" });
assert.ok(!("reasoning" in (buildRequest({ ...base, provider: "chatgpt", model: "m" }, "t", "c", "a.c", "x", "", false).body as object)), "no reasoning field unless set");

// ChatGPT-plan (Responses) request follows the documented contract
const cg = buildRequest({ ...base, provider: "chatgpt", model: "m1" }, "tok", "ts", "a.ts", "x", "y", false);
assert.equal(cg.url, "https://api.openai.com/v1/responses");
assert.equal(cg.headers.authorization, "Bearer tok");
assert.ok(cg.stream);
const cb = cg.body as Record<string, unknown>;
assert.equal(cb.store, false); assert.equal(cb.stream, true); assert.equal(cb.model, "m1");
assert.ok(typeof cb.instructions === "string" && Array.isArray(cb.input));
for (const f of ["temperature", "max_output_tokens", "max_tokens", "previous_response_id", "metadata", "user"]) assert.ok(!(f in cb), "must omit " + f);
assert.ok(!JSON.stringify(cb.input).includes('"system"'), "no system-role item");

// SSE parsing across chunk boundaries
const s1 = sseEvents('event: a\ndata: {"type":"response.output_text.delta","delta":"he"}\n\ndata: {"type":"resp');
assert.equal(s1.events.length, 1); assert.equal(deltaText(s1.events[0]), "he");
const s2 = sseEvents(s1.rest + 'onse.output_text.delta","delta":"llo"}\n\ndata: [DONE]\n\n');
assert.equal(s2.events.length, 1); assert.equal(deltaText(s2.events[0]), "llo");
assert.equal(deltaText({ type: "response.completed" }), "");

// cleanup + errors + cache
assert.equal(cleanCompletion("```ts\nfoo()\nbar()\n```", true), "foo()\nbar()");
assert.equal(cleanCompletion("foo()\nbar()", false), "foo()");
assert.deepEqual(classifyError(401), { kind: "key", retryMs: 0 });
assert.equal(classifyError(429).kind, "quota");
assert.equal(classifyError(undefined).kind, "offline");
const c = new Lru<number>(2); c.set("a", 1); c.set("b", 2); c.get("a"); c.set("c", 3);
assert.equal(c.get("b"), undefined, "LRU evicts the oldest");
assert.equal(c.get("a"), 1);

console.log("core checks passed");
