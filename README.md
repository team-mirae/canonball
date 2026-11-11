# canonball

The **canon** of your fictional universe, kept by a self-hosted MCP server that rolls with you. (Canon + ball, as in cannonball.)

canonball is a single-user MCP server for storybuilders. Agents such as Claude read and write your world through it: who exists, what every faction and character is doing at each moment, and how plots thread through those moments. Every change is versioned, so any earlier state can be inspected or restored.

## Model

| Thing | What it is | Fields |
|---|---|---|
| **Project** | Container for one universe. Everything lives in a project. | name, description |
| **Faction** | A nation, political party, or any non-human interest group | uuid, name, abbreviations[], predecessor?, successor?, description |
| **Character** | A human, or functionally human | uuid, name, other_names[], date_of_birth, description |
| **PIT** (point in time) | A god's-eye snapshot: what everyone/everything is doing, and where. Exhaustive or partial. | uuid, title, at (in-world time), sort_key, exhaustive, entries[{subject_type, subject_id, activity, location?}], description |
| **Plot** | An ordered list of PITs plus metadata | uuid, name, metadata{}, beats[{pit_id, note?}], description |

`date_of_birth` and `at` are free text, so you can use any in-world calendar. `sort_key` orders PITs; by default each new PIT goes after the last one.

## History

State lives in SQLite. Every entity is also a markdown file in a git repo (`<data>/repo/projects/<project>/…`), with JSON frontmatter and the description as its body. Each write is one commit, and the row records that commit's sha. MCP tools:

- `history`, `project_history`: revisions, newest first (deleted entities included)
- `get_version`: an entity exactly as it was at a commit
- `rollback_entity`, `rollback_project`: restore to a commit, as a new commit. This also brings back deleted entities and projects.

## Concurrency guard

One agent at a time. The first MCP session to call a tool takes the lock. Until that session has been idle for `CANONBALL_LOCK_TTL_SEC` (default 30 s), calls `release_lock`, or disconnects, every other session gets `try again: … Retry in Ns.` Inside the process, calls are also serialized. The web UI shows who holds the lock and can force-release it.

## Export

`export_csv` (MCP), or **Export CSV** in the web UI (`/export/<project>.csv`), produces one table:

- Columns: `type, id, name, details`, then one column per PIT in chronological order.
- The first row describes each PIT. After it comes one row per faction, character and plot.
- A subject's cell is its activity at that PIT, plus `@ location`. A plot's cell is `beat N: note`.

All text is inlined and quoted per RFC 4180, with a UTF-8 BOM, so Excel and Google Sheets import the file as is and an agent can write a story from it.

## Auth

- **Browser:** passkeys and/or hardware security keys (WebAuthn). The first key is enrolled with a one-time **bootstrap passphrase**: a random UUID printed in the server log and written to `<data>/bootstrap.txt`. It is valid for 1 hour and accepted only from `CANONBALL_BOOTSTRAP_IPS`. Once signed in, you can add or remove keys in the UI.
- **MCP:** OAuth 2.1 with Client ID Metadata Documents, the handshake claude.ai uses. Clients are public, PKCE is S256, and there is no client registration or secret. In claude.ai, add `https://canonball.sjun.me/mcp` as a custom connector, then approve it with your key. Only `CANONBALL_OAUTH_CLIENTS` may connect (default: claude.ai's connector).

## Run locally

```sh
npm install
npm test            # builds, then runs the end-to-end suite
npm run build && node dist/canonball.mjs     # http://localhost:8787, data in ./data
```

| Env | Default | |
|---|---|---|
| `CANONBALL_PUBLIC_URL` | `http://localhost:8787` | Origin; also the WebAuthn RP ID |
| `CANONBALL_PORT` / `CANONBALL_HOST` | `8787` / `127.0.0.1` | |
| `CANONBALL_DATA_DIR` | `./data` | SQLite + git repo |
| `CANONBALL_BOOTSTRAP_IPS` | (any) | Comma-separated client IPs allowed to bootstrap |
| `CANONBALL_LOCK_TTL_SEC` | `30` | Lock idle timeout |
| `CANONBALL_OAUTH_CLIENTS` | claude.ai's CIMD URL | Allowed OAuth client ids |

## Deploy

Production runs on `public.sjun.me` behind magic-gate's edge, which handles TLS and sets `X-Forwarded-For`. The app sits on its own internal bridge, `magic-gate_canonball`, at `https://canonball.sjun.me`.

```sh
./deploy/deploy.sh             # test, build dist/ locally, ship, docker build, start, health-check
./deploy/deploy.sh bootstrap   # fresh one-time passphrase
./deploy/deploy.sh reset-keys  # lost every key
./deploy/deploy.sh backup      # tarball of the data volume
```
