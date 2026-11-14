---
name: ship
description: Finish an issue - commit, verify, run the reviewer, draft the PR, then push and open it after the user's yes. Use when the user says ship, open the PR, push this, or the work on an issue branch is done.
argument-hint: "[issue number]"
---

# Ship an issue

Order matters: never push or open a PR before verify is green, the reviewer said PASS and the user said yes. Claude never merges.

Run every command in the issue's worktree. If this session is in the main checkout and the work is in `../<repo folder>-wt/<KEY>`, prefix commands with `cd <worktree path> && `.

## 1. Check the branch

```bash
git branch --show-current
git status --porcelain
git log origin/main..HEAD --oneline
```

- On `main`, or the branch is not `<type>/<KEY>-<slug>`: stop and offer `/work-on`.
- KEY comes from the branch. If an argument is given and differs from the branch's KEY: stop and ask which is right.
- Uncommitted changes: list the files and propose one commit `<KEY>: <what changed>`. Do not pick files yourself if some look unrelated; ask. Commit only after the user's yes. Never commit `.env` files.
- No commits ahead of `origin/main`: nothing to ship; stop.

## 2. Verify

```bash
scripts/verify.sh
```

Red: show the failing part and stop. The user decides whether you fix it now.

A fix you make here (red verify, or after the user's decision on a review) follows the same loop so that what is reviewed is what gets pushed: fix, commit with the `<KEY>: ` prefix, then run `/ship` again from step 1. Blocker fixes inside the review are the `ship-branch` workflow's job (step 3).

## 3. Review (the `ship-branch` workflow)

Run the `ship-branch` workflow (Workflow tool, `name: "ship-branch"`); running it is part of the user's request to ship, so do not ask first:

```
args: { "key": <KEY>, "worktree": "<absolute worktree path>" }
```

Add `"since": "<sha>"` only for the one follow-up review after Should fix or Nit commits (below): the `sha` an earlier run of this session returned with PASS.

The workflow decides the rounds in code: the `reviewer` reviews HEAD; on FAIL the `fixer` fixes the Blockers (each with a test, `scripts/verify.sh`, one `<KEY>: ` commit) and the `reviewer` reviews only the new commits; at most two fix rounds (`MAX_FIX_ROUNDS` in `.claude/workflows/ship-branch.js`). Do not run another round by hand. It returns `{ verdict, sha, readyForPr, stopReason, blockers, shouldFix, nits, rounds, finalReview }`. Keep `finalReview` and `rounds` for the PR body, then check the verdict on the commit:

```bash
scripts/review-status.sh get
```

- `verdict` is `FAIL` (Blockers left after two fix rounds, or the fixer could not fix them): show `stopReason` and the Blockers with their scenarios, and stop. The user decides; a new fix after that is a new `/ship` run.
- `readyForPr` is true and `get` prints `PASS`: show `shouldFix` and `nits` once and ask, for each group: fix now or leave them. They never start a fix round by themselves. Fix now: fix, commit with the `<KEY>: ` prefix, `scripts/verify.sh`, then run the workflow once more with `since` set to the PASS `sha` (one follow-up review of the new commits); its own Should fix and Nit items are listed for the user, not fixed. Offer `/new-issue` for anything left that is worth doing later.
- Anything else (the workflow errors, `readyForPr` is false, or `get` does not print `PASS`): treat it as FAIL, say so, and stop. A missing verdict never allows step 4.
- Never record a verdict yourself; the guard hook denies it outside the `reviewer` agent. If the `reviewer` or `fixer` agent or the `ship-branch` workflow is not available in this session (they load when a session starts), stop and ask the user to start a new session: a stand-in subagent cannot record a verdict, so the push would be blocked.

## 4. Draft the PR, wait for yes

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
- `scripts/verify.sh`: green
- <tests added, manual checks>

## Review
VERDICT: PASS — <review/fix rounds from the workflow; open Should fix / Nit items, or "no open items">

## Not tested
- <what could not be checked here, or "nothing">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Show title, labels, milestone (all copied from the issue) and the body. Wait for the user's yes or corrections.

## 5. Push and open the PR

Run each of the three as a Bash call of its own (`cd <worktree> && ` in front at most): chained to anything else they stay in the sandbox, and the guard denies that form. The guard hook asks before each of these; that is the code-level lock on top of the user's yes. Git's pre-push hook (`.githooks/pre-push`) rejects the push unless the pushed commit has the reviewer's PASS note, and the guard denies it early: a commit made after the review needs a new review (step 3 again). Never use `--no-verify`.

```bash
git push -u origin <branch>
scripts/review-status.sh publish
gh pr create --base main --title "<title>" --label "<label1>" --label "<label2>" --milestone "<milestone>" --body-file - <<'EOF'
<body>
EOF
```

`publish` posts the verdict as the `ai-review` commit status on GitHub; `main` requires it, so the PR cannot merge without it. One `--label` per issue label (all of them); omit `--label` / `--milestone` when the issue has none.

## 6. After

- Give the PR link. In the Claude desktop app, check the PR is bound to the session so CI status shows: `mcp__ccd_pr__get_status`, and `mcp__ccd_pr__bind_pr` with the PR URL if it is not (load both with ToolSearch if they are deferred).
- Never merge; the user merges on GitHub.
- After the merge: sync `main` in the main checkout (`git switch main && git pull --ff-only`) and remove the worktree with `scripts/worktree.sh remove <KEY>`.
