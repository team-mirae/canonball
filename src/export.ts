// CSV export of one project: factions, characters and plots as rows, every PIT as a column, all
// text inlined so a spreadsheet or an agent gets the whole canon from one file.
import { list, mustGet, type Entity, type PitEntry, type PlotBeat } from "./store.js";

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function exportCsv(projectId: string): { filename: string; csv: string } {
  const project = mustGet("project", projectId);
  const factions = list("faction", projectId);
  const characters = list("character", projectId);
  const plots = list("plot", projectId);
  const pits = list("pit", projectId);
  const names = new Map<string, string>();
  for (const e of [...factions, ...characters, ...plots, ...pits]) names.set(e.id, String(e.name ?? e.title));
  const ref = (id: unknown) => (id ? `${names.get(String(id)) ?? "?"} [${id}]` : "");

  const header = ["type", "id", "name", "details", ...pits.map((p) => `${p.at} | ${p.title}${p.exhaustive ? " (exhaustive)" : ""} [${p.id}]`)];
  const rows: string[][] = [header];

  // First row: what each PIT is, so the columns carry their own context.
  rows.push(["pit", "", "(point in time)", `project: ${project.name}${project.description ? `\n${project.description}` : ""}`,
    ...pits.map((p) => String(p.description ?? ""))]);

  const subjectRow = (e: Entity, details: string[]) => {
    const r = [e.kind, e.id, String(e.name), details.filter(Boolean).join("\n")];
    for (const p of pits) {
      const en = (p.entries as PitEntry[]).find((x) => x.subject_id === e.id);
      r.push(en ? `${en.activity}${en.location ? `\n@ ${en.location}` : ""}` : "");
    }
    rows.push(r);
  };
  for (const f of factions) subjectRow(f, [
    (f.abbreviations as string[]).length ? `abbreviations: ${(f.abbreviations as string[]).join(", ")}` : "",
    f.predecessor_id ? `predecessor: ${ref(f.predecessor_id)}` : "",
    f.successor_id ? `successor: ${ref(f.successor_id)}` : "",
    String(f.description ?? ""),
  ]);
  for (const c of characters) subjectRow(c, [
    (c.other_names as string[]).length ? `also known as: ${(c.other_names as string[]).join(", ")}` : "",
    `born: ${c.date_of_birth}`,
    String(c.description ?? ""),
  ]);
  for (const pl of plots) {
    const meta = Object.entries(pl.metadata as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    const r = ["plot", pl.id, String(pl.name), [...meta, String(pl.description ?? "")].filter(Boolean).join("\n")];
    const beats = pl.beats as PlotBeat[];
    for (const p of pits) {
      const i = beats.findIndex((b) => b.pit_id === p.id);
      r.push(i < 0 ? "" : `beat ${i + 1}${beats[i].note ? `: ${beats[i].note}` : ""}`);
    }
    rows.push(r);
  }

  // BOM so Excel reads UTF-8; CRLF row ends per RFC 4180; newlines inside quoted cells are kept.
  const csv = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  const slug = String(project.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  return { filename: `${slug}-${projectId.slice(0, 8)}.csv`, csv };
}
