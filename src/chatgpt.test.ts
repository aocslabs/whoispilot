import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { authorizeUrl, challengeFor, listen, verifyIdToken, ISSUER, SCOPE, RESOURCE } from "./chatgpt";

async function main() {
  // PKCE: RFC 7636 appendix B test vector
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

  // authorize URL: first registration vs. returning sign-in
  const base = { hostId: "urn:uuid:1", redirectUri: "http://127.0.0.1:1455/auth/callback", state: "s", nonce: "n", challenge: "c" };
  const first = new URL(authorizeUrl(base));
  assert.equal(first.origin + first.pathname, "https://auth.openai.com/api/accounts/authorize");
  const q = first.searchParams;
  assert.equal(q.get("client_id"), "dynamic_agent_client");
  assert.equal(q.get("agent_name_hint"), "WhoisPilot");
  assert.equal(q.get("ext_agent_host_id"), "urn:uuid:1");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("resource"), RESOURCE);
  assert.equal(q.get("scope"), SCOPE);
  for (const s of ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]) assert.ok(SCOPE.split(" ").includes(s), s);
  const back = new URL(authorizeUrl({ ...base, clientId: "oaiapp_x", idTokenHint: "idt", loginHint: "a@b.c" })).searchParams;
  assert.equal(back.get("client_id"), "oaiapp_x");
  assert.equal(back.get("agent_name_hint"), null, "no name hint after registration");
  assert.equal(back.get("id_token_hint"), "idt");
  assert.equal(back.get("login_hint"), "a@b.c");

  // loopback callback: accepts the right state, rejects a wrong one
  const l1 = await listen("good");
  assert.ok((await fetch(`http://127.0.0.1:${l1.port}/auth/callback?code=abc&state=good&client_id=oaiapp_1`)).ok);
  assert.deepEqual(await l1.done, { code: "abc", client_id: "oaiapp_1", scope: undefined });
  const l2 = await listen("good");
  const bad = l2.done.then(() => "resolved", (e) => (e as Error).message);
  await fetch(`http://127.0.0.1:${l2.port}/auth/callback?code=abc&state=evil`);
  assert.equal(await bad, "state mismatch");
  const l3 = await listen("good");
  const denied = l3.done.then(() => "resolved", (e) => (e as { code?: string }).code);
  await fetch(`http://127.0.0.1:${l3.port}/auth/callback?error=access_denied&state=good`);
  assert.equal(await denied, "access_denied");
  const l4 = await listen("x");
  const cancelled = l4.done.then(() => "resolved", (e) => (e as Error).message);
  l4.cancel();
  assert.equal(await cancelled, "cancelled");

  // ID token verification with a locally generated RSA key
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }] };
  const mint = (claims: object, kid = "k1", key = privateKey) => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "RS256", kid })}.${enc(claims)}`;
    return `${head}.${createSign("RSA-SHA256").update(head).sign(key).toString("base64url")}`;
  };
  const ok = { iss: ISSUER, aud: "oaiapp_1", exp: Math.floor(Date.now() / 1000) + 600, nonce: "n1", sub: "user-1", email: "a@b.c" };
  assert.equal((await verifyIdToken(mint(ok), { clientId: "oaiapp_1", nonce: "n1", jwks })).sub, "user-1");
  const rejects = async (tok: string, o: object, why: RegExp) => assert.rejects(verifyIdToken(tok, { clientId: "oaiapp_1", nonce: "n1", jwks, ...o }), why);
  await rejects(mint({ ...ok, iss: "https://evil.example" }), {}, /issuer/);
  await rejects(mint({ ...ok, aud: "other" }), {}, /audience/);
  await rejects(mint({ ...ok, exp: 1 }), {}, /expired/);
  await rejects(mint({ ...ok, nonce: "zzz" }), {}, /nonce/);
  await rejects(mint(ok, "nokey"), {}, /key not found/);
  await rejects(mint(ok, "k1", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey), {}, /signature/);

  console.log("chatgpt checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
