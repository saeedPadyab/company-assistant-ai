#!/usr/bin/env bash
# The reviewer's verdict, stored on the commit it reviewed.
#
#   scripts/review-status.sh record PASS|FAIL "<summary>"   reviewer only (guard.py enforces): note on HEAD
#   scripts/review-status.sh get [rev]                      prints PASS, FAIL or NONE (default rev: HEAD)
#   scripts/review-status.sh publish                        after push: HEAD's verdict as the `ai-review` commit status on GitHub
#
# The verdict is a git note under refs/notes/ai-review, bound to the commit SHA: any new commit has no
# verdict until it is reviewed. The note also names the commit it was written for, so a note that git
# copies to another commit (amend or rebase with notes.rewriteRef, `git notes copy`) does not count.
# .githooks/pre-push rejects a push unless the pushed commit has a PASS note (guard.py also denies it
# early). `record` needs no uncommitted changes to tracked files.
# Notes are local (never pushed); `publish` is what GitHub sees, and the `main` ruleset requires it.
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
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
