#!/usr/bin/env bash
# One worktree per GitHub issue, each with its own database.
#
#   scripts/worktree.sh new <issue> <slug> [type]   branch <type>/<issue>-<slug> from origin/main (type: feat|fix|chore|docs)
#                                                   in ../<repo folder>-wt/<issue>, then `setup`
#   scripts/worktree.sh setup                       inside a worktree: .env files, database assistant_<issue>, git hooks, install, migrate
#   scripts/worktree.sh remove <issue> [--yes] [--force]
#                                                   drop the database, remove the worktree, delete the branch if merged
#   scripts/worktree.sh list
#
# Why a database per worktree: a migration on one branch must not break the tests of another.
# All worktrees share the one Postgres container of the main checkout (docker-compose.yml there).
# .env files are copied from the main checkout (never committed); DATABASE_URL is rewritten to the worktree's database.
set -euo pipefail

die() { echo "worktree: $*" >&2; exit 1; }
step() { echo "==> $*"; }

COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || die "not inside the company-assistant repository"
MAIN="$(dirname "$COMMON_DIR")"
WT_ROOT="$(dirname "$MAIN")/$(basename "$MAIN")-wt"
COMPOSE=(docker compose -f "$MAIN/docker-compose.yml")
DB_USER="assistant"

db_name() { echo "assistant_$1"; }

psql_admin() {  # psql_admin <sql>: run as the container's superuser against the default database
  "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d assistant -tAc "$1"
}

db_running() {
  "${COMPOSE[@]}" exec -T postgres pg_isready -U "$DB_USER" >/dev/null 2>&1
}

issue_of_branch() {  # feat/12-slug -> 12
  local branch
  branch="$(git branch --show-current)"
  [[ "$branch" =~ ^[a-z]+/([0-9]+)- ]] || die "branch '$branch' is not <type>/<issue>-<slug>"
  echo "${BASH_REMATCH[1]}"
}

# copy_env <src> <dest> <db>: copy a .env file, pointing DATABASE_URL at <db>
copy_env() {
  local src="$1" dest="$2" db="$3"
  mkdir -p "$(dirname "$dest")"
  if grep -q '^DATABASE_URL=' "$src"; then
    # replace the database name: the last path segment, before any ?query
    sed -E "s#^(DATABASE_URL=[^?]*/)[^/?]*#\1$db#" "$src" >"$dest"
  else
    cp "$src" "$dest"
  fi
  chmod 600 "$dest"
}

cmd_setup() {
  local top issue db app src dest
  top="$(git rev-parse --show-toplevel)"
  [ "$top" != "$MAIN" ] || die "setup runs inside a worktree, not in the main checkout ($MAIN)"
  issue="$(issue_of_branch)"
  db="$(db_name "$issue")"

  step ".env files (DATABASE_URL -> $db)"
  for app in "$MAIN"/apps/*/; do
    app="$(basename "$app")"
    dest="$top/apps/$app/.env"
    if [ -f "$dest" ]; then
      echo "    apps/$app/.env exists, left as is"
      continue
    fi
    if [ -f "$MAIN/apps/$app/.env" ]; then
      src="$MAIN/apps/$app/.env"
    elif [ -f "$MAIN/apps/$app/.env.example" ]; then
      src="$MAIN/apps/$app/.env.example"
    else
      continue
    fi
    copy_env "$src" "$dest" "$db"
    echo "    apps/$app/.env from ${src#"$MAIN"/}"
  done

  step "database $db"
  db_running || die "Postgres is not running. Start it from the main checkout: (cd $MAIN && docker compose up -d), then run $MAIN/scripts/worktree.sh setup again"
  if [ "$(psql_admin "SELECT 1 FROM pg_database WHERE datname = '$db'")" = "1" ]; then
    echo "    exists"
  else
    psql_admin "CREATE DATABASE \"$db\" OWNER $DB_USER" >/dev/null
    echo "    created"
  fi

  step "git hooks (.githooks: pre-push needs the reviewer's PASS)"
  # repo-wide setting, read relative to each checkout, so every worktree runs its own .githooks
  git config core.hooksPath .githooks

  step "pnpm install --frozen-lockfile"
  (cd "$top" && pnpm install --frozen-lockfile)

  step "migrate $db"
  (cd "$top" && pnpm --filter server db:migrate)

  echo
  echo "Ready: $top on $(git branch --show-current), database $db."
  echo "Seed it if the tests need data: pnpm --filter server db:seed"
}

cmd_new() {
  local issue="${1:-}" slug="${2:-}" type="${3:-feat}" path branch
  [[ "$issue" =~ ^[0-9]+$ ]] || die "usage: new <issue> <slug> [type] — <issue> is the GitHub issue number"
  [[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "slug must be lowercase words joined by '-', e.g. leave-request"
  [[ "$type" =~ ^(feat|fix|chore|docs)$ ]] || die "type must be feat, fix, chore or docs"
  path="$WT_ROOT/$issue"
  branch="$type/$issue-$slug"
  [ ! -e "$path" ] || die "$path already exists (scripts/worktree.sh list)"
  ! git -C "$MAIN" show-ref --verify -q "refs/heads/$branch" || die "branch $branch already exists"

  step "fetch origin/main"
  git -C "$MAIN" fetch --quiet origin main

  step "worktree $path on $branch"
  mkdir -p "$WT_ROOT"
  # --no-track: the branch must not track origin/main, or a bare `git push` would aim at main
  git -C "$MAIN" worktree add --quiet --no-track -b "$branch" "$path" origin/main

  if ! (cd "$path" && cmd_setup); then
    echo >&2
    echo "worktree: the worktree exists but setup did not finish. Fix the error above, then:" >&2
    echo "    cd $path && $MAIN/scripts/worktree.sh setup" >&2
    echo "or undo it: scripts/worktree.sh remove $issue" >&2
    exit 1
  fi
  echo "First push: git push -u origin $branch"
}

cmd_remove() {
  local issue="${1:-}" yes=0 force=0 path branch db dirty ahead
  [[ "$issue" =~ ^[0-9]+$ ]] || die "usage: remove <issue> [--yes] [--force]"
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes) yes=1 ;;
      --force) force=1 ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  path="$WT_ROOT/$issue"
  db="$(db_name "$issue")"
  [ -d "$path" ] || die "no worktree at $path"
  branch="$(git -C "$path" branch --show-current)"

  dirty="$(git -C "$path" status --porcelain)"
  if [ -n "$dirty" ] && [ "$force" = 0 ]; then
    die "$path has uncommitted changes — commit or discard them, or pass --force to lose them"
  fi
  if git -C "$MAIN" show-ref --verify -q "refs/remotes/origin/$branch"; then
    ahead="$(git -C "$path" rev-list --count "origin/$branch..HEAD")"
  else
    ahead="$(git -C "$path" rev-list --count "origin/main..HEAD")"
  fi
  if [ "$ahead" != 0 ] && [ "$force" = 0 ]; then
    die "$branch has $ahead commit(s) that are not on origin — push them, or pass --force to lose them"
  fi

  if [ "$yes" = 0 ]; then
    [ -t 0 ] || die "remove asks for confirmation; run it in a terminal, or pass --yes"
    read -r -p "Remove $path, drop database $db and delete $branch if merged? [y/N] " answer
    [ "$answer" = y ] || [ "$answer" = Y ] || die "cancelled"
  fi

  step "database $db"
  if db_running; then
    psql_admin "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null
    echo "    dropped"
  else
    echo "    Postgres is not running: drop it later with" >&2
    echo "    docker compose exec -T postgres psql -U $DB_USER -d assistant -c 'DROP DATABASE IF EXISTS \"$db\"'" >&2
  fi

  step "worktree $path"
  if [ "$force" = 1 ]; then
    git -C "$MAIN" worktree remove --force "$path"
  else
    git -C "$MAIN" worktree remove "$path"
  fi

  step "branch $branch"
  if git -C "$MAIN" branch -d "$branch" >/dev/null 2>&1; then
    echo "    deleted (merged)"
  else
    echo "    kept: not merged into its upstream or HEAD (delete it yourself once the PR is merged: git branch -D $branch)"
  fi
}

sub="${1:-}"
[ $# -gt 0 ] && shift
case "$sub" in
  new) cmd_new "$@" ;;
  setup) cmd_setup ;;
  remove) cmd_remove "$@" ;;
  list) git -C "$MAIN" worktree list ;;
  *) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 1 ;;
esac
