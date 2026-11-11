#!/usr/bin/env bash
# Deploy and operate canonball on public.sjun.me. Run from anywhere in the repo.
#   ./deploy/deploy.sh               test, build, ship dist/, build the image, start, health-check
#   ./deploy/deploy.sh bootstrap     print a fresh one-time bootstrap passphrase (to enroll a key)
#   ./deploy/deploy.sh reset-keys    lost every key: remove keys, sessions and MCP connections, print a passphrase
#   ./deploy/deploy.sh status | logs
#   ./deploy/deploy.sh backup        copy the data volume (sqlite + git repo) to ./backups/
#
# The app joins magic-gate's bridge magic-gate_canonball, so deploy magic-gate first.
set -euo pipefail
HOST=${HOST:-public}
DIR=/opt/canonball
cd "$(dirname "$0")/.."
DC="docker compose -p canonball -f $DIR/deploy/compose.yaml --env-file $DIR/deploy/prod.env"

case "${1:-deploy}" in
bootstrap | reset-keys) ssh "$HOST" "$DC exec -T app node /app/canonball.mjs $1 </dev/null"; exit 0 ;;
status) ssh "$HOST" "$DC ps; echo; $DC logs --tail=30 app"; exit 0 ;;
logs) exec ssh -t "$HOST" "$DC logs -f --tail=100 app" ;;
backup)
	mkdir -p backups
	out="backups/canonball-$(date -u +%Y%m%dT%H%M%SZ).tgz"
	ssh "$HOST" "docker run --rm -v canonball_app-data:/data:ro alpine tar -czf - -C /data ." >"$out"
	echo "wrote $out"; exit 0 ;;
deploy) ;;
*) echo "unknown command $1" >&2; exit 2 ;;
esac

npm run -s typecheck && npm test >/dev/null 2>&1 || { echo "typecheck/tests failed; not deploying" >&2; exit 1; }

COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo uncommitted)
if ! git diff --quiet HEAD 2>/dev/null; then COMMIT="$COMMIT-dirty"; fi

COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --uid 0 --gid 0 -czf - Dockerfile .dockerignore dist deploy/compose.yaml deploy/prod.env.example |
	ssh "$HOST" "rm -rf $DIR/dist && mkdir -p $DIR && tar --warning=no-unknown-keyword -xzf - -C $DIR"

ssh "$HOST" "DIR=$DIR COMMIT=$COMMIT bash -s" <<'REMOTE'
set -euo pipefail
cd "$DIR/deploy"
umask 077
[ -f prod.env ] || cp prod.env.example prod.env
chmod 600 prod.env
setkv() { grep -v "^$1=" prod.env > prod.env.tmp || true; printf '%s=%s\n' "$1" "$2" >> prod.env.tmp; mv prod.env.tmp prod.env; }
setkv DEPLOYED_COMMIT "$COMMIT"
docker network inspect magic-gate_canonball >/dev/null 2>&1 || { echo "magic-gate_canonball is missing: deploy magic-gate first" >&2; exit 1; }
DC="docker compose -p canonball -f $DIR/deploy/compose.yaml --env-file $DIR/deploy/prod.env"
$DC build --pull app </dev/null
$DC up -d --remove-orphans </dev/null
for i in $(seq 1 30); do $DC exec -T app node /app/canonball.mjs healthcheck </dev/null 2>/dev/null && break; sleep 2; done
$DC exec -T app node /app/canonball.mjs healthcheck </dev/null && echo "app healthy ($COMMIT)"
$DC ps --format 'table {{.Service}}\t{{.Status}}'
REMOTE
