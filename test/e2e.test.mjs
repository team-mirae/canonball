// End to end: boots the built server on a temp data dir, runs the OAuth (CIMD + PKCE) flow, then
// exercises every tool family over MCP, the lock, history/rollback, and the CSV export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 18787 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canonball-test-"));

// A client metadata document server (stands in for claude.ai's CIMD URL).
const cimd = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ client_id: CLIENT_ID, client_name: "Test Client", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" }));
});
await new Promise((r) => cimd.listen(0, "127.0.0.1", r));
const CLIENT_ID = `http://127.0.0.1:${cimd.address().port}/client.json`;

const proc = spawn(process.execPath, ["dist/canonball.mjs"], {
  env: { ...process.env, CANONBALL_PORT: String(PORT), CANONBALL_PUBLIC_URL: BASE, CANONBALL_DATA_DIR: dir,
    CANONBALL_OAUTH_CLIENTS: CLIENT_ID, CANONBALL_OAUTH_INSECURE_TEST: "1", CANONBALL_LOCK_TTL_SEC: "2", CANONBALL_BOOTSTRAP_IPS: "203.0.113.9" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
proc.stdout.on("data", (d) => (log += d));
proc.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 50 && !log.includes("listening"); i++) await new Promise((r) => setTimeout(r, 100));

test.after(() => { proc.kill(); cimd.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const parse = (r) => { const t = r.content[0].text; try { return JSON.parse(t); } catch { return t; } };

async function connect(token) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    if (r.isError) { const e = new Error(r.content[0].text); e.toolError = true; throw e; }
    return parse(r);
  };
  return { c, call, raw: (name, args = {}) => c.callTool({ name, arguments: args }) };
}

async function oauthToken() {
  // A signed-in browser session, inserted directly (passkeys can't be scripted here).
  const sess = randomBytes(24).toString("base64url");
  const db = new DatabaseSync(path.join(dir, "canonball.sqlite"));
  db.prepare("INSERT INTO web_sessions(token_hash, expires_at) VALUES (?, ?)").run(createHash("sha256").update(sess).digest("hex"), Math.floor(Date.now() / 1000) + 3600);
  db.close();
  const cookie = `cb_session=${sess}`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: "http://127.0.0.1:5555/callback", response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "canonball", resource: `${BASE}/mcp` });
  const page = await (await fetch(`${BASE}/oauth/authorize?${q}`, { headers: { cookie } })).text();
  assert.match(page, /Test Client/);
  const pending = /name="pending" value="([^"]+)"/.exec(page)[1];
  const r = await fetch(`${BASE}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: "null", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ pending, decision: "allow" }) });
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.searchParams.get("state"), "xyz");
  const tok = await (await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code"), code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: "http://127.0.0.1:5555/callback" }) })).json();
  assert.ok(tok.access_token?.startsWith("cba_"), JSON.stringify(tok));
  return { ...tok, cookie };
}

test("metadata and unauthenticated MCP", async () => {
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /resource_metadata="http:\/\/localhost:\d+\/.well-known\/oauth-protected-resource\/mcp"/);
});

test("bootstrap is scoped to the allowed IP", async () => {
  const pass = fs.readFileSync(path.join(dir, "bootstrap.txt"), "utf8").split("\n")[0];
  const post = (ip) => fetch(`${BASE}/auth/register/options`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify({ passphrase: pass }) });
  assert.equal((await post("198.51.100.1")).status, 403);
  const ok = await post("203.0.113.9");
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).options.challenge);
  const wrong = await fetch(`${BASE}/auth/register/options`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" }, body: JSON.stringify({ passphrase: "nope" }) });
  assert.equal(wrong.status, 403);
});

test("canon round trip, history, rollback, lock, export", async () => {
  const tok = await oauthToken();
  const a = await connect(tok.access_token);

  const p = await a.call("create_project", { name: "Byzantium", description: "The fall of the city." });
  const rome = await a.call("create_faction", { project_id: p.id, name: "Eastern Roman Empire", abbreviations: ["ERE", "Byzantium"] });
  const ott = await a.call("create_faction", { project_id: p.id, name: "Ottoman Empire", abbreviations: ["OE"], predecessor_id: rome.id });
  const c1 = await a.call("create_character", { project_id: p.id, name: "Constantine XI", other_names: ["Dragases"], date_of_birth: "1405-02-08" });
  const c2 = await a.call("create_character", { project_id: p.id, name: "Mehmed II", date_of_birth: "1432-03-30", description: "Sultan, \"the Conqueror\"." });
  await assert.rejects(a.call("create_character", { project_id: p.id, name: "No DOB" }));

  const pit1 = await a.call("create_pit", { project_id: p.id, title: "Siege begins", at: "1453-04-06",
    entries: [{ subject_type: "character", subject_id: c1.id, activity: "Inspects the walls", location: "Theodosian Walls" }] });
  const pit2 = await a.call("create_pit", { project_id: p.id, title: "The fall", at: "1453-05-29", exhaustive: true, description: "Dawn assault." });
  assert.equal(pit2.sort_key, pit1.sort_key + 1);
  await a.call("set_pit_entry", { pit_id: pit2.id, subject_type: "character", subject_id: c2.id, activity: "Enters the city,\nrides to Hagia Sophia", location: "Gate of St. Romanus" });
  await a.call("set_pit_entry", { pit_id: pit2.id, subject_type: "faction", subject_id: ott.id, activity: "Takes the city" });
  await assert.rejects(a.call("set_pit_entry", { pit_id: pit2.id, subject_type: "character", subject_id: rome.id, activity: "wrong type" }));

  const plot = await a.call("create_plot", { project_id: p.id, name: "Last stand", metadata: { pov: "Constantine", status: "draft" } });
  await a.call("add_plot_beat", { plot_id: plot.id, pit_id: pit1.id, note: "hope" });
  await a.call("add_plot_beat", { plot_id: plot.id, pit_id: pit2.id, note: "despair" });

  // lore: standards/definitions/theories, linkable to anything and trackable across PITs
  const fire = await a.call("create_lore", { project_id: p.id, name: "Greek fire", category: "technology", aliases: ["sea fire"], tags: ["weapon"],
    related_ids: [rome.id, c1.id], description: "Incendiary liquid; formula a state secret." });
  const humor = await a.call("create_lore", { project_id: p.id, name: "Humorism", category: "pseudoscience", related_ids: [fire.id] });
  await assert.rejects(a.call("create_lore", { project_id: p.id, name: "No category" }));
  await assert.rejects(a.call("create_lore", { project_id: p.id, name: "Bad link", category: "theory", related_ids: [p.id] }), /related_ids/);
  await a.call("set_pit_entry", { pit_id: pit1.id, subject_type: "lore", subject_id: fire.id, activity: "Stock nearly exhausted" });
  assert.equal((await a.call("list_lore", { project_id: p.id, category: "Pseudoscience" })).length, 1);
  assert.equal((await a.call("timeline", { subject_id: fire.id }))[0].activity, "Stock nearly exhausted");
  await assert.rejects(a.call("delete_lore", { id: fire.id }), /referenced by: .*pit .*lore/);

  const tl = await a.call("timeline", { subject_id: c2.id });
  assert.equal(tl.length, 1);
  assert.equal(tl[0].pit.title, "The fall");

  // history + versions + entity rollback
  const before = (await a.call("get_character", { id: c1.id })).commit_sha;
  await a.call("update_character", { id: c1.id, name: "Constantine XI Palaiologos" });
  const hist = await a.call("history", { id: c1.id });
  assert.deepEqual(hist.map((h) => h.op), ["update", "create"]);
  assert.equal((await a.call("get_version", { id: c1.id, commit: before.slice(0, 10) })).name, "Constantine XI");
  await a.call("rollback_entity", { id: c1.id, commit: before });
  assert.equal((await a.call("get_character", { id: c1.id })).name, "Constantine XI");

  // delete with references needs detach
  await assert.rejects(a.call("delete_character", { id: c2.id }), /referenced/);
  const del = await a.call("delete_character", { id: c2.id, detach: true });
  assert.equal(del.detached.length, 1);
  assert.equal((await a.call("get_pit", { id: pit2.id })).entries.length, 1);
  const afterDelete = del.commit_sha;
  const r2 = await a.call("rollback_entity", { id: c2.id, commit: c2.commit_sha });
  assert.equal(r2.result, "restored");
  assert.equal((await a.call("get_character", { id: c2.id })).name, "Mehmed II");

  // project rollback, including from deleted
  const snapshot = (await a.call("project_history", { project_id: p.id }))[0].commit_sha;
  await a.call("delete_project", { id: p.id });
  assert.equal((await a.call("list_projects")).length, 0);
  const rb = await a.call("rollback_project", { project_id: p.id, commit: snapshot });
  assert.equal(rb.counts.character, 2);
  assert.equal((await a.call("list_characters", { project_id: p.id })).length, 2);
  const rb2 = await a.call("rollback_project", { project_id: p.id, commit: afterDelete });
  assert.equal(rb2.counts.character, 1);
  assert.equal((await a.call("get_pit", { id: pit2.id })).entries.length, 1);

  // export
  const out = await a.call("export_csv", { project_id: p.id });
  assert.match(out, /Eastern Roman Empire/);
  const bytes = Buffer.from(await (await fetch(`${BASE}/export/${p.id}.csv`, { headers: { cookie: tok.cookie } })).arrayBuffer());
  const csv = bytes.toString("utf8"); // keeps the BOM (fetch's text() would strip it)
  const lines = csv.split("\r\n");
  assert.ok(lines[0].startsWith("﻿\"type\",\"id\",\"name\",\"details\",\"1453-04-06 | Siege begins"));
  assert.match(csv, /"plot","[^"]+","Last stand","pov: Constantine\nstatus: draft","beat 1: hope","beat 2: despair"/);
  assert.match(csv, /"faction","[^"]+","Ottoman Empire","abbreviations: OE\npredecessor: Eastern Roman Empire/);
  assert.equal((await fetch(`${BASE}/export/${p.id}.csv`, { redirect: "manual" })).status, 302);
  assert.match(csv, /"lore","[^"]+","Greek fire","category: technology\nalso known as: sea fire\ntags: weapon\nrelated: Eastern Roman Empire \[[^\]]+\]; Constantine XI \[[^\]]+\]\nIncendiary liquid; formula a state secret.","Stock nearly exhausted",""/);
  const det = await a.call("delete_lore", { id: fire.id, detach: true });
  assert.equal(det.detached.length, 2);
  assert.deepEqual((await a.call("get_lore", { id: humor.id })).related_ids, []);
  await a.call("rollback_entity", { id: fire.id, commit: fire.commit_sha });
  assert.equal((await a.call("get_lore", { id: fire.id })).category, "technology");

  // lock: a second agent is told to try again until the first releases or goes idle
  const b = await connect(tok.access_token);
  const blocked = await b.raw("list_projects");
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /^try again/);
  await a.call("release_lock");
  assert.equal((await b.call("list_projects")).length, 1);
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal((await a.call("list_projects")).length, 1);

  // the git repo has one commit per write and markdown files
  const md = fs.readFileSync(path.join(dir, "repo", "projects", p.id, "characters", `${c1.id}.md`), "utf8");
  assert.match(md, /^---\n\{\n  "kind": "character"/);

  // refresh token rotation
  const ref = await (await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: CLIENT_ID }) })).json();
  assert.ok(ref.access_token);
  await a.c.close();
  await b.c.close();
});
