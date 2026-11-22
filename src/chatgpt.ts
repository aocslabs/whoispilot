// "Sign in with ChatGPT" for open-source tools (OAuth 2.0 + PKCE, loopback redirect).
// Contract: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// Pure node (no `vscode` import) so it can be tested with plain node.
import { createHash, createPublicKey, randomBytes, verify as rsaVerify } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export const ISSUER = "https://auth.openai.com";
const AUTHORIZE = ISSUER + "/api/accounts/authorize";
const TOKEN = ISSUER + "/api/accounts/oauth/token";
const JWKS = ISSUER + "/.well-known/jwks.json";
export const RESOURCE = "https://api.openai.com/v1";
export const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const APP_NAME = "WhoisPilot";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";

export interface Creds {
  client_id: string; ext_agent_host_id: string; subject: string; email?: string;
  id_token: string; access_token: string; refresh_token: string; expires_at: number; scopes: string[];
}

const b64u = (b: Buffer) => b.toString("base64url");
export const newVerifier = () => b64u(randomBytes(32));
export const challengeFor = (verifier: string) => b64u(createHash("sha256").update(verifier).digest());

// ---- authorize URL ----------------------------------------------------------
export interface AuthArgs { clientId?: string; hostId: string; redirectUri: string; state: string; nonce: string; challenge: string; idTokenHint?: string; loginHint?: string; }

export function authorizeUrl(a: AuthArgs): string {
  const q: [string, string][] = [
    ["client_id", a.clientId ?? "dynamic_agent_client"],
    ...(a.clientId ? [] : [["agent_name_hint", APP_NAME] as [string, string]]), // first registration only
    ["ext_agent_host_id", a.hostId],
    ...(a.idTokenHint ? [["id_token_hint", a.idTokenHint] as [string, string]] : []),
    ...(a.loginHint ? [["login_hint", a.loginHint] as [string, string]] : []),
    ["response_type", "code"], ["redirect_uri", a.redirectUri], ["scope", SCOPE], ["resource", RESOURCE],
    ["state", a.state], ["nonce", a.nonce], ["code_challenge_method", "S256"], ["code_challenge", a.challenge],
  ];
  return AUTHORIZE + "?" + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

// ---- loopback callback ------------------------------------------------------
export interface Callback { code: string; client_id?: string; scope?: string; }

/** Listen on 127.0.0.1 (port 1455, else any free port) for /auth/callback. */
export function listen(state: string, timeoutMs = 300_000) {
  return new Promise<{ port: number; done: Promise<Callback>; cancel: () => void }>((resolveListen, rejectListen) => {
    let finish!: (c: Callback) => void, fail!: (e: Error) => void;
    const done = new Promise<Callback>((res, rej) => { finish = res; fail = rej; });
    const page = (msg: string) => `<!doctype html><meta charset="utf-8"><title>WhoisPilot</title><body style="font:16px system-ui;background:#1A1220;color:#FBEAE7;display:grid;place-items:center;height:100vh;margin:0"><p>${msg}</p>`;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error"), code = u.searchParams.get("code");
      const ok = u.searchParams.get("state") === state && !err && !!code;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(ok ? "Signed in. You can close this tab and return to VS Code." : "Sign-in was not completed. You can close this tab."));
      if (u.searchParams.get("state") !== state) return fail(new Error("state mismatch"));
      if (err) return fail(Object.assign(new Error(err), { code: err }));
      if (!code) return fail(new Error("callback without code"));
      finish({ code, client_id: u.searchParams.get("client_id") ?? undefined, scope: u.searchParams.get("scope") ?? undefined });
    });
    const timer = setTimeout(() => fail(new Error("sign-in timed out")), timeoutMs);
    done.then(() => { clearTimeout(timer); srv.close(); }, () => { clearTimeout(timer); srv.close(); });
    const bind = (port: number) => {
      srv.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && port ? bind(0) : rejectListen(e)));
      srv.listen(port, "127.0.0.1", () => resolveListen({ port: (srv.address() as AddressInfo).port, done, cancel: () => fail(new Error("cancelled")) }));
    };
    bind(1455);
  });
}

// ---- token endpoint ---------------------------------------------------------
async function tokenPost(body: Record<string, string>) {
  const res = await fetch(TOKEN, { method: "POST", body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error_description ?? j.error ?? `HTTP ${res.status}`), { status: res.status, code: j.error });
  return j;
}

// ---- ID token ---------------------------------------------------------------
let jwksCache: { keys: any[] } | undefined;

/** Verify RS256 signature (OpenAI JWKS), issuer, audience, expiry and nonce. Returns the claims. */
export async function verifyIdToken(idToken: string, o: { clientId: string; nonce?: string; jwks?: { keys: any[] }; now?: number }) {
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new Error("malformed id_token");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  if (header.alg !== "RS256") throw new Error("unexpected id_token alg");
  const jwks = o.jwks ?? (jwksCache ??= (await (await fetch(JWKS, { signal: AbortSignal.timeout(15_000) })).json()) as { keys: any[] });
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("id_token signing key not found");
  const ok = rsaVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("id_token signature invalid");
  const c = JSON.parse(Buffer.from(p, "base64url").toString());
  const aud: string[] = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== ISSUER) throw new Error("id_token issuer mismatch");
  if (!aud.includes(o.clientId)) throw new Error("id_token audience mismatch");
  if (!(c.exp * 1000 > (o.now ?? Date.now()))) throw new Error("id_token expired");
  if (o.nonce !== undefined && c.nonce !== o.nonce) throw new Error("id_token nonce mismatch");
  return c as { sub: string; email?: string };
}

async function toCreds(t: any, clientId: string, hostId: string, nonce: string): Promise<Creds> {
  const scopes = String(t.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(PLAN_SCOPE)) throw Object.assign(new Error("ChatGPT plan use is not enabled for this account"), { code: "plan_disabled" });
  const claims = await verifyIdToken(t.id_token, { clientId, nonce });
  return {
    client_id: clientId, ext_agent_host_id: hostId, subject: claims.sub, email: claims.email,
    id_token: t.id_token, access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: Date.now() + Number(t.expires_in ?? 3600) * 1000, scopes,
  };
}

// ---- public flow ------------------------------------------------------------
export async function signIn(o: { hostId: string; open: (url: string) => void; saved?: Creds; signal?: AbortSignal }): Promise<Creds> {
  const state = b64u(randomBytes(16)), nonce = b64u(randomBytes(16)), verifier = newVerifier();
  const l = await listen(state);
  o.signal?.addEventListener("abort", l.cancel);
  const redirectUri = `http://127.0.0.1:${l.port}/auth/callback`;
  o.open(authorizeUrl({
    clientId: o.saved?.client_id, hostId: o.hostId, redirectUri, state, nonce, challenge: challengeFor(verifier),
    idTokenHint: o.saved?.id_token, loginHint: o.saved?.email,
  }));
  const cb = await l.done;
  const clientId = cb.client_id ?? o.saved?.client_id;
  if (!clientId || clientId === "dynamic_agent_client") throw new Error("registration incomplete (no client_id returned)");
  if (o.saved?.client_id && clientId !== o.saved.client_id) throw new Error("client_id mismatch");
  const t = await tokenPost({ grant_type: "authorization_code", client_id: clientId, code: cb.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
  return toCreds(t, clientId, o.hostId, nonce);
}

/** Rotating refresh token: always keep the replacement. */
export async function refresh(c: Creds): Promise<Creds> {
  const t = await tokenPost({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: c.refresh_token, resource: RESOURCE });
  return {
    ...c, access_token: t.access_token, refresh_token: t.refresh_token ?? c.refresh_token, id_token: t.id_token ?? c.id_token,
    expires_at: Date.now() + Number(t.expires_in ?? 3600) * 1000,
    scopes: t.scope ? String(t.scope).split(/\s+/).filter(Boolean) : c.scopes,
  };
}

/** Models this account may use (visibility "list"), in the server's order. */
export async function listModels(accessToken: string): Promise<{ slug: string; name: string }[]> {
  const res = await fetch(RESOURCE + "/models", { headers: { authorization: "Bearer " + accessToken }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(`models HTTP ${res.status}`), { status: res.status });
  const j: any = await res.json();
  return (j.models ?? []).filter((m: any) => m.visibility === "list").map((m: any) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
}
