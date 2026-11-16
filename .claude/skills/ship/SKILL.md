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

First, when an earlier commit of this branch passed and every commit since changes only Markdown docs (not `.claude/`, `.github/`, `.githooks/` or any `CLAUDE.md`), carry the verdict instead of a new review:

```bash
scripts/review-status.sh carry
```

It prints `carried PASS from <sha>` and exits 0, or refuses with the reason (code or tooling changed, a merge, no passed ancestor): then run the workflow below. A carried PASS still goes through `get` and step 4 as usual.

Run the `ship-branch` workflow (Workflow tool, `name: "ship-branch"`); running it is part of the user's request to ship, so do not ask first:

```
args: { "key": <KEY>, "worktree": "<absolute worktree path>" }
```

Add `"since": "<sha>"` only for the one follow-up review after Should fix or Nit commits (below): the `sha` an earlier run of this session returned with PASS.

The workflow decides the rounds in code: the `reviewer` reviews HEAD; on FAIL the `fixer` fixes the Blockers (each with a test, `scripts/verify.sh`, one `<KEY>: ` commit) and the `reviewer` reviews only the new commits; at most two fix rounds (`MAX_FIX_ROUNDS` in `.claude/workflows/ship-branch.js`). Beside each review the `qa-verifier` runs `scripts/verify.sh` on that HEAD and checks every acceptance criterion against a test or a check; it is advisory (it never changes the verdict), but a red `verify.sh` makes `readyForPr` false. Do not run another round by hand. It returns `{ verdict, sha, readyForPr, stopReason, blockers, shouldFix, nits, rounds, finalReview, qa }`; `qa` is the last QA report (`null` when the agent failed: say so). Keep `finalReview` and `rounds` for the PR body, then check the verdict on the commit:

```bash
scripts/review-status.sh get
```

- `verdict` is `FAIL` (Blockers left after two fix rounds, or the fixer could not fix them): show `stopReason` and the Blockers with their scenarios, and stop. The user decides; a new fix after that is a new `/ship` run.
- `readyForPr` is true and `get` prints `PASS`: relay three to five lines (verdict, Blockers fixed, the QA outcome), never the reports. Show `shouldFix`, `nits` and the QA criteria marked `missing` once and ask, in one dialog, for each group: fix now or leave them. They never start a fix round by themselves. Fix now: fix, commit with the `<KEY>: ` prefix, `scripts/verify.sh`, then run the workflow once more with `since` set to the PASS `sha` (one follow-up review of the new commits); its own Should fix and Nit items are listed for the user, not fixed. Offer `/new-issue` for anything left that is worth doing later.
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
VERDICT: PASS — <review/fix rounds from the workflow, or "carried from <sha12>"; open Should fix / Nit items, or "no open items">
QA: <verify.sh result at the reviewed SHA; criteria covered / manual / missing>

## Not tested
- <what could not be checked here, or "nothing">

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Write title, labels, milestone (all copied from the issue) and the body to a scratchpad file, send it with `SendUserFile`, and ask with a dialog: _Push and open the PR (Recommended)_ · _Change it_ (the corrections come in "Other"). Wait for the yes.

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

## 6. Checkpoints after the PR

From here the session walks fixed checkpoints, each a dialog (`AskUserQuestion`, recommended option first, see "Talking to the user" in `CLAUDE.md`). An unanswered dialog is not consent: end the turn with one line, `Waiting: <question>`, add `[input]` to the session title, and show the dialog again on the user's next message. The flow can be entered anywhere: a session that picks up an open PR reads `mcp__ccd_pr__get_status` and starts at the row that matches.

Load the PR tools with ToolSearch if they are deferred (`mcp__ccd_pr__get_status`, `mcp__ccd_pr__bind_pr`, `mcp__ccd_pr__set_monitor`). Never poll CI yourself (no `gh pr checks --watch`, no loops, no `/loop` or scheduled wakeups): the desktop app watches the PR.

| # | When | What the session does |
| --- | --- | --- |
| 1 | PR open | `get_status`; `bind_pr` with the PR URL if it reports no PR. Title `#<KEY> <subject> [PR][building]`. Dialog: *Turn on Auto-fix for PR #N?* — _Turn on (Recommended)_ → `set_monitor` with `auto_fix: true` and the URL: the app then wakes this session on a red check, a merge conflict or a review comment · _No_. Then end the turn with the PR link and one line: CI is running. |
| 2 | woken by a `<ci-monitor-event>`, or the user's next message | `get_status`. Checks still running: one line, end the turn. Red or a conflict: title `[PR][failed]` or `[PR][conflict]`, show the failing check, fix it (commit, `scripts/verify.sh`, the review of section 3 for the new commits, the push of section 5), back to 1. Green → 3. |
| 3 | CI green | Title `[PR][input]`. Dialog: *PR #N is green — review it: <link>* — _Reviewed it_ → 4 · _Skip my review_ → 5 · _Later_ → end the turn. |
| 4 | after the user's review | Read the open review threads (`gh pr view <N> --json reviews,comments`, and `gh api repos/{owner}/{repo}/pulls/<N>/comments` for line comments). One dialog per comment (up to 4 per dialog): _Fix_ (a new commit: verify, section 3 for the new commits, push, back to 2) · _Reply_ (the draft in a scratchpad file sent with `SendUserFile`, posted only on this yes) · _Leave it_. Nothing open → 5. |
| 5 | reviewed, green, no open comments | Title `[PR][input]`. Dialog: *PR #N is ready to merge: <link>* — _Merged it_ → 6 · _Not yet_ → end the turn. Claude never merges. |
| 6 | merged (`get_status` says merged) | Title `[Merged]`. Leftovers, one question per item (up to 4 per dialog): open Should fix and Nit items, deferred work, unanswered comments, and every uncommitted, untracked or unpushed file or commit (`git status --porcelain --untracked-files=normal`, `git log --oneline HEAD --not --remotes`). Options: _Handle here_ · _New issue_ (`/new-issue`, created only after its own yes) · _Drop_. |
| 7 | nothing left (both commands print nothing) | Dialog: *Remove this worktree and its database?* — _Remove_ → in the main checkout `git switch main && git pull --ff-only`, then `scripts/worktree.sh remove <KEY>` (on its own; it needs Docker, so if the sandbox refuses it, run it in the user's Terminal panel), then one line: archive this session from the sidebar · _Keep_. Title `[Done]`. |

Never merge, approve or close the PR; the user merges on GitHub.
