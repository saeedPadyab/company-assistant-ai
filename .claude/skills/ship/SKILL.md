---
name: ship
description: Finish an issue - commit, verify, run the reviewer, draft the PR, then push and open it after the user's yes. Use when the user says ship, open the PR, push this, or the work on an issue branch is done.
argument-hint: "[issue number]"
---

# Ship an issue

Order matters: never push or open a PR before verify is green, the reviewer said PASS and the user said yes. Claude never merges.

Run every command in the issue's worktree. If this session is in the main checkout and the work is in `../company-assistant-wt/<KEY>`, prefix commands with `cd <worktree path> && `.

## 1. Check the branch

```bash
git branch --show-current
git status --porcelain
git log origin/main..HEAD --oneline
```

- On `main`, or the branch is not `<type>/<KEY>-<slug>`: stop and offer `/work-on`.
- KEY comes from the branch (or the argument; they must match).
- Uncommitted changes: list the files and propose one commit `<KEY>: <what changed>`. Do not pick files yourself if some look unrelated; ask. Commit only after the user's yes. Never commit `.env` files.
- No commits ahead of `origin/main`: nothing to ship; stop.

## 2. Verify

```bash
scripts/verify.sh
```

Red: show the failing part and stop. The user decides whether you fix it now.

## 3. Review

Run the `reviewer` subagent with the issue number and the worktree path. Keep its full report.

- `VERDICT: FAIL`: show the Blockers with their scenarios and stop. When the user asks you to fix them: fix, commit with the `<KEY>: ` prefix, and run `/ship` again (it reviews the new state).
- `VERDICT: PASS`: show Should fix and Nit items and ask, for each group: fix now (then back to step 2) or leave them. Offer `/new-issue` for anything left that is worth doing later.

## 4. Draft the PR, wait for yes

```bash
gh issue view <KEY> --json title,labels,milestone
```

Title: `<KEY>: <issue title>` (shorten past about 70 characters). Body, in this order (same sections as `.github/pull_request_template.md`):

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

Show title, label, milestone (copied from the issue) and the body. Wait for the user's yes or corrections.

## 5. Push and open the PR

The guard hook asks before each of these; that is the code-level lock on top of the user's yes.

```bash
git push -u origin <branch>
gh pr create --base main --title "<title>" --label <label> --milestone <milestone> --body-file - <<'EOF'
<body>
EOF
```

Omit `--label` / `--milestone` when the issue has none.

## 6. After

- Give the PR link. In the Claude desktop app, bind the PR to the session (`mcp__ccd_pr__bind_pr` if the PR bar did not pick it up) so CI status shows.
- Never merge; the user merges on GitHub.
- After the merge: sync `main` in the main checkout (`git switch main && git pull --ff-only`) and remove the worktree with `scripts/worktree.sh remove <KEY>`.
