import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_DIR } from "./config.js";

function git(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, {
      cwd: REPO_DIR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_AUTHOR_NAME: "canonball", GIT_AUTHOR_EMAIL: "canonball@localhost",
        GIT_COMMITTER_NAME: "canonball", GIT_COMMITTER_EMAIL: "canonball@localhost", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (opts.allowFail) return "";
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${err.stderr || err.message}`);
  }
}

export function initRepo() {
  fs.mkdirSync(REPO_DIR, { recursive: true });
  if (!fs.existsSync(path.join(REPO_DIR, ".git"))) {
    git(["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(REPO_DIR, "README.md"), "# canonball data\n\nManaged by canonball. Every write is one commit.\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "init"]);
  }
}

export function abs(rel: string) { return path.join(REPO_DIR, rel); }

export function writeFile(rel: string, content: string) {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
}

export function removePath(rel: string) {
  fs.rmSync(abs(rel), { recursive: true, force: true });
}

/** Stage the given paths (additions, changes and deletions) and commit. Returns the commit sha. */
export function commit(paths: string[], message: string): string {
  git(["add", "-A", "--", ...paths]);
  // --allow-empty: a no-op write still gets a commit, so every revision row has a distinct sha.
  git(["commit", "-q", "--allow-empty", "-m", message]);
  return git(["rev-parse", "HEAD"]).trim();
}

export function head(): string { return git(["rev-parse", "HEAD"]).trim(); }

/** Full sha for a (possibly abbreviated) commit-ish, or null. */
export function resolveCommit(ref: string): string | null {
  if (!/^[0-9a-fA-F]{4,64}$/.test(ref)) return null;
  const out = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }).trim();
  return out || null;
}

/** File content at a commit, or null if it didn't exist there. */
export function showAt(sha: string, rel: string): string | null {
  try {
    return execFileSync("git", ["cat-file", "blob", `${sha}:${rel}`], { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Files (relative paths) under a directory at a commit. */
export function listAt(sha: string, dir: string): string[] {
  return git(["ls-tree", "-r", "--name-only", sha, "--", dir], { allowFail: true }).split("\n").filter(Boolean);
}

export function log(rel: string, limit = 50): { sha: string; at: string; message: string }[] {
  const out = git(["log", `-n${limit}`, "--format=%H%x09%cI%x09%s", "--", rel], { allowFail: true });
  return out.split("\n").filter(Boolean).map((l) => {
    const [sha, at, ...m] = l.split("\t");
    return { sha, at, message: m.join("\t") };
  });
}

/** Undo a failed write: back to `sha`, dropping any files it left behind. */
export function resetHard(sha: string) {
  git(["reset", "-q", "--hard", sha], { allowFail: true });
  git(["clean", "-fdq"], { allowFail: true });
}
