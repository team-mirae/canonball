import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as auth from "./auth.js";
import { HOST, MCP_URL, PORT, PUBLIC_URL } from "./config.js";
import "./db.js";
import { exportCsv } from "./export.js";
import { initRepo } from "./git.js";
import * as lock from "./lock.js";
import { buildServer } from "./mcp.js";
import * as store from "./store.js";
import { UserError } from "./store.js";
import * as web from "./web.js";

// ---------- CLI ----------
const cmd = process.argv[2];
if (cmd === "bootstrap" || cmd === "reset-keys") {
  if (cmd === "reset-keys") {
    const { db } = await import("./db.js");
    db.prepare("DELETE FROM credentials").run();
    auth.endAllWebSessions();
    auth.deleteAllGrants();
    console.log("removed every key, web session and MCP connection");
  }
  const b = auth.issueBootstrap();
  console.log(`bootstrap passphrase (one use, until ${b.expires}):\n${b.passphrase}`);
  process.exit(0);
}
if (cmd === "healthcheck") {
  const r = await fetch(`http://127.0.0.1:${PORT}/healthz`).catch(() => null);
  process.exit(r?.ok ? 0 : 1);
}

initRepo();
auth.ensureBootstrap();

const app = express();
app.disable("x-powered-by");
app.set("query parser", "simple");
const SECURE = PUBLIC_URL.startsWith("https://");
const here = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = fs.readFileSync(path.join(here, "static", "app.js"));

/** The app is reachable only through magic-gate's edge, which sets X-Forwarded-For to the client. */
function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}
function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
}
function setCookie(res: Response, name: string, value: string, maxAge: number) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? "; Secure" : ""}`);
}
/** Same-origin browser request: Origin matches, or (when a browser nulls Origin) Sec-Fetch-Site says so. */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (origin === PUBLIC_URL) return true;
  if (origin && origin !== "null") return false;
  const site = req.headers["sec-fetch-site"];
  return site === undefined ? !origin : site === "same-origin";
}
const signedIn = (req: Request) => auth.validWebSession(cookie(req, auth.SESSION_COOKIE));

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin"); // no-referrer makes browsers send Origin: null on form POSTs
  next();
});

app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
app.get("/static/app.js", (_req, res) => { res.type("application/javascript").setHeader("Cache-Control", "no-cache"); res.send(APP_JS); });

// ---------- JSON API for the browser (CSRF: JSON content type + same-origin check + SameSite cookies) ----------
const json = express.json({ limit: "64kb" });
function browserPost(req: Request, res: Response, next: NextFunction) {
  if (!req.is("application/json") || !sameOrigin(req)) { res.status(403).json({ error: "bad request origin" }); return; }
  if (auth.limited(`web:${clientIp(req)}`, 60, 60_000)) { res.status(429).json({ error: "too many requests" }); return; }
  next();
}
function requireSession(req: Request, res: Response, next: NextFunction) {
  if (!signedIn(req)) { res.status(401).json({ error: "sign in first" }); return; }
  next();
}
const CHAL = "cb_chal";

app.post("/auth/register/options", browserPost, json, async (req, res) => {
  let viaBootstrap = false;
  if (!signedIn(req)) {
    const err = auth.checkBootstrap(String(req.body?.passphrase ?? ""), clientIp(req));
    if (err) { res.status(403).json({ error: err }); return; }
    viaBootstrap = true;
  }
  const { options, challengeId } = await auth.registrationOptions(viaBootstrap);
  setCookie(res, CHAL, challengeId, 300);
  res.json({ options });
});
app.post("/auth/register/verify", browserPost, json, async (req, res) => {
  const err = await auth.verifyRegistration(cookie(req, CHAL), req.body?.response, String(req.body?.name ?? ""));
  if (err) { res.status(400).json({ error: err }); return; }
  if (!signedIn(req)) setCookie(res, auth.SESSION_COOKIE, auth.createWebSession(), 7 * 86400);
  res.json({ ok: true });
});
app.post("/auth/login/options", browserPost, json, async (_req, res) => {
  if (auth.credentialCount() === 0) { res.status(400).json({ error: "no keys enrolled yet" }); return; }
  const { options, challengeId } = await auth.authenticationOptions();
  setCookie(res, CHAL, challengeId, 300);
  res.json({ options });
});
app.post("/auth/login/verify", browserPost, json, async (req, res) => {
  if (auth.limited(`login:${clientIp(req)}`, 10, 5 * 60_000)) { res.status(429).json({ error: "too many attempts" }); return; }
  const err = await auth.verifyAuthentication(cookie(req, CHAL), req.body?.response ?? {});
  if (err) { res.status(400).json({ error: err }); return; }
  setCookie(res, auth.SESSION_COOKIE, auth.createWebSession(), 7 * 86400);
  res.json({ ok: true });
});
app.post("/auth/logout", browserPost, (req, res) => {
  auth.endWebSession(cookie(req, auth.SESSION_COOKIE));
  setCookie(res, auth.SESSION_COOKIE, "", 0);
  res.json({ ok: true });
});
app.post("/api/keys/:id/rename", browserPost, requireSession, json, (req, res) => {
  auth.renameCredential(String(req.params.id), String(req.body?.name ?? "")); res.json({ ok: true });
});
app.post("/api/keys/:id/delete", browserPost, requireSession, (req, res) => {
  const err = auth.deleteCredential(String(req.params.id));
  if (err) { res.status(400).json({ error: err }); return; }
  res.json({ ok: true });
});
app.post("/api/grants/:id/delete", browserPost, requireSession, (req, res) => { auth.deleteGrant(String(req.params.id)); res.json({ ok: true }); });
app.post("/api/lock/release", browserPost, requireSession, (_req, res) => { lock.forceRelease(); res.json({ ok: true }); });

// ---------- pages ----------
function signInHtml(req: Request, next: string) {
  const ip = clientIp(req);
  return web.signInPage({ hasKeys: auth.credentialCount() > 0, canBootstrap: auth.bootstrapIpAllowed(ip) && auth.bootstrapActive(), next });
}

app.get("/", (req, res) => {
  if (!signedIn(req)) { res.type("html").send(signInHtml(req, "/")); return; }
  const projects = store.list("project").map((p) => ({
    id: p.id, name: String(p.name), counts: Object.fromEntries(store.CHILD_KINDS.map((k) => [k, store.list(k, p.id).length])),
  }));
  res.type("html").send(web.homePage({
    keys: auth.listCredentials(), grants: auth.listGrants() as never, projects, lock: lock.status(), mcpUrl: MCP_URL.href,
  }));
});

// ---------- OAuth ----------
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => { res.json(auth.protectedResourceMetadata()); });
app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], (_req, res) => { res.json(auth.authorizationServerMetadata()); });

app.get("/oauth/authorize", async (req, res) => {
  let r: auth.AuthRequest;
  try { r = await auth.validateAuthorize(req.query as Record<string, string>); } catch (e) {
    res.status(400).type("html").send(web.errorPage((e as Error).message)); return;
  }
  if (!signedIn(req)) { res.type("html").send(signInHtml(req, req.originalUrl)); return; }
  res.type("html").send(web.consentPage({ pendingId: auth.holdPending(r), clientName: r.clientName, clientHost: r.clientHost }));
});
app.post("/oauth/authorize", express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
  if (!sameOrigin(req)) { res.status(403).type("html").send(web.errorPage("cross-site request refused")); return; }
  if (!signedIn(req)) { res.status(403).type("html").send(web.errorPage("sign in first")); return; }
  const r = auth.takePending(String(req.body?.pending ?? ""));
  if (!r) { res.status(400).type("html").send(web.errorPage("this request expired; start the connection again from the client")); return; }
  res.redirect(303, req.body?.decision === "allow" ? auth.approve(r) : auth.deny(r));
});
app.post("/oauth/token", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  if (auth.limited(`token:${clientIp(req)}`, 60, 60_000)) { res.status(429).json({ error: "slow_down", error_description: "too many requests" }); return; }
  const r = auth.token(req.body ?? {});
  res.setHeader("Cache-Control", "no-store");
  res.status(r.status).json(r.body);
});
app.post("/oauth/revoke", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
  auth.revokeToken(String(req.body?.token ?? "")); res.status(200).end();
});

// ---------- export ----------
app.get("/export/:id.csv", (req, res) => {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!signedIn(req) && !(bearer && auth.authenticateBearer(bearer))) { res.redirect(302, "/"); return; }
  try {
    const { filename, csv } = exportCsv(String(req.params.id));
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("text/csv; charset=utf-8").send(csv);
  } catch (e) {
    res.status(e instanceof UserError ? 404 : 500).type("text").send((e as Error).message);
  }
});

// ---------- MCP ----------
type Session = { transport: StreamableHTTPServerTransport; grantId: string; lastSeen: number };
const sessions = new Map<string, Session>();

function bearerAuth(req: Request, res: Response): { grantId: string; clientName: string } | null {
  const tok = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const g = tok ? auth.authenticateBearer(tok) : null;
  if (!g) {
    res.setHeader("WWW-Authenticate", `${auth.WWW_AUTH}${tok ? ', error="invalid_token"' : ""}`);
    res.status(401).json({ error: "invalid_token", error_description: "sign in through OAuth" });
  }
  return g;
}

app.post("/mcp", express.json({ limit: "4mb" }), async (req, res) => {
  const g = bearerAuth(req, res);
  if (!g) return;
  const sid = req.headers["mcp-session-id"];
  if (typeof sid === "string") {
    const s = sessions.get(sid);
    if (!s || s.grantId !== g.grantId) { res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "session not found" }, id: null }); return; }
    s.lastSeen = Date.now();
    await s.transport.handleRequest(req, res, req.body);
    return;
  }
  let sessionId = "";
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { sessionId = id; sessions.set(id, { transport, grantId: g.grantId, lastSeen: Date.now() }); },
  });
  transport.onclose = () => { if (sessionId) { sessions.delete(sessionId); lock.release(sessionId); } };
  const server = buildServer(() => sessionId, g.clientName);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
const existing = async (req: Request, res: Response) => {
  const g = bearerAuth(req, res);
  if (!g) return;
  const sid = req.headers["mcp-session-id"];
  const s = typeof sid === "string" ? sessions.get(sid) : undefined;
  if (!s || s.grantId !== g.grantId) { res.status(404).json({ error: "session not found" }); return; }
  s.lastSeen = Date.now();
  await s.transport.handleRequest(req, res);
};
app.get("/mcp", existing);
app.delete("/mcp", existing);

setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, s] of sessions) if (s.lastSeen < cutoff) { s.transport.close().catch(() => {}); sessions.delete(id); lock.release(id); }
}, 5 * 60_000).unref();

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: "internal error" });
});

app.listen(PORT, HOST, () => console.log(`canonball listening on ${HOST}:${PORT} (${PUBLIC_URL})`));
