import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PUBLIC_URL } from "./config.js";
import { exportCsv } from "./export.js";
import * as lock from "./lock.js";
import * as store from "./store.js";
import { UserError, type PitEntry, type PlotBeat } from "./store.js";

type Out = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (v: unknown): Out => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string): Out => ({ content: [{ type: "text", text: msg }], isError: true });

const uuid = z.string().uuid();
const entrySchema = z.object({
  subject_type: z.enum(["character", "faction", "lore"]),
  subject_id: uuid,
  activity: z.string().describe("What the subject is doing / its state at this moment (for lore: its status, e.g. 'newly proposed', 'discredited')"),
  location: z.string().optional().describe("Where the subject is"),
});
const beatSchema = z.object({ pit_id: uuid, note: z.string().optional().describe("What this PIT means for the plot") });

const FIELDS = {
  project: {
    name: z.string().min(1),
    description: z.string().optional().describe("Markdown"),
  },
  faction: {
    name: z.string().min(1),
    abbreviations: z.array(z.string()).optional(),
    predecessor_id: uuid.nullable().optional().describe("Faction this one grew out of"),
    successor_id: uuid.nullable().optional().describe("Faction that replaced this one"),
    description: z.string().optional().describe("Markdown"),
  },
  character: {
    name: z.string().min(1),
    other_names: z.array(z.string()).optional().describe("Aliases, titles, birth names"),
    date_of_birth: z.string().min(1).describe("Free text, in the setting's own calendar if it has one; 'unknown' is allowed"),
    description: z.string().optional().describe("Markdown"),
  },
  lore: {
    name: z.string().min(1),
    category: z.string().min(1).describe("Free text; e.g. standard, definition, pseudoscience, theory, technology, law, religion, custom, language, unit"),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    related_ids: z.array(uuid).optional().describe("Ids of related factions, characters, lore, PITs or plots in the same project"),
    description: z.string().optional().describe("Markdown: the full text of the definition, standard or theory"),
  },
  pit: {
    title: z.string().min(1),
    at: z.string().min(1).describe("In-world time label, e.g. '1453-05-29 dawn' or 'Year 3, winter'"),
    sort_key: z.number().optional().describe("Chronological order; defaults to after the last PIT"),
    exhaustive: z.boolean().optional().describe("True if entries list everyone/everything that matters at this moment"),
    entries: z.array(entrySchema).optional().describe("One per subject: what each character/faction is doing and where"),
    description: z.string().optional().describe("Markdown: the god's-eye overview of this moment"),
  },
  plot: {
    name: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional().describe("Free-form: status, pov, themes, arc, …"),
    beats: z.array(beatSchema).optional().describe("Ordered PITs that make up this plot"),
    description: z.string().optional().describe("Markdown"),
  },
} as const;

const REQUIRED: Record<string, string[]> = {
  project: ["name"], faction: ["name"], character: ["name", "date_of_birth"], lore: ["name", "category"], pit: ["title", "at"], plot: ["name"],
};

function partial<T extends Record<string, z.ZodTypeAny>>(shape: T) {
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> };
}
function forCreate(kind: keyof typeof FIELDS) {
  const shape = FIELDS[kind] as Record<string, z.ZodTypeAny>;
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, REQUIRED[kind].includes(k) ? v : v.optional()]));
}

/** Compact listing: no long text, so lists stay cheap for agents. */
function summary(e: store.Entity) {
  const { description, entries, beats, created_at, ...rest } = e;
  const s: Record<string, unknown> = { ...rest };
  if (Array.isArray(entries)) s.entry_count = entries.length;
  if (Array.isArray(beats)) s.beat_count = beats.length;
  if (typeof description === "string" && description) s.description_preview = description.slice(0, 160);
  delete s.kind;
  return s;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export const INSTRUCTIONS = `canonball keeps the canon of fictional universes.
Everything lives in a project. Factions (nations, parties, any non-human interest group), characters (humans or functionally human) and lore (the setting's standards, definitions, pseudosciences, theories, technologies, laws, customs…) are the subjects. A PIT (point in time) is a god's-eye snapshot: one entry per subject saying what it is doing and where; it may be exhaustive or partial. A plot is an ordered list of PITs (beats) plus metadata.
Every write is a git commit; use history/get_version/rollback_* to inspect or undo. export_csv gives the whole project as one table (factions, characters, lore and plots as rows, PITs as columns). Check lore before inventing terms or rules, and record new ones there.
Only one agent may use canonball at a time. If a call returns "try again", wait the given seconds and retry; call release_lock when you are done so others needn't wait for the idle timeout.`;

export function buildServer(sessionId: () => string, clientName: string): McpServer {
  const server = new McpServer({ name: "canonball", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  // Every tool goes through the lock and the serializer, and turns UserErrors into tool errors.
  const tool = <S extends Record<string, z.ZodTypeAny>>(
    name: string, description: string, shape: S, annotations: Record<string, boolean>,
    fn: (args: z.infer<z.ZodObject<S>>) => unknown,
  ) => {
    server.registerTool(name, { description, inputSchema: shape, annotations } as never, (async (args: z.infer<z.ZodObject<S>>) => {
      const sid = sessionId();
      if (name === "release_lock") return ok(fn(args));
      const got = lock.acquire(sid, clientName);
      if (!got.ok) return fail(`try again: canonball is in use by another agent (${got.heldBy}). Retry in ${got.retryAfterSec}s.`);
      try {
        return await lock.serialize(async () => ok(await fn(args)));
      } catch (e) {
        if (e instanceof UserError) return fail(e.message);
        console.error(`tool ${name} failed`, e);
        return fail(`internal error: ${(e as Error).message}`);
      } finally {
        lock.touch(sid);
      }
    }) as never);
  };

  // ----- projects -----
  tool("list_projects", "List all projects.", {}, READ, () => store.list("project").map(summary));
  tool("create_project", "Create a project. Every faction, character, PIT and plot belongs to one.", forCreate("project"), WRITE,
    (a) => store.create("project", null, a));
  tool("update_project", "Update a project's name or description.", { id: uuid, ...partial(FIELDS.project) }, WRITE,
    ({ id, ...p }) => store.update("project", id, p));
  tool("delete_project", "Delete a project and everything in it (one commit; restorable with rollback_project).", { id: uuid }, DESTROY,
    ({ id }) => store.remove("project", id));
  tool("get_project", "A project with counts of its contents.", { id: uuid }, READ, ({ id }) => {
    const p = store.mustGet("project", id);
    return { ...p, counts: Object.fromEntries(store.CHILD_KINDS.map((k) => [k, store.list(k, id).length])) };
  });

  // ----- generic CRUD per kind -----
  const kinds = [
    ["faction", "factions", "a faction (nation, political party, any non-human interest group)"],
    ["character", "characters", "a character (a human or functionally human being)"],
    ["lore", "lore", "a lore entry (standard, definition, pseudoscience, theory, technology, law, custom, … of the setting)"],
    ["pit", "pits", "a PIT (point in time: god's-eye snapshot of what everyone/everything is doing and where)"],
    ["plot", "plots", "a plot (ordered list of PITs plus metadata)"],
  ] as const;
  for (const [kind, plural, what] of kinds) {
    tool(`list_${plural}`, `List ${plural} in a project (compact; use get_${kind} for full text).${kind === "pit" ? " Sorted chronologically." : ""}${kind === "lore" ? " Filter by category to see e.g. only theories." : ""}`,
      { project_id: uuid, query: z.string().optional().describe("Case-insensitive substring filter over all fields"),
        ...(kind === "lore" ? { category: z.string().optional().describe("Exact category, case-insensitive") } : {}) }, READ,
      ({ project_id, query, category }) => {
        store.mustGet("project", project_id);
        let out = store.list(kind, project_id, query);
        if (typeof category === "string" && category) out = out.filter((e) => String(e.category).toLowerCase() === category.toLowerCase());
        return out.map(summary);
      });
    tool(`get_${kind}`, `Get ${what} in full.`, { id: uuid }, READ, ({ id }) => store.mustGet(kind, id));
    tool(`create_${kind}`, `Create ${what}.`, { project_id: uuid, ...forCreate(kind) }, WRITE,
      ({ project_id, ...a }) => store.create(kind, project_id, a));
    tool(`update_${kind}`, `Update ${what}. Only the given fields change; arrays given here replace the stored ones.`,
      { id: uuid, ...partial(FIELDS[kind] as Record<string, z.ZodTypeAny>) }, WRITE,
      ({ id, ...p }) => store.update(kind, id, p as Record<string, unknown>));
    tool(`delete_${kind}`, `Delete ${what}. Fails if referenced elsewhere unless detach=true, which removes the references in the same commit.`,
      { id: uuid, detach: z.boolean().optional() }, DESTROY, ({ id, detach }) => store.remove(kind, id, { detach }));
  }

  // ----- PIT entries / plot beats -----
  tool("set_pit_entry", "Add or replace one subject's entry in a PIT.", { pit_id: uuid, ...entrySchema.shape }, WRITE,
    ({ pit_id, ...en }) => {
      const p = store.mustGet("pit", pit_id);
      const entries = (p.entries as PitEntry[]).filter((x) => !(x.subject_id === en.subject_id && x.subject_type === en.subject_type));
      entries.push(en);
      return store.update("pit", pit_id, { entries });
    });
  tool("remove_pit_entry", "Remove a subject's entry from a PIT.", { pit_id: uuid, subject_id: uuid }, WRITE, ({ pit_id, subject_id }) => {
    const p = store.mustGet("pit", pit_id);
    const entries = (p.entries as PitEntry[]).filter((x) => x.subject_id !== subject_id);
    if (entries.length === (p.entries as PitEntry[]).length) throw new UserError("no entry for that subject in this PIT");
    return store.update("pit", pit_id, { entries });
  });
  tool("add_plot_beat", "Insert a PIT into a plot's beat list (at the end, or at a 0-based position).",
    { plot_id: uuid, ...beatSchema.shape, position: z.number().int().min(0).optional() }, WRITE, ({ plot_id, position, ...b }) => {
      const p = store.mustGet("plot", plot_id);
      const beats = [...(p.beats as PlotBeat[])];
      beats.splice(position ?? beats.length, 0, b);
      return store.update("plot", plot_id, { beats });
    });
  tool("remove_plot_beat", "Remove a PIT from a plot's beats.", { plot_id: uuid, pit_id: uuid }, WRITE, ({ plot_id, pit_id }) => {
    const p = store.mustGet("plot", plot_id);
    const beats = (p.beats as PlotBeat[]).filter((b) => b.pit_id !== pit_id);
    if (beats.length === (p.beats as PlotBeat[]).length) throw new UserError("that PIT is not a beat of this plot");
    return store.update("plot", plot_id, { beats });
  });
  tool("timeline", "Chronological list of what a character, faction or lore entry does / its status across all PITs.", { subject_id: uuid }, READ,
    ({ subject_id }) => store.timeline(subject_id));

  // ----- history -----
  tool("history", "Revisions of one entity (any kind, including deleted ones), newest first.",
    { id: uuid, limit: z.number().int().min(1).max(500).optional() }, READ, ({ id, limit }) => store.history(id, limit));
  tool("project_history", "All revisions in a project, newest first.",
    { project_id: uuid, limit: z.number().int().min(1).max(1000).optional() }, READ, ({ project_id, limit }) => store.projectHistory(project_id, limit));
  tool("get_version", "An entity exactly as it was at a commit (null if it didn't exist then).",
    { id: uuid, commit: z.string().describe("Commit sha (full or abbreviated)") }, READ, ({ id, commit }) => store.getAt(id, commit));
  tool("rollback_entity", "Restore one entity to its state at a commit (as a new commit). Deletes it if it didn't exist then.",
    { id: uuid, commit: z.string() }, DESTROY, ({ id, commit }) => store.rollbackEntity(id, commit));
  tool("rollback_project", "Restore a whole project, every file in it, to a commit (as a new commit). Also restores deleted projects.",
    { project_id: uuid, commit: z.string() }, DESTROY, ({ project_id, commit }) => store.rollbackProject(project_id, commit));

  // ----- export / lock -----
  tool("export_csv", "Export a project as CSV: factions, characters and plots as rows, PITs as columns, all text inlined. Returns the CSV and a download URL (signed-in browser).",
    { project_id: uuid }, READ, ({ project_id }) => {
      const { filename, csv } = exportCsv(project_id);
      return `download: ${PUBLIC_URL}/export/${project_id}.csv\nfilename: ${filename}\n\n${csv.replace(/^﻿/, "")}`;
    });
  tool("lock_status", "Who holds the canonball lock.", {}, READ, () => lock.status());
  tool("release_lock", "Release the lock now, so other agents needn't wait for the idle timeout.", {}, WRITE,
    () => ({ released: lock.release(sessionId()) }));

  return server;
}
