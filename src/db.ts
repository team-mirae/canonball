import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DATA_DIR, DB_PATH } from "./config.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, abbreviations TEXT NOT NULL DEFAULT '[]',
  predecessor_id TEXT, successor_id TEXT, description TEXT NOT NULL DEFAULT '',
  commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, other_names TEXT NOT NULL DEFAULT '[]', date_of_birth TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pits (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, at TEXT NOT NULL, sort_key REAL NOT NULL, exhaustive INTEGER NOT NULL DEFAULT 0,
  entries TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '',
  commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', beats TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  commit_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  entity_id TEXT NOT NULL, op TEXT NOT NULL, commit_sha TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_entity ON revisions(entity_id, seq);
CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project_id, seq);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS web_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
  access_hash TEXT NOT NULL, access_exp INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL, refresh_exp INTEGER NOT NULL,
  prev_refresh_hash TEXT, rotated_at INTEGER, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getSetting(key: string): string | undefined {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value;
}
export function setSetting(key: string, value: string | null) {
  if (value === null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
