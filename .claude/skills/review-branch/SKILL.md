---
name: review-branch
description: Review a finished issue branch - commit what is left, then the review-loop workflow (QA runs verify.sh, then the reviewer, the fixer on Blockers). Use when the user says review, check the branch, or the work on an issue branch is done. Ends in a PASS on HEAD and offers /ship.
argument-hint: "[issue number]"
---

# Review an issue branch

First of three: `/review-branch` (this) → `/ship` (PR text, push, open the PR) → `/follow-pr` (CI, review, merge, cleanup). Nothing here leaves this machine: no push, no write to GitHub.

Run every command in the issue's worktree. If this session is in the main checkout and the work is in `.claude/worktrees/<KEY>`, switch into it first with `EnterWorktree` (`path`, see `/work-on` step 5); a `cd <worktree path> && ` prefix leaves `git commit` and Docker refused by the sandbox.

## 1. Check the branch, commit what is left

```bash
git branch --show-current
git status --porcelain
git log origin/main..HEAD --oneline
```

- On `main`, or the branch is not `<type>/<KEY>-<slug>`: stop and offer `/work-on`.
- KEY comes from the branch. If an argument is given and differs from the branch's KEY: stop and ask which is right.
- Uncommitted changes: list the files and propose one commit `<KEY>: <what changed>`. Do not pick files yourself if some look unrelated; ask. Commit only after the user's yes. Never commit `.env` files.
- No commits ahead of `origin/main`: nothing to review; stop.

There is no separate `scripts/verify.sh` step: the workflow's QA runs it once on the commit it reviews (step 2).

## 2. Review (the `review-loop` workflow)

First, when an earlier commit of this branch passed and every commit since changes only Markdown docs (not under a `.claude/` folder at any level, `.github/` or `.githooks/`, and no `CLAUDE.md`, `CLAUDE.local.md` or `AGENTS.md`; letter case does not matter), carry the verdict instead of a new review:

```bash
scripts/review-status.sh carry
```

It prints `carried PASS from <sha>` and exits 0, or refuses with the reason (code or tooling changed, a merge, no passed ancestor): then run the workflow below. A carried PASS still goes through `get` and step 3 as usual.

Run the `review-loop` workflow (Workflow tool, `name: "review-loop"`); running it is part of the user's request to review, so do not ask first:

```
args: { "key": <KEY>, "worktree": "<absolute worktree path>" }
```

Add `"since": "<sha>"` only for a follow-up review of new commits on top of a passed one: after Should fix or Nit commits (step 3), or a fix while the PR is open (`/follow-pr`). The `sha` is the PASS commit (from an earlier run of this session, or `scripts/review-status.sh get <sha>` prints `PASS` for it); the reviewer falls back to a full review when it is not.

The workflow decides the rounds in code (`.claude/workflows/review-loop.js`). Each round the `qa-verifier` runs `scripts/verify.sh` on HEAD and checks every acceptance criterion against a test or a check; only when verify is green on that commit does the `reviewer` review it. A red verify, or a QA run that returns nothing, stops the run with no review and no verdict. On FAIL the `fixer` fixes the Blockers (each with a test, `scripts/verify.sh`, one `<KEY>: ` commit), then QA and the `reviewer` check only the new commits; at most two fix rounds (`MAX_FIX_ROUNDS`). Do not run another round by hand. It returns `{ verdict, sha, readyForPr, stopReason, blockers, shouldFix, nits, rounds, finalReview, qa }`; `qa` is the last QA report (check its `sha`). Keep `finalReview`, `rounds` and `qa` for the PR body, then check the verdict on the commit:

```bash
scripts/review-status.sh get
```

## 3. Decide what is left

- No review happened (`finalReview` is null): verify was red, or QA failed. Show `stopReason` (and the failing part from `qa.verifyDetail`) and stop. The user decides whether you fix it now: fix, commit with the `<KEY>: ` prefix, then `/review-branch` again from step 1.
- `verdict` is `FAIL` (Blockers left after two fix rounds, the fixer could not fix them, or a fix commit was not reviewed): show `stopReason` and the Blockers with their scenarios, and stop. The user decides; a new fix after that is a new `/review-branch` run.
- `readyForPr` is true and `get` prints `PASS`: relay three to five lines (verdict, Blockers fixed, the QA outcome), never the reports. Show `shouldFix`, `nits` and the QA criteria marked `missing` once and ask, in one dialog, for each group: fix now or leave them. They never start a fix round by themselves. Fix now: fix, commit with the `<KEY>: ` prefix, then run the workflow once more with `since` set to the PASS `sha` (one follow-up review of the new commits); its own Should fix and Nit items are listed for the user, not fixed. Offer `/new-issue` for anything left that is worth doing later.
- Anything else (the workflow errors, `readyForPr` is false, or `get` does not print `PASS`): treat it as FAIL, say so, and stop. A missing verdict never allows `/ship`.
- Never record a verdict yourself; the guard hook denies it outside the `reviewer` agent. If the `reviewer`, `fixer` or `qa-verifier` agent or the `review-loop` workflow is not available in this session (they load when a session starts), stop and ask the user to start a new session: a stand-in subagent cannot record a verdict, so the push would be blocked.

When HEAD has its PASS and the user has decided on what is left, offer the next step in a dialog: _Draft the PR with `/ship` (Recommended)_ · _Not yet_.
