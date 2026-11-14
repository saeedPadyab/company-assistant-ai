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

Every fix, here or after the review, follows the same loop so that what is reviewed is what gets pushed: fix, commit with the `<KEY>: ` prefix, then run `/ship` again from step 1.

## 3. Review

Run the `reviewer` subagent with the issue number and the worktree path. Keep its full report. The reviewer records its verdict on HEAD (a git note, `scripts/review-status.sh`); then check it:

```bash
scripts/review-status.sh get
```

- `VERDICT: FAIL`: show the Blockers with their scenarios and stop. When the user asks you to fix them, use the fix loop above.
- `VERDICT: PASS` and `get` prints `PASS`: show Should fix and Nit items and ask, for each group: fix now (fix loop above; the new commits are reviewed again) or leave them. Offer `/new-issue` for anything left that is worth doing later.
- Anything else (the agent errors or times out, the report's last line is not exactly `VERDICT: PASS`, or `get` does not print `PASS`): treat it as FAIL, say so, and stop. A missing verdict never allows step 4.
- Never record a verdict yourself; the guard hook denies it outside the `reviewer` agent. If the `reviewer` agent is not available in this session (agents load when a session starts), stop and ask the user to start a new session: a stand-in subagent cannot record a verdict, so the push would be blocked.

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
VERDICT: PASS — <open Should fix / Nit items, or "no open items">

## Not tested
- <what could not be checked here, or "nothing">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Show title, labels, milestone (all copied from the issue) and the body. Wait for the user's yes or corrections.

## 5. Push and open the PR

The guard hook asks before each of these; that is the code-level lock on top of the user's yes. It also denies the push unless the pushed commit has the reviewer's PASS note: a commit made after the review needs a new review (fix loop above).

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
