// Server-rendered pages. No inline script (CSP script-src 'self'); /static/app.js wires the buttons.
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{color-scheme:light dark;--fg:#1b1b1f;--muted:#6b6b76;--bg:#fbfaf7;--card:#fff;--line:#e4e2dc;--accent:#8a3b12}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe8;--muted:#9a9aa3;--bg:#141416;--card:#1c1c20;--line:#2c2c31;--accent:#e08a57}}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:760px;margin:0 auto;padding:40px 20px 80px}h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}h1 span{color:var(--accent)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:32px 0 10px}
.sub{color:var(--muted);margin:0 0 24px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:10px 0}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;padding:7px 13px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:default}
input{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg);min-width:0}
table{width:100%;border-collapse:collapse}td{padding:7px 4px;border-top:1px solid var(--line);vertical-align:middle}tr:first-child td{border-top:0}
td.r{text-align:right;white-space:nowrap}.muted{color:var(--muted)}.err{color:#c0392b;min-height:1.4em;margin:8px 0 0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line);padding:1px 5px;border-radius:4px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style><script src="/static/app.js" defer></script></head>
<body><main><h1><span>canon</span>ball</h1><p class="sub">canon keeper for storybuilders</p>${body}</main></body></html>`;
}

export function signInPage(o: { canBootstrap: boolean; hasKeys: boolean; next: string }): string {
  const signin = o.hasKeys ? `<div class="card"><p>Sign in with your passkey or security key.</p>
    <button class="primary" data-action="login" data-next="${esc(o.next)}">Sign in</button><p class="err" id="err-login"></p></div>` : "";
  const setup = o.canBootstrap ? `<h2>${o.hasKeys ? "Enroll another key with a bootstrap passphrase" : "First-time setup"}</h2>
    <div class="card"><p class="muted">Enter the one-time passphrase from the server log or <code>bootstrap.txt</code>, then register a passkey or hardware key.</p>
    <div class="row"><input id="passphrase" placeholder="bootstrap passphrase" autocomplete="off" size="38">
    <input id="keyname" placeholder="key name (optional)" size="18">
    <button class="primary" data-action="bootstrap" data-next="${esc(o.next)}">Register key</button></div><p class="err" id="err-bootstrap"></p></div>` : "";
  const none = !o.hasKeys && !o.canBootstrap ? `<div class="card">No keys are enrolled yet. Setup is only possible from the owner's network.</div>` : "";
  return page("canonball · sign in", signin + setup + none);
}

export function consentPage(o: { pendingId: string; clientName: string; clientHost: string }): string {
  return page("canonball · connect", `<div class="card">
    <p><b>${esc(o.clientName)}</b> <span class="muted">(${esc(o.clientHost)})</span> wants to read and write your canon through MCP.</p>
    <form method="post" action="/oauth/authorize" class="row">
      <input type="hidden" name="pending" value="${esc(o.pendingId)}">
      <button class="primary" name="decision" value="allow">Allow</button>
      <button name="decision" value="deny">Deny</button>
    </form></div>`);
}

export function errorPage(msg: string): string {
  return page("canonball · error", `<div class="card"><p class="err">${esc(msg)}</p><a class="btn" href="/">Home</a></div>`);
}

type Key = { id: string; name: string; transports: string[]; created_at: string; last_used_at: string | null };
type Grant = { id: string; client_name: string; client_id: string; created_at: number; last_used_at: number };
type Proj = { id: string; name: string; counts: Record<string, number> };

const day = (iso: string | number | null) => iso ? new Date(typeof iso === "number" ? iso * 1000 : iso).toISOString().slice(0, 16).replace("T", " ") : "never";

export function homePage(o: { keys: Key[]; grants: Grant[]; projects: Proj[]; lock: Record<string, unknown>; mcpUrl: string }): string {
  const keys = o.keys.map((k) => `<tr><td><b>${esc(k.name)}</b><br><span class="muted">added ${day(k.created_at)} · last used ${day(k.last_used_at)}${k.transports.length ? ` · ${esc(k.transports.join(", "))}` : ""}</span></td>
    <td class="r"><button data-action="rename-key" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Rename</button>
    <button data-action="delete-key" data-id="${esc(k.id)}" ${o.keys.length <= 1 ? "disabled" : ""}>Remove</button></td></tr>`).join("");
  const grants = o.grants.length ? o.grants.map((g) => `<tr><td><b>${esc(g.client_name)}</b><br><span class="muted">connected ${day(g.created_at)} · last used ${day(g.last_used_at)}</span></td>
    <td class="r"><button data-action="delete-grant" data-id="${esc(g.id)}">Disconnect</button></td></tr>`).join("") : `<tr><td class="muted">No MCP clients connected.</td></tr>`;
  const projects = o.projects.length ? o.projects.map((p) => `<tr><td><b>${esc(p.name)}</b><br><span class="muted">${p.counts.faction} factions · ${p.counts.character} characters · ${p.counts.lore} lore · ${p.counts.pit} PITs · ${p.counts.plot} plots</span></td>
    <td class="r"><a class="btn" href="/export/${esc(p.id)}.csv">Export CSV</a></td></tr>`).join("") : `<tr><td class="muted">No projects yet. Create one through MCP.</td></tr>`;
  const lock = o.lock.locked ? `Locked by <b>${esc(o.lock.held_by)}</b> since ${esc(o.lock.since)}, idle timeout in ${esc(o.lock.expires_in_sec)} s.
    <button data-action="release-lock">Force release</button>` : `<span class="muted">Free.</span>`;
  return page("canonball", `
    <h2>Connect</h2><div class="card">Add <code>${esc(o.mcpUrl)}</code> as a custom connector in claude.ai (no client ID or secret needed); approve it here with your key.</div>
    <h2>Projects</h2><div class="card"><table>${projects}</table></div>
    <h2>Lock</h2><div class="card">${lock}</div>
    <h2>Connections</h2><div class="card"><table>${grants}</table></div>
    <h2>Keys</h2><div class="card"><table>${keys}</table>
      <div class="row" style="margin-top:12px"><input id="keyname" placeholder="new key name" size="22"><button data-action="add-key">Add passkey or security key</button></div>
      <p class="err" id="err-keys"></p></div>
    <p><button data-action="logout">Sign out</button></p>`);
}
