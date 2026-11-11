// Browser side: bundled to /static/app.js.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

async function post(url: string, body: unknown = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";
function show(id: string, e: unknown) {
  const el = document.getElementById(id);
  const msg = e instanceof Error ? (e.name === "NotAllowedError" ? "cancelled or timed out" : e.message) : String(e);
  if (el) el.textContent = msg; else alert(msg);
}
const go = (next: string) => location.assign(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");

async function register(extra: Record<string, unknown>, errId: string, next: string) {
  try {
    const { options } = await post("/auth/register/options", extra);
    const response = await startRegistration({ optionsJSON: options });
    await post("/auth/register/verify", { response, name: val("keyname") });
    go(next);
  } catch (e) { show(errId, e); }
}

const actions: Record<string, (el: HTMLElement) => Promise<void>> = {
  async login(el) {
    try {
      const { options } = await post("/auth/login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await post("/auth/login/verify", { response });
      go(el.dataset.next || "/");
    } catch (e) { show("err-login", e); }
  },
  bootstrap: (el) => register({ passphrase: val("passphrase") }, "err-bootstrap", el.dataset.next || "/"),
  "add-key": () => register({}, "err-keys", "/"),
  async "rename-key"(el) {
    const name = prompt("Key name", el.dataset.name);
    if (name) { await post(`/api/keys/${el.dataset.id}/rename`, { name }).catch((e) => show("err-keys", e)); location.reload(); }
  },
  async "delete-key"(el) {
    if (!confirm("Remove this key?")) return;
    try { await post(`/api/keys/${el.dataset.id}/delete`); location.reload(); } catch (e) { show("err-keys", e); }
  },
  async "delete-grant"(el) { await post(`/api/grants/${el.dataset.id}/delete`); location.reload(); },
  async "release-lock"() { await post("/api/lock/release"); location.reload(); },
  async logout() { await post("/auth/logout"); location.assign("/"); },
};

document.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el || !actions[el.dataset.action!]) return;
  ev.preventDefault();
  (el as HTMLButtonElement).disabled = true;
  actions[el.dataset.action!](el).finally(() => { (el as HTMLButtonElement).disabled = false; });
});
