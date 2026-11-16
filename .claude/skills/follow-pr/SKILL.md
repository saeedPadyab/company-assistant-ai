---
name: follow-pr
description: Follow an open issue PR to the end - Auto-fix, CI, the user's review and comments, merge, leftovers and worktree removal, each a dialog. Use after /ship opens the PR, when the user asks about an open PR's state, or when a ci-monitor event arrives.
argument-hint: "[PR number or link]"
---

# Follow a PR

Third of three: `/review-branch` (commit, QA and review) → `/ship` (PR text, push, open the PR) → `/follow-pr` (this). Claude never merges, approves or closes the PR; the user merges on GitHub.

The session walks fixed checkpoints, each a dialog (`AskUserQuestion`, recommended option first, see "Talking to the user" in `CLAUDE.md`). An unanswered dialog is not consent: end the turn with one line, `Waiting: <question>`, add `[input]` to the session title, and show the dialog again on the user's next message. The flow can be entered anywhere: a session that picks up an open PR reads `mcp__ccd_pr__get_status` and starts at the row that matches.

Load the PR tools with ToolSearch if they are deferred (`mcp__ccd_pr__get_status`, `mcp__ccd_pr__bind_pr`, `mcp__ccd_pr__set_monitor`). Never poll CI yourself (no `gh pr checks --watch`, no loops, no `/loop` or scheduled wakeups): the desktop app watches the PR.

A fix while the PR is open (a red check, a conflict, a comment the user wants fixed) goes the same way every time: fix, commit with the `<KEY>: ` prefix, `/review-branch` for the new commits (its QA runs `scripts/verify.sh`), then the later-push lines of `/ship` step 3 (`git push`, `scripts/review-status.sh publish`), back to 2.

| # | When | What the session does |
| --- | --- | --- |
| 1 | PR open | `get_status`; `bind_pr` with the PR URL if it reports no PR. Title `#<KEY> <subject> [PR][building]`. Dialog: *Turn on Auto-fix for PR #N?* — _Turn on (Recommended)_ → `set_monitor` with `auto_fix: true` and the URL: the app then wakes this session on a red check, a merge conflict or a review comment · _No_. Then end the turn with the PR link and one line: CI is running. |
| 2 | woken by a `<ci-monitor-event>`, or the user's next message | `get_status`. Checks still running: one line, end the turn. Red or a conflict: title `[PR][failed]` or `[PR][conflict]`, show the failing check, fix it (the fix path above), back to 1. Green → 3. |
| 3 | CI green | Title `[PR][input]`. Dialog: *PR #N is green — review it: <link>* — _Reviewed it_ → 4 · _Skip my review_ → 5 · _Later_ → end the turn. |
| 4 | after the user's review | Open comments: title `[PR][changes]` until they are handled. Read the open review threads (`gh pr view <N> --json reviews,comments`, and `gh api repos/{owner}/{repo}/pulls/<N>/comments` for line comments). One dialog per comment (up to 4 per dialog): _Fix_ (the fix path above) · _Reply_ (the draft in a scratchpad file sent with `SendUserFile`, posted only on this yes) · _Leave it_. Nothing open → 5. |
| 5 | reviewed, green, no open comments | Title `[PR][input]`. Dialog: *PR #N is ready to merge: <link>* — _Merged it_ → 6 · _Not yet_ → end the turn. Claude never merges. |
| 6 | merged (`get_status` says merged) | Title `[Merged]`. Leftovers, one question per item (up to 4 per dialog): open Should fix and Nit items, deferred work, unanswered comments, and every uncommitted, untracked or unpushed file or commit (`git status --porcelain --untracked-files=normal`, `git log --oneline HEAD --not --remotes`). Options: _Handle here_ · _New issue_ (`/new-issue`, created only after its own yes) · _Drop_. |
| 7 | nothing left (both commands print nothing) | Dialog: *Remove this worktree and its database?* — _Remove_ → first `ExitWorktree` with `action: "keep"` (it returns the session to the main checkout and never deletes a worktree entered with `path`), then in the main checkout, each a call of its own: `cd <main> && git switch main`, then `cd <main> && git pull --ff-only` (the guard denies `git pull` chained after anything but the `cd`), then `cd <main> && scripts/worktree.sh remove <KEY>`; a command that leaves the sandbox may still be refused from a session in another folder (Docker, `.git/worktrees`), so then run it in the user's Terminal panel (`mcp__terminal__run_in_terminal`, `cwd` the main checkout), then one line: archive this session from the sidebar · _Keep_. Title `[Done]`. |
