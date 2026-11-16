---
name: ship
description: Ship a reviewed issue branch - draft the PR text, then push and open the PR after the user's yes. Needs the reviewer's PASS on HEAD (run /review-branch first). Use when the user says ship, open the PR or push this. Ends by offering /follow-pr.
argument-hint: "[issue number]"
---

# Ship an issue

Second of three: `/review-branch` (commit, QA and review) → `/ship` (this: PR text, push, open the PR) → `/follow-pr` (CI, review, merge, cleanup). Never push or open a PR before the reviewer said PASS on HEAD and the user said yes. Claude never merges.

Run every command in the issue's worktree. If this session is in the main checkout and the work is in `.claude/worktrees/<KEY>`, switch into it first with `EnterWorktree` (`path`, see `/work-on` step 5); a `cd <worktree path> && ` prefix leaves `git commit` and Docker refused by the sandbox.

## 1. Check the verdict

```bash
git branch --show-current
git status --porcelain
scripts/review-status.sh get
```

- On `main`, or the branch is not `<type>/<KEY>-<slug>`: stop and offer `/work-on`.
- Uncommitted changes to tracked files, or `get` does not print `PASS` (a commit after the review, no review yet, or FAIL): stop and offer `/review-branch` in a dialog. A commit after a PASS always needs `/review-branch` again (docs-only commits: its `carry`).
- The PR body needs the review outcome (rounds, open Should fix and Nit items) and the QA outcome. Take them from this session's `/review-branch` run; if this session did not run it, read the verdict note (`git notes --ref=ai-review show HEAD`) and say in the PR body that the details are from the note only.

## 2. Draft the PR, wait for yes

```bash
gh issue view <KEY> --json title,labels,milestone
```

Title: `<KEY>: <issue title>`, at most about 70 characters (shorten the issue title if needed). Body, in this order (same sections as `.github/pull_request_template.md`):

```markdown
Closes #<KEY>

<one or two sentences: what problem this solves>

## What changes
- <change, by file or area>

## How it was tested
- `scripts/verify.sh`: green (the QA run at the reviewed SHA)
- <tests added, manual checks>

## Review
VERDICT: PASS — <review/fix rounds from the workflow, or "carried from <sha12>"; open Should fix / Nit items, or "no open items">
QA: <verify.sh result at the reviewed SHA; criteria covered / manual / missing>

## Not tested
- <what could not be checked here, or "nothing">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Write title, labels, milestone (all copied from the issue) and the body to a scratchpad file, send it with `SendUserFile`, and ask with a dialog: _Push and open the PR (Recommended)_ · _Change it_ (the corrections come in "Other"). Wait for the yes.

## 3. Push and open the PR

Run each of the three as a Bash call of its own (`cd <worktree> && ` in front at most): chained to anything else they stay in the sandbox, and the guard denies that form. The guard hook asks before each of these; that is the code-level lock on top of the user's yes. Git's pre-push hook (`.githooks/pre-push`) rejects the push unless the pushed commit has the reviewer's PASS note, and the guard denies it early: a commit made after the review needs `/review-branch` again. Never use `--no-verify`.

```bash
git push -u origin <branch>
scripts/review-status.sh publish
gh pr create --base main --title "<title>" --label "<label1>" --label "<label2>" --milestone "<milestone>" --body-file - <<'EOF'
<body>
EOF
```

`publish` posts the verdict as the `ai-review` commit status on GitHub; `main` requires it, so the PR cannot merge without it. One `--label` per issue label (all of them); omit `--label` / `--milestone` when the issue has none.

A later push to the same PR (a fix from `/follow-pr`) is `git push` and `scripts/review-status.sh publish` only, each on its own, after `/review-branch` passed the new HEAD.

When the PR is open, go straight on with `/follow-pr` checkpoint 1: opening the PR is the user's request to follow it.
