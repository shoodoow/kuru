#!/usr/bin/env bash
# Updates a Docker install of Kuru to the newest release on this branch.
# Run it from the repository folder: ./update.sh
# It keeps your data: the database, saved keys and every account's computer
# live in Docker volumes, and your settings files are not in git.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f apps/core/.env ]; then
  echo "apps/core/.env is missing. This looks like a new install: follow deploy/SETUP.md first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "You have changed files in this folder. Commit or undo them, then run this again:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

before="$(git rev-parse --short HEAD)"
echo "==> Getting the newest code"
git pull --ff-only
after="$(git rev-parse --short HEAD)"
if [ "$before" = "$after" ] && [ "${1:-}" != "--force" ]; then
  echo "Already up to date ($after). Run ./update.sh --force to rebuild anyway."
  exit 0
fi

echo "==> Building the agents' computer image"
docker build -t kuru-linux:1 apps/core/linux

echo "==> Rebuilding and restarting the server (the database is migrated as it starts)"
docker compose --profile core up -d --build

echo "==> Waiting for the server"
for _ in $(seq 1 60); do
  if answer="$(curl -fsS http://127.0.0.1:3000/health 2>/dev/null)"; then
    echo "Updated $before -> $after. The server answers: $answer"
    echo "What changed: CHANGELOG.md"
    exit 0
  fi
  sleep 2
done
echo "The server did not answer within two minutes. Look at: docker compose logs --tail 100 core" >&2
exit 1
