import path from "node:path";

const env = process.env;

/** Public origin, e.g. https://canonball.sjun.me (no trailing slash). */
export const PUBLIC_URL = (env.CANONBALL_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const PORT = Number(env.CANONBALL_PORT ?? 8787);
export const HOST = env.CANONBALL_HOST ?? "127.0.0.1";
export const DATA_DIR = path.resolve(env.CANONBALL_DATA_DIR ?? "./data");
export const REPO_DIR = path.join(DATA_DIR, "repo");
export const DB_PATH = path.join(DATA_DIR, "canonball.sqlite");

/** Comma-separated client IPs allowed to use the bootstrap passphrase. Empty = any (local dev only). */
export const BOOTSTRAP_IPS = (env.CANONBALL_BOOTSTRAP_IPS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
export const BOOTSTRAP_TTL_MS = Number(env.CANONBALL_BOOTSTRAP_TTL_MIN ?? 60) * 60_000;

/** Concurrency lease: an agent session holds the lock until it is idle this long. */
export const LOCK_TTL_MS = Number(env.CANONBALL_LOCK_TTL_SEC ?? 30) * 1000;

export const RP_ID = new URL(PUBLIC_URL).hostname;
export const RP_NAME = "canonball";
export const MCP_URL = new URL("/mcp", PUBLIC_URL);
export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 90;
export const WEB_SESSION_TTL_S = 60 * 60 * 24 * 7;
