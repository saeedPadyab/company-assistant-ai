#!/usr/bin/env bash
# The reviewer's verdict, stored on the commit it reviewed.
#
#   scripts/review-status.sh record PASS|FAIL "<summary>"   reviewer only (guard.py enforces): note on HEAD
#   scripts/review-status.sh get [rev]                      prints PASS, FAIL or NONE (default rev: HEAD)
#   scripts/review-status.sh publish                        after push: HEAD's verdict as the `ai-review` commit status on GitHub
#   scripts/review-status.sh carry                          PASS onto HEAD from the nearest passed ancestor, docs-only commits since
#
# The verdict is a git note under refs/notes/ai-review, bound to the commit SHA: any new commit has no
# verdict until it is reviewed. The note also names the commit it was written for, so a note that git
# copies to another commit (amend or rebase with notes.rewriteRef, `git notes copy`) does not count.
# .githooks/pre-push rejects a push unless the pushed commit has a PASS note (guard.py also denies it
# early). `record` needs no uncommitted changes to tracked files.
# Notes are local (never pushed); `publish` is what GitHub sees, and the `main` ruleset requires it.
#
# `carry` (issue #34) is the one other writer of a note, and it decides in code, not on anyone's word: the
# nearest first-parent ancestor with a verdict must have PASS, no commit after it may be a merge, and every
# path those commits change must be docs-only (see docs_only_path); otherwise it refuses and writes nothing.
set -euo pipefail

NOTES_REF="ai-review"
CONTEXT="ai-review"

die() { echo "review-status: $*" >&2; exit 1; }

verdict_of() {  # verdict_of <rev>: PASS, FAIL or NONE (also NONE when the note was written for another commit)
  local sha note first
  sha="$(git rev-parse --verify --quiet "$1^{commit}")" || { echo NONE; return; }
  note="$(git notes --ref="$NOTES_REF" show "$sha" 2>/dev/null)" || true
  grep -qx "commit: $sha" <<<"$note" || { echo NONE; return; }
  first="$(head -n 1 <<<"$note")"
  case "$first" in
    "VERDICT: PASS") echo PASS ;;
    "VERDICT: FAIL") echo FAIL ;;
    *) echo NONE ;;
  esac
}

cmd_record() {
  local verdict="${1:-}" summary="${2:-}"
  [[ "$verdict" =~ ^(PASS|FAIL)$ ]] || die "usage: record PASS|FAIL \"<summary>\""
  [ -n "$summary" ] || die "a one-line summary is required"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes: the verdict must be for a commit, so commit or stash first"
  git notes --ref="$NOTES_REF" add -f -m "VERDICT: $verdict" -m "$summary" \
    -m "reviewed: $(date -u +%Y-%m-%dT%H:%M:%SZ)" -m "commit: $(git rev-parse HEAD)" HEAD
  echo "recorded $verdict on $(git rev-parse --short HEAD)"
}

docs_only_path() {  # docs_only_path <path>: Markdown that no tool or agent reads as instructions or config
  case "$1" in
    .claude/* | .github/* | .githooks/*) return 1 ;;
    CLAUDE.md | */CLAUDE.md | AGENTS.md | */AGENTS.md) return 1 ;;
    *.md) return 0 ;;
    *) return 1 ;;
  esac
}

cmd_carry() {
  local head base="" sha verdict path bad=() count
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes: commit or stash first"
  head="$(git rev-parse HEAD)"
  [ "$(verdict_of "$head")" = NONE ] || die "HEAD already has a verdict: $(verdict_of "$head")"
  while read -r sha; do
    verdict="$(verdict_of "$sha")"
    case "$verdict" in
      PASS) base="$sha"; break ;;
      FAIL) die "the nearest reviewed commit ${sha:0:12} has FAIL; run the reviewer" ;;
    esac
  done < <(git rev-list --first-parent --max-count=200 "$head^" 2>/dev/null)
  [ -n "$base" ] || die "no passed ancestor on this branch; run the reviewer"
  [ -z "$(git rev-list --min-parents=2 "$base..$head")" ] || die "a merge since ${base:0:12}: run the reviewer"
  while IFS= read -r -d '' path; do
    docs_only_path "$path" || bad+=("$path")
  done < <(git diff --name-only --no-renames -z "$base" "$head")
  [ ${#bad[@]} -eq 0 ] || die "not docs-only since ${base:0:12} (${bad[*]}); run the reviewer"
  count="$(git rev-list --count "$base..$head")"
  git notes --ref="$NOTES_REF" add -f -m "VERDICT: PASS" \
    -m "carried from ${base:0:12}: $count docs-only commit(s) since that review" \
    -m "reviewed: $(date -u +%Y-%m-%dT%H:%M:%SZ)" -m "commit: $head" -m "carried-from: $base" "$head"
  echo "carried PASS from ${base:0:12} to ${head:0:12}"
}

cmd_publish() {
  local sha verdict state description repo
  sha="$(git rev-parse HEAD)"
  verdict="$(verdict_of HEAD)"
  [ "$verdict" != NONE ] || die "HEAD has no verdict; run the reviewer first"
  [ -n "$(git branch -r --contains "$sha" 2>/dev/null)" ] || die "HEAD is not pushed yet; push first, then publish"
  if [ "$verdict" = PASS ]; then state=success; else state=failure; fi
  description="$(git notes --ref="$NOTES_REF" show HEAD | sed -n '3p' | cut -c1-140)"
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
  gh api -X POST "repos/$repo/statuses/$sha" \
    -f state="$state" -f context="$CONTEXT" -f description="${description:-reviewer verdict: $verdict}" \
    --jq '"published \(.context)=\(.state) on \(.url | split("/") | last | .[0:7])"'
}

case "${1:-}" in
  record) shift; cmd_record "$@" ;;
  get) verdict_of "${2:-HEAD}" ;;
  publish) cmd_publish ;;
  carry) cmd_carry ;;
  *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
