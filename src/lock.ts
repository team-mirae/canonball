// Concurrency guard. The first agent session to call a tool takes the lock; until it has been idle
// for LOCK_TTL_MS (or releases it, or disconnects), every other session's calls fail with
// "try again". Calls are also strictly serialized inside the process.
import { LOCK_TTL_MS } from "./config.js";

let holder: { session: string; client: string; until: number; since: number } | null = null;

export type LockResult = { ok: true } | { ok: false; retryAfterSec: number; heldBy: string };

export function acquire(session: string, client: string): LockResult {
  const t = Date.now();
  if (holder && holder.until > t && holder.session !== session) {
    return { ok: false, retryAfterSec: Math.ceil((holder.until - t) / 1000), heldBy: holder.client };
  }
  if (!holder || holder.session !== session || holder.until <= t) holder = { session, client, since: t, until: t + LOCK_TTL_MS };
  else holder.until = t + LOCK_TTL_MS;
  return { ok: true };
}

/** Extend the lease after a call finishes, so the idle window starts when the work ends. */
export function touch(session: string) {
  if (holder?.session === session) holder.until = Date.now() + LOCK_TTL_MS;
}

export function release(session: string): boolean {
  if (holder?.session === session) { holder = null; return true; }
  return false;
}

export function forceRelease() { holder = null; }

export function status() {
  const t = Date.now();
  if (!holder || holder.until <= t) return { locked: false as const };
  return { locked: true as const, held_by: holder.client, session: holder.session.slice(0, 8), since: new Date(holder.since).toISOString(), expires_in_sec: Math.ceil((holder.until - t) / 1000) };
}

// In-process serialization: tool handlers run one at a time.
let chain: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
