#!/usr/bin/env bash
# Run the CI checks locally, for the packages this branch changed.
#
#   scripts/verify.sh          packages affected vs origin/main (committed and uncommitted changes)
#   scripts/verify.sh --full   every package
#
# Same commands as .github/workflows/ci.yml, through turbo, so local and CI agree:
#   web:    typecheck, lint, build
#   server: migrate this checkout's database, then typecheck, lint, test
# Exit 0 = green. Used by the Stop hook (.claude/hooks/verify_on_stop.py).
set -euo pipefail

die() { echo "verify: $*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
BASE="origin/main"
full=0
case "${1:-}" in
  --full) full=1 ;;
  "") ;;
  *) die "usage: scripts/verify.sh [--full]" ;;
esac

web=false
server=false
if [ "$full" = 1 ]; then
  web=true; server=true; why="--full"
elif ! git rev-parse -q --verify "$BASE" >/dev/null; then
  web=true; server=true; why="$BASE not found"
elif { git diff --name-only "$BASE"...HEAD; git diff --name-only HEAD; } | grep -qx 'pnpm-lock.yaml'; then
  # turbo diffs the lockfile per package; like CI, any lockfile change runs everything
  web=true; server=true; why="lockfile changed"
else
  affected="$(TURBO_SCM_BASE="$BASE" pnpm exec turbo ls --affected --output=json 2>/dev/null)" || die "turbo ls --affected failed"
  for pkg in web server; do
    if echo "$affected" | grep -q "\"name\": *\"$pkg\""; then
      eval "$pkg=true"
    fi
  done
  why="affected vs $BASE"
fi

echo "verify ($why): web=$web server=$server"
if [ "$web" = false ] && [ "$server" = false ]; then
  echo "nothing to check"
  exit 0
fi

failed=()
if [ "$server" = true ]; then
  echo "==> server: migrate"
  if ! pnpm --filter server db:migrate >/dev/null 2>&1; then
    die "migration failed. Is Postgres running? Start it from the main checkout: docker compose up -d"
  fi
  echo "==> server: typecheck lint test"
  pnpm exec turbo run typecheck lint test --filter=server --output-logs=errors-only || failed+=(server)
fi
if [ "$web" = true ]; then
  echo "==> web: typecheck lint build"
  pnpm exec turbo run typecheck lint build --filter=web --output-logs=errors-only || failed+=(web)
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "verify: FAILED (${failed[*]})" >&2
  exit 1
fi
echo "verify: OK"
