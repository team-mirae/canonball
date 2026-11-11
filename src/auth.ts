// Single-user authentication.
//  - Browser: passkeys / hardware security keys (WebAuthn). The first key is enrolled with a
//    one-time bootstrap passphrase (a random UUID), accepted only from CANONBALL_BOOTSTRAP_IPS.
//  - MCP: OAuth 2.1 authorization server with Client ID Metadata Documents only (public clients,
//    PKCE S256, no registration step), which is what claude.ai's connector speaks. The consent
//    page requires a passkey session.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  ACCESS_TOKEN_TTL_S, BOOTSTRAP_IPS, BOOTSTRAP_TTL_MS, DATA_DIR, MCP_URL, PUBLIC_URL, REFRESH_TOKEN_TTL_S, RP_ID, RP_NAME, WEB_SESSION_TTL_S,
} from "./config.js";
import { db, getSetting, setSetting } from "./db.js";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const secret = (n = 32) => randomBytes(n).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- rate limiting ----------

const hits = new Map<string, number[]>();
export function limited(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  arr.push(t);
  hits.set(key, arr);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((x) => t - x < 3_600_000)) hits.delete(k);
  return arr.length > max;
}

// ---------- bootstrap passphrase ----------

export const BOOTSTRAP_FILE = path.join(DATA_DIR, "bootstrap.txt");

export function credentialCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n;
}

/** Issue a fresh one-time passphrase (replacing any previous one). */
export function issueBootstrap(): { passphrase: string; expires: string } {
  const passphrase = randomUUID();
  const exp = Date.now() + BOOTSTRAP_TTL_MS;
  setSetting("bootstrap", JSON.stringify({ hash: sha256(passphrase), exp }));
  const expires = new Date(exp).toISOString();
  fs.writeFileSync(BOOTSTRAP_FILE, `${passphrase}\nexpires ${expires}\n`, { mode: 0o600 });
  return { passphrase, expires };
}

/** On startup with no keys enrolled, make sure a valid passphrase exists. */
export function ensureBootstrap(): void {
  if (credentialCount() > 0) return;
  const cur = getSetting("bootstrap");
  if (cur && JSON.parse(cur).exp > Date.now()) {
    console.log(`canonball: no keys enrolled; bootstrap passphrase is in ${BOOTSTRAP_FILE}`);
    return;
  }
  const b = issueBootstrap();
  console.log(`canonball: no keys enrolled. Bootstrap passphrase (one use, until ${b.expires}): ${b.passphrase}`);
}

export function bootstrapActive(): boolean {
  const cur = getSetting("bootstrap");
  return !!cur && JSON.parse(cur).exp > Date.now();
}

export function bootstrapIpAllowed(ip: string): boolean {
  return BOOTSTRAP_IPS.length === 0 || BOOTSTRAP_IPS.includes(ip);
}

export function checkBootstrap(passphrase: string, ip: string): string | null {
  if (!bootstrapIpAllowed(ip)) return "bootstrap is not allowed from this address";
  if (limited(`bootstrap:${ip}`, 5, 15 * 60_000)) return "too many attempts; wait 15 minutes";
  const cur = getSetting("bootstrap");
  if (!cur) return "no bootstrap passphrase is active (run `canonball bootstrap` on the server)";
  const { hash, exp } = JSON.parse(cur) as { hash: string; exp: number };
  if (exp < Date.now()) return "the bootstrap passphrase has expired (run `canonball bootstrap` on the server)";
  if (!eq(sha256(passphrase.trim().toLowerCase()), hash)) return "wrong passphrase";
  return null;
}

function consumeBootstrap() {
  setSetting("bootstrap", null);
  fs.rmSync(BOOTSTRAP_FILE, { force: true });
}

// ---------- web sessions ----------

export const SESSION_COOKIE = "cb_session";

export function createWebSession(): string {
  const tok = secret();
  db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(nowS());
  db.prepare("INSERT INTO web_sessions(token_hash, expires_at) VALUES (?, ?)").run(sha256(tok), nowS() + WEB_SESSION_TTL_S);
  return tok;
}
export function validWebSession(tok: string | undefined): boolean {
  if (!tok) return false;
  const r = db.prepare("SELECT expires_at FROM web_sessions WHERE token_hash = ?").get(sha256(tok)) as { expires_at: number } | undefined;
  return !!r && r.expires_at > nowS();
}
export function endWebSession(tok: string | undefined) {
  if (tok) db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha256(tok));
}
export function endAllWebSessions() { db.prepare("DELETE FROM web_sessions").run(); }

// ---------- WebAuthn ----------

type Cred = { id: string; public_key: Uint8Array; counter: number; transports: string; name: string; created_at: string; last_used_at: string | null };
const ORIGIN = PUBLIC_URL;
const USER_ID = new TextEncoder().encode("canonball-owner");

type Challenge = { challenge: string; purpose: "register" | "login"; viaBootstrap: boolean; exp: number };
const challenges = new Map<string, Challenge>();
function putChallenge(c: Omit<Challenge, "exp">): string {
  const id = secret(18);
  const t = Date.now();
  for (const [k, v] of challenges) if (v.exp < t) challenges.delete(k);
  challenges.set(id, { ...c, exp: t + 5 * 60_000 });
  return id;
}
function takeChallenge(id: string | undefined, purpose: Challenge["purpose"]): Challenge | null {
  if (!id) return null;
  const c = challenges.get(id);
  challenges.delete(id);
  return c && c.purpose === purpose && c.exp > Date.now() ? c : null;
}

export function listCredentials() {
  return (db.prepare("SELECT id, name, transports, created_at, last_used_at FROM credentials ORDER BY created_at").all() as Cred[])
    .map((c) => ({ ...c, transports: JSON.parse(c.transports) as string[] }));
}

export async function registrationOptions(viaBootstrap: boolean) {
  const existing = listCredentials();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID, userID: USER_ID, userName: "owner", userDisplayName: "canonball owner",
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as never })),
    // Passkeys and hardware keys both: prefer discoverable, but accept keys that can't store one.
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  return { options, challengeId: putChallenge({ challenge: options.challenge, purpose: "register", viaBootstrap }) };
}

export async function verifyRegistration(challengeId: string | undefined, response: unknown, name: string): Promise<string | null> {
  const c = takeChallenge(challengeId, "register");
  if (!c) return "the registration request expired; try again";
  let v;
  try {
    v = await verifyRegistrationResponse({ response: response as never, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false });
  } catch (e) {
    return `registration failed: ${(e as Error).message}`;
  }
  if (!v.verified) return "registration could not be verified";
  const cred = v.registrationInfo.credential;
  if (c.viaBootstrap) {
    // Re-check: the passphrase must still be active (single use, even with two tabs racing).
    if (!getSetting("bootstrap")) return "the bootstrap passphrase was already used";
    consumeBootstrap();
  }
  const label = (name || "").trim().slice(0, 60) || (v.registrationInfo.credentialDeviceType === "multiDevice" ? "passkey" : "security key");
  db.prepare("INSERT INTO credentials(id, public_key, counter, transports, name, created_at) VALUES (?,?,?,?,?,?)")
    .run(cred.id, Buffer.from(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), label, new Date().toISOString());
  return null;
}

export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID, userVerification: "preferred",
    // Listing the keys lets non-discoverable hardware keys answer too.
    allowCredentials: listCredentials().map((c) => ({ id: c.id, transports: c.transports as never })),
  });
  return { options, challengeId: putChallenge({ challenge: options.challenge, purpose: "login", viaBootstrap: false }) };
}

export async function verifyAuthentication(challengeId: string | undefined, response: { id?: string }): Promise<string | null> {
  const c = takeChallenge(challengeId, "login");
  if (!c) return "the sign-in request expired; try again";
  const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(String(response?.id ?? "")) as Cred | undefined;
  if (!row) return "unknown key";
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: response as never, expectedChallenge: c.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: false,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
    });
  } catch (e) {
    return `sign-in failed: ${(e as Error).message}`;
  }
  if (!v.verified) return "sign-in could not be verified";
  db.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(v.authenticationInfo.newCounter, new Date().toISOString(), row.id);
  return null;
}

export function renameCredential(id: string, name: string) {
  db.prepare("UPDATE credentials SET name = ? WHERE id = ?").run(name.trim().slice(0, 60) || "key", id);
}
export function deleteCredential(id: string): string | null {
  if (credentialCount() <= 1) return "can't remove the last key";
  db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
  return null;
}

// ---------- OAuth (CIMD) ----------

const OAUTH_CLIENTS = (process.env.CANONBALL_OAUTH_CLIENTS ?? "https://claude.ai/oauth/mcp-oauth-client-metadata")
  .split(",").map((s) => s.trim()).filter(Boolean);
/** Test-only: allow http client metadata URLs (never set in production). */
const INSECURE_CLIENTS = process.env.CANONBALL_OAUTH_INSECURE_TEST === "1";
const SCOPE = "canonball";
const RESOURCE = MCP_URL.href;

export function protectedResourceMetadata() {
  return { resource: RESOURCE, authorization_servers: [PUBLIC_URL], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "canonball" };
}
export function authorizationServerMetadata() {
  return {
    issuer: PUBLIC_URL,
    authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${PUBLIC_URL}/oauth/token`,
    revocation_endpoint: `${PUBLIC_URL}/oauth/revoke`,
    scopes_supported: [SCOPE, "offline_access"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

type ClientDoc = { client_id: string; client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string };
const docCache = new Map<string, { doc: ClientDoc; exp: number }>();

async function fetchClientDoc(cid: string): Promise<ClientDoc> {
  const c = docCache.get(cid);
  if (c && c.exp > Date.now()) return c.doc;
  const res = await fetch(cid, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 64 * 1024) throw new Error("document too large");
  let doc: ClientDoc;
  try { doc = JSON.parse(text); } catch { throw new Error("not JSON"); }
  if (doc.client_id !== cid) throw new Error("document client_id doesn't match its URL");
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "none") throw new Error("only public clients are supported");
  docCache.set(cid, { doc, exp: Date.now() + 10 * 60_000 });
  return doc;
}

const isLoopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
function redirectAllowed(got: string, registered: string[]): boolean {
  let g: URL;
  try { g = new URL(got); } catch { return false; }
  if (g.hash) return false;
  return registered.some((r) => {
    if (r === got) return true;
    try {
      const ru = new URL(r);
      // RFC 8252 §7.3: loopback redirects match on any port.
      return g.protocol === "http:" && ru.protocol === "http:" && isLoopback(g.hostname) && g.hostname === ru.hostname && g.pathname === ru.pathname && g.search === ru.search;
    } catch { return false; }
  });
}

export type AuthRequest = { clientId: string; clientHost: string; clientName: string; redirectUri: string; state: string; challenge: string };

export async function validateAuthorize(q: Record<string, string | undefined>): Promise<AuthRequest> {
  const cid = q.client_id ?? "";
  let u: URL;
  try { u = new URL(cid); } catch { throw new Error("client_id must be an https URL of a client metadata document"); }
  if ((u.protocol !== "https:" && !(INSECURE_CLIENTS && u.protocol === "http:")) || u.hash || u.username || u.pathname === "/")
    throw new Error("client_id must be an https URL of a client metadata document");
  if (!OAUTH_CLIENTS.includes(cid)) throw new Error(`client ${u.hostname} is not allowed to connect`);
  let doc: ClientDoc;
  try { doc = await fetchClientDoc(cid); } catch (e) { throw new Error(`could not load the client's metadata: ${(e as Error).message}`); }
  const redirect = q.redirect_uri ?? "";
  if (!redirectAllowed(redirect, doc.redirect_uris ?? [])) throw new Error("redirect_uri is not registered by the client");
  if (q.response_type !== "code") throw new Error("response_type must be code");
  if (q.code_challenge_method !== "S256" || (q.code_challenge ?? "").length < 43) throw new Error("PKCE with S256 is required");
  if (q.resource && q.resource.replace(/\/$/, "") !== RESOURCE) throw new Error(`resource must be ${RESOURCE}`);
  for (const sc of (q.scope ?? "").split(/\s+/).filter(Boolean))
    if (sc !== SCOPE && sc !== "offline_access") throw new Error(`unknown scope ${sc}`);
  const name = (doc.client_name ?? "").trim().slice(0, 80) || u.hostname;
  return { clientId: cid, clientHost: u.hostname, clientName: name, redirectUri: redirect, state: q.state ?? "", challenge: q.code_challenge! };
}

// Pending consent screens and issued codes, both in memory and short-lived.
const pending = new Map<string, AuthRequest & { exp: number }>();
const codes = new Map<string, AuthRequest & { exp: number }>();
const sweep = (m: Map<string, { exp: number }>) => { const t = Date.now(); for (const [k, v] of m) if (v.exp < t) m.delete(k); };

export function holdPending(r: AuthRequest): string {
  sweep(pending);
  const id = secret(18);
  pending.set(id, { ...r, exp: Date.now() + 10 * 60_000 });
  return id;
}
export function takePending(id: string): AuthRequest | null {
  const r = pending.get(id);
  pending.delete(id);
  return r && r.exp > Date.now() ? r : null;
}

function withQuery(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.href;
}
export function approve(r: AuthRequest): string {
  sweep(codes);
  const code = secret();
  codes.set(sha256(code), { ...r, exp: Date.now() + 2 * 60_000 });
  return withQuery(r.redirectUri, { code, state: r.state, iss: PUBLIC_URL });
}
export function deny(r: AuthRequest): string {
  return withQuery(r.redirectUri, { error: "access_denied", state: r.state, iss: PUBLIC_URL });
}

type TokenResult = { status: number; body: Record<string, unknown> };
const tokErr = (status: number, error: string, desc: string): TokenResult => ({ status, body: { error, error_description: desc } });

function issueTokens(): { access: string; refresh: string; body: Record<string, unknown> } {
  const access = `cba_${secret()}`, refresh = `cbr_${secret()}`;
  return { access, refresh, body: { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: SCOPE } };
}

export function token(f: Record<string, string | undefined>): TokenResult {
  if (f.grant_type === "authorization_code") {
    const key = sha256(f.code ?? "");
    const c = codes.get(key);
    codes.delete(key); // single use
    if (!c || c.exp < Date.now()) return tokErr(400, "invalid_grant", "unknown or expired code");
    if (f.client_id !== c.clientId || f.redirect_uri !== c.redirectUri) return tokErr(400, "invalid_grant", "client_id or redirect_uri doesn't match the authorization");
    if (f.resource && f.resource.replace(/\/$/, "") !== RESOURCE) return tokErr(400, "invalid_target", `resource must be ${RESOURCE}`);
    const verifier = createHash("sha256").update(f.code_verifier ?? "").digest("base64url");
    if (!eq(verifier, c.challenge)) return tokErr(400, "invalid_grant", "PKCE verification failed");
    const t = issueTokens();
    const n = nowS();
    db.prepare(`INSERT INTO grants(id, client_id, client_name, access_hash, access_exp, refresh_hash, refresh_exp, created_at, last_used_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(secret(9), c.clientId, c.clientName, sha256(t.access), n + ACCESS_TOKEN_TTL_S, sha256(t.refresh), n + REFRESH_TOKEN_TTL_S, n, n);
    return { status: 200, body: t.body };
  }
  if (f.grant_type === "refresh_token") {
    const h = sha256(f.refresh_token ?? "");
    const n = nowS();
    type G = { id: string; client_id: string; refresh_hash: string; prev_refresh_hash: string | null; rotated_at: number | null; refresh_exp: number };
    const g = db.prepare("SELECT * FROM grants WHERE refresh_hash = ? OR prev_refresh_hash = ?").get(h, h) as G | undefined;
    if (!g) return tokErr(400, "invalid_grant", "invalid refresh token");
    if (f.client_id && f.client_id !== g.client_id) return tokErr(400, "invalid_grant", "refresh token was issued to another client");
    if (g.refresh_exp < n) { db.prepare("DELETE FROM grants WHERE id = ?").run(g.id); return tokErr(400, "invalid_grant", "refresh token expired"); }
    const current = g.refresh_hash === h;
    // A just-rotated token may be retried for 60 s (lost response); later reuse means theft.
    if (!current && n - (g.rotated_at ?? 0) > 60) { db.prepare("DELETE FROM grants WHERE id = ?").run(g.id); return tokErr(400, "invalid_grant", "refresh token reuse detected; sign in again"); }
    const t = issueTokens();
    db.prepare(`UPDATE grants SET prev_refresh_hash = ?, rotated_at = ?, refresh_hash = ?, access_hash = ?, access_exp = ?, refresh_exp = ?, last_used_at = ? WHERE id = ?`)
      .run(current ? g.refresh_hash : g.prev_refresh_hash, current ? n : g.rotated_at, sha256(t.refresh), sha256(t.access), n + ACCESS_TOKEN_TTL_S, n + REFRESH_TOKEN_TTL_S, n, g.id);
    return { status: 200, body: t.body };
  }
  return tokErr(400, "unsupported_grant_type", "authorization_code or refresh_token");
}

export function revokeToken(tok: string) {
  const h = sha256(tok);
  db.prepare("DELETE FROM grants WHERE access_hash = ? OR refresh_hash = ?").run(h, h);
}

/** Resolve a bearer token to its grant. */
export function authenticateBearer(tok: string): { grantId: string; clientName: string } | null {
  if (!tok.startsWith("cba_")) return null;
  const g = db.prepare("SELECT id, client_name, access_exp, last_used_at FROM grants WHERE access_hash = ?").get(sha256(tok)) as
    { id: string; client_name: string; access_exp: number; last_used_at: number } | undefined;
  if (!g || g.access_exp < nowS()) return null;
  if (nowS() - g.last_used_at > 60) db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").run(nowS(), g.id);
  return { grantId: g.id, clientName: g.client_name };
}

export function listGrants() {
  return db.prepare("SELECT id, client_id, client_name, created_at, last_used_at, refresh_exp FROM grants ORDER BY created_at DESC").all();
}
export function deleteGrant(id: string) { db.prepare("DELETE FROM grants WHERE id = ?").run(id); }
export function deleteAllGrants() { db.prepare("DELETE FROM grants").run(); }
export const WWW_AUTH = `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`;
