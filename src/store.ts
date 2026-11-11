// Domain store. SQLite holds the queryable state; every entity is also a markdown file in a git
// repo, and each row records the exact commit that last wrote it. One write = one commit, so any
// entity or whole project can be read at, or rolled back to, any earlier commit.
import { randomUUID } from "node:crypto";
import { db, tx } from "./db.js";
import * as git from "./git.js";

export type Kind = "project" | "faction" | "character" | "pit" | "plot";
export const CHILD_KINDS = ["faction", "character", "pit", "plot"] as const;
export type ChildKind = (typeof CHILD_KINDS)[number];

export type PitEntry = {
  subject_type: "character" | "faction";
  subject_id: string;
  activity: string;
  location?: string;
};
export type PlotBeat = { pit_id: string; note?: string };

export type Entity = { kind: Kind; id: string; project_id: string; [k: string]: unknown };

export class UserError extends Error {}

const TABLE: Record<Kind, string> = {
  project: "projects", faction: "factions", character: "characters", pit: "pits", plot: "plots",
};
/** Data fields (beyond id/project_id/timestamps/commit) stored per kind, in file order. */
const FIELDS: Record<Kind, string[]> = {
  project: ["name", "description"],
  faction: ["name", "abbreviations", "predecessor_id", "successor_id", "description"],
  character: ["name", "other_names", "date_of_birth", "description"],
  pit: ["title", "at", "sort_key", "exhaustive", "entries", "description"],
  plot: ["name", "metadata", "beats", "description"],
};
const JSON_FIELDS = new Set(["abbreviations", "other_names", "entries", "metadata", "beats"]);
const DEFAULTS: Record<string, unknown> = {
  description: "", abbreviations: [], other_names: [], entries: [], metadata: {}, beats: [],
  predecessor_id: null, successor_id: null, exhaustive: false,
};

const now = () => new Date().toISOString();
const label = (e: Entity) => String(e.name ?? e.title ?? e.id);

// ---------- files ----------

export function filePath(kind: Kind, projectId: string, id: string): string {
  return kind === "project" ? `projects/${projectId}/project.md` : `projects/${projectId}/${TABLE[kind]}/${id}.md`;
}

/** Markdown with a JSON frontmatter block (JSON is valid YAML); the body is the description. */
export function toMarkdown(e: Entity): string {
  const front: Record<string, unknown> = { kind: e.kind, id: e.id };
  if (e.kind !== "project") front.project_id = e.project_id;
  for (const f of FIELDS[e.kind]) if (f !== "description") front[f] = e[f];
  front.created_at = e.created_at;
  front.updated_at = e.updated_at;
  const title = label(e);
  return `---\n${JSON.stringify(front, null, 2)}\n---\n\n${String(e.description ?? "")}${String(e.description ?? "").endsWith("\n") ? "" : "\n"}<!-- ${e.kind}: ${title.replace(/--/g, "- -")} -->\n`;
}

export function fromMarkdown(md: string): Entity {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(md);
  if (!m) throw new Error("not a canonball markdown file");
  const front = JSON.parse(m[1]);
  const body = m[2].replace(/\n?<!-- [^\n]* -->\n$/, "");
  const e: Entity = { ...front, description: body };
  if (e.kind === "project") e.project_id = e.id;
  return e;
}

// ---------- rows ----------

function rowToEntity(kind: Kind, row: Record<string, unknown>): Entity {
  const e: Entity = { kind, id: String(row.id), project_id: String(kind === "project" ? row.id : row.project_id) };
  for (const f of FIELDS[kind]) {
    const v = row[f];
    e[f] = JSON_FIELDS.has(f) ? JSON.parse(String(v)) : f === "exhaustive" ? Boolean(v) : v;
  }
  e.created_at = row.created_at;
  e.updated_at = row.updated_at;
  e.commit_sha = row.commit_sha;
  return e;
}

function writeRow(e: Entity) {
  const cols = ["id", ...(e.kind === "project" ? [] : ["project_id"]), ...FIELDS[e.kind], "created_at", "updated_at", "commit_sha"];
  const vals = cols.map((c) => {
    const v = e[c];
    if (JSON_FIELDS.has(c)) return JSON.stringify(v ?? DEFAULTS[c]);
    if (c === "exhaustive") return v ? 1 : 0;
    return (v ?? DEFAULTS[c] ?? null) as string | number | null;
  });
  const sql = `INSERT INTO ${TABLE[e.kind]} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
    ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ")}`;
  db.prepare(sql).run(...vals);
}

function setSha(kind: Kind, id: string, sha: string) {
  db.prepare(`UPDATE ${TABLE[kind]} SET commit_sha = ? WHERE id = ?`).run(sha, id);
}

function addRevision(e: { kind: Kind; id: string; project_id: string }, op: string, sha: string, message: string) {
  db.prepare("INSERT INTO revisions(project_id, kind, entity_id, op, commit_sha, message, at) VALUES (?,?,?,?,?,?,?)")
    .run(e.project_id, e.kind, e.id, op, sha, message, now());
}

/** Run DB changes and a git commit atomically: if either fails, neither sticks. */
function persist(paths: string[], message: string, dbWork: () => void, fileWork: () => void, after: (sha: string) => void): string {
  const before = git.head();
  return tx(() => {
    dbWork();
    try {
      fileWork();
      const sha = git.commit(paths, message);
      after(sha);
      return sha;
    } catch (err) {
      git.resetHard(before);
      throw err;
    }
  });
}

// ---------- reads ----------

export function get(kind: Kind, id: string): Entity | null {
  const row = db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToEntity(kind, row) : null;
}

export function mustGet(kind: Kind, id: string): Entity {
  const e = get(kind, id);
  if (!e) throw new UserError(`${kind} ${id} not found`);
  return e;
}

/** Find an entity of any kind by id. */
export function find(id: string): Entity | null {
  for (const k of ["project", ...CHILD_KINDS] as Kind[]) {
    const e = get(k, id);
    if (e) return e;
  }
  return null;
}

export function list(kind: Kind, projectId?: string, query?: string): Entity[] {
  const order = kind === "pit" ? "sort_key, at" : kind === "project" ? "name" : "name COLLATE NOCASE";
  const where: string[] = [];
  const args: string[] = [];
  if (kind !== "project") { where.push("project_id = ?"); args.push(projectId!); }
  const rows = db.prepare(`SELECT * FROM ${TABLE[kind]} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order}`)
    .all(...args) as Record<string, unknown>[];
  let out = rows.map((r) => rowToEntity(kind, r));
  if (query) {
    const q = query.toLowerCase();
    out = out.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
  }
  return out;
}

// ---------- validation ----------

function check(e: Entity) {
  const need = (cond: unknown, msg: string) => { if (!cond) throw new UserError(msg); };
  const inProject = (kind: Kind, id: string, what: string) => {
    const t = get(kind, id);
    need(t && t.project_id === e.project_id, `${what}: ${kind} ${id} not found in this project`);
  };
  if (e.kind === "project" || e.kind === "faction" || e.kind === "character" || e.kind === "plot")
    need(typeof e.name === "string" && e.name.trim(), "name is required");
  if (e.kind === "faction") {
    if (e.predecessor_id) { need(e.predecessor_id !== e.id, "a faction can't precede itself"); inProject("faction", String(e.predecessor_id), "predecessor_id"); }
    if (e.successor_id) { need(e.successor_id !== e.id, "a faction can't succeed itself"); inProject("faction", String(e.successor_id), "successor_id"); }
  }
  if (e.kind === "character") need(typeof e.date_of_birth === "string" && e.date_of_birth.trim(), "date_of_birth is required (free text; in-world calendars are fine)");
  if (e.kind === "pit") {
    need(typeof e.title === "string" && e.title.trim(), "title is required");
    need(typeof e.at === "string" && e.at.trim(), "at (the in-world time) is required");
    const seen = new Set<string>();
    for (const en of e.entries as PitEntry[]) {
      inProject(en.subject_type, en.subject_id, "entries");
      const k = `${en.subject_type}:${en.subject_id}`;
      need(!seen.has(k), `duplicate entry for ${k}: one entry per subject per PIT`);
      seen.add(k);
    }
  }
  if (e.kind === "plot") for (const b of e.beats as PlotBeat[]) inProject("pit", b.pit_id, "beats");
}

function nextSortKey(projectId: string): number {
  const r = db.prepare("SELECT MAX(sort_key) AS m FROM pits WHERE project_id = ?").get(projectId) as { m: number | null };
  return (r.m ?? 0) + 1;
}

// ---------- writes ----------

export function create(kind: Kind, projectId: string | null, data: Record<string, unknown>): Entity {
  const id = randomUUID();
  const t = now();
  const pid = kind === "project" ? id : projectId!;
  if (kind !== "project") mustGet("project", pid);
  const e: Entity = { kind, id, project_id: pid, created_at: t, updated_at: t };
  for (const f of FIELDS[kind]) e[f] = data[f] ?? structuredClone(DEFAULTS[f] ?? null);
  if (kind === "pit" && (e.sort_key === null || e.sort_key === undefined)) e.sort_key = nextSortKey(pid);
  check(e);
  const rel = filePath(kind, pid, id);
  const msg = `create ${kind} ${label(e)} (${id})`;
  e.commit_sha = persist([rel], msg, () => writeRow(e), () => git.writeFile(rel, toMarkdown(e)), (sha) => {
    setSha(kind, id, sha);
    addRevision(e, "create", sha, msg);
  });
  return e;
}

export function update(kind: Kind, id: string, patch: Record<string, unknown>): Entity {
  const cur = mustGet(kind, id);
  const e: Entity = { ...cur, updated_at: now() };
  for (const f of FIELDS[kind]) if (patch[f] !== undefined) e[f] = patch[f];
  check(e);
  const rel = filePath(kind, e.project_id, id);
  const msg = `update ${kind} ${label(e)} (${id})`;
  e.commit_sha = persist([rel], msg, () => writeRow(e), () => git.writeFile(rel, toMarkdown(e)), (sha) => {
    setSha(kind, id, sha);
    addRevision(e, "update", sha, msg);
  });
  return e;
}

/** Ids of other entities in the project that reference this one. */
export function referencesTo(e: Entity): string[] {
  const refs: string[] = [];
  if (e.kind === "faction") for (const f of list("faction", e.project_id))
    if (f.predecessor_id === e.id || f.successor_id === e.id) refs.push(`faction ${f.id} (${f.name})`);
  if (e.kind === "faction" || e.kind === "character") for (const p of list("pit", e.project_id))
    if ((p.entries as PitEntry[]).some((x) => x.subject_id === e.id)) refs.push(`pit ${p.id} (${p.title})`);
  if (e.kind === "pit") for (const p of list("plot", e.project_id))
    if ((p.beats as PlotBeat[]).some((b) => b.pit_id === e.id)) refs.push(`plot ${p.id} (${p.name})`);
  return refs;
}

export function remove(kind: Kind, id: string, opts: { detach?: boolean } = {}): { commit_sha: string; detached: string[] } {
  const e = mustGet(kind, id);
  const refs = kind === "project" ? [] : referencesTo(e);
  if (refs.length && !opts.detach)
    throw new UserError(`${kind} ${id} is referenced by: ${refs.join("; ")}. Pass detach=true to remove those references in the same commit.`);
  const pid = e.project_id;
  const touched: Entity[] = [];
  if (refs.length) {
    const t = now();
    if (kind === "faction") for (const f of list("faction", pid)) {
      if (f.predecessor_id === id || f.successor_id === id)
        touched.push({ ...f, predecessor_id: f.predecessor_id === id ? null : f.predecessor_id, successor_id: f.successor_id === id ? null : f.successor_id, updated_at: t });
    }
    if (kind === "faction" || kind === "character") for (const p of list("pit", pid)) {
      const entries = (p.entries as PitEntry[]).filter((x) => x.subject_id !== id);
      if (entries.length !== (p.entries as PitEntry[]).length) touched.push({ ...p, entries, updated_at: t });
    }
    if (kind === "pit") for (const p of list("plot", pid)) {
      const beats = (p.beats as PlotBeat[]).filter((b) => b.pit_id !== id);
      if (beats.length !== (p.beats as PlotBeat[]).length) touched.push({ ...p, beats, updated_at: t });
    }
  }
  const rel = kind === "project" ? `projects/${pid}` : filePath(kind, pid, id);
  const paths = [rel, ...touched.map((t) => filePath(t.kind, pid, t.id))];
  const msg = `delete ${kind} ${label(e)} (${id})`;
  const sha = persist(paths, msg, () => {
    db.prepare(`DELETE FROM ${TABLE[kind]} WHERE id = ?`).run(id);
    for (const t of touched) writeRow(t);
  }, () => {
    git.removePath(rel);
    for (const t of touched) git.writeFile(filePath(t.kind, pid, t.id), toMarkdown(t));
  }, (sha) => {
    addRevision(e, "delete", sha, msg);
    for (const t of touched) { setSha(t.kind, t.id, sha); addRevision(t, "update", sha, `${msg}: detach`); }
  });
  return { commit_sha: sha, detached: refs };
}

// ---------- history ----------

export type Revision = { seq: number; project_id: string; kind: Kind; entity_id: string; op: string; commit_sha: string; message: string; at: string };

export function history(entityId: string, limit = 50): Revision[] {
  return db.prepare("SELECT * FROM revisions WHERE entity_id = ? ORDER BY seq DESC LIMIT ?").all(entityId, limit) as Revision[];
}

export function projectHistory(projectId: string, limit = 100): Revision[] {
  return db.prepare("SELECT * FROM revisions WHERE project_id = ? ORDER BY seq DESC LIMIT ?").all(projectId, limit) as Revision[];
}

function locate(entityId: string): { kind: Kind; project_id: string } {
  const live = find(entityId);
  if (live) return { kind: live.kind, project_id: live.project_id };
  const r = db.prepare("SELECT kind, project_id FROM revisions WHERE entity_id = ? ORDER BY seq DESC LIMIT 1").get(entityId) as { kind: Kind; project_id: string } | undefined;
  if (!r) throw new UserError(`no entity or history for ${entityId}`);
  return r;
}

function resolve(commitRef: string): string {
  const sha = git.resolveCommit(commitRef);
  if (!sha) throw new UserError(`unknown commit ${commitRef}`);
  return sha;
}

/** The entity as it was at a commit, or null if it didn't exist then. */
export function getAt(entityId: string, commitRef: string): Entity | null {
  const { kind, project_id } = locate(entityId);
  const md = git.showAt(resolve(commitRef), filePath(kind, project_id, entityId));
  return md === null ? null : fromMarkdown(md);
}

/** Restore one entity to its state at a commit (deleting it if it didn't exist then). */
export function rollbackEntity(entityId: string, commitRef: string): { result: "restored" | "deleted" | "unchanged"; commit_sha?: string; entity?: Entity } {
  const sha = resolve(commitRef);
  const { kind, project_id } = locate(entityId);
  const rel = filePath(kind, project_id, entityId);
  const md = git.showAt(sha, rel);
  const live = get(kind, entityId);
  if (md === null) {
    if (!live) return { result: "unchanged" };
    if (kind === "project") throw new UserError("the project didn't exist at that commit; use delete_project instead");
    const r = remove(kind, entityId, { detach: true });
    return { result: "deleted", commit_sha: r.commit_sha };
  }
  const e = fromMarkdown(md);
  if (kind !== "project" && !get("project", project_id))
    throw new UserError("its project is deleted; restore the project first with rollback_project");
  e.updated_at = now();
  const msg = `rollback ${kind} ${label(e)} (${entityId}) to ${sha.slice(0, 10)}`;
  e.commit_sha = persist([rel], msg, () => writeRow(e), () => git.writeFile(rel, toMarkdown(e)), (s) => {
    setSha(kind, entityId, s);
    addRevision(e, "rollback", s, msg);
  });
  return { result: "restored", commit_sha: String(e.commit_sha), entity: e };
}

/** Restore a whole project (every file under it) to a commit. Works for deleted projects too. */
export function rollbackProject(projectId: string, commitRef: string): { commit_sha: string; counts: Record<string, number> } {
  const sha = resolve(commitRef);
  const dir = `projects/${projectId}`;
  const files = git.listAt(sha, dir);
  if (!files.includes(`${dir}/project.md`)) throw new UserError("the project didn't exist at that commit");
  const ents = files.map((f) => fromMarkdown(git.showAt(sha, f)!));
  const t = now();
  for (const e of ents) e.updated_at = t;
  const counts: Record<string, number> = {};
  for (const e of ents) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const msg = `rollback project ${projectId} to ${sha.slice(0, 10)}`;
  const project = ents.find((e) => e.kind === "project")!;
  const newSha = persist([dir], msg, () => {
    // Remove current children (keeping the project row avoids a cascade on the parent), then reinsert.
    for (const k of CHILD_KINDS) db.prepare(`DELETE FROM ${TABLE[k]} WHERE project_id = ?`).run(projectId);
    writeRow(project);
    for (const e of ents) if (e.kind !== "project") writeRow(e);
  }, () => {
    git.removePath(dir);
    for (const e of ents) git.writeFile(filePath(e.kind, projectId, e.id), toMarkdown(e));
  }, (s) => {
    for (const e of ents) { setSha(e.kind, e.id, s); }
    addRevision(project, "rollback", s, msg);
  });
  return { commit_sha: newSha, counts };
}

// ---------- derived views ----------

export function timeline(subjectId: string): { pit: { id: string; title: string; at: string; sort_key: number }; activity: string; location?: string }[] {
  const s = find(subjectId);
  if (!s || (s.kind !== "character" && s.kind !== "faction")) throw new UserError(`${subjectId} is not a character or faction`);
  const out = [];
  for (const p of list("pit", s.project_id)) {
    const en = (p.entries as PitEntry[]).find((x) => x.subject_id === subjectId);
    if (en) out.push({ pit: { id: p.id, title: String(p.title), at: String(p.at), sort_key: Number(p.sort_key) }, activity: en.activity, location: en.location });
  }
  return out;
}
