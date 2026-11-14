#!/usr/bin/env python3
"""PreToolUse guard for Bash commands.

Claude Code pipes the tool call as JSON on stdin. This script:
  - exit 2 + a reason on stderr  -> the command is blocked, Claude sees the reason
  - prints a JSON "ask" decision  -> the user is asked, whatever the permission rules say
  - exit 0 with no output         -> normal permission flow
If this script crashes, the command is denied.

Two layers:
  1. Raw text. Three things are dangerous wherever they appear, inside quotes, `$(...)` or
     backticks included, so they are matched on the whole command text before any parsing:
     `--no-veri...` (skips the pre-push hook), hooksPath / include.path / [core] removal (turns
     it off), and, outside the reviewer, a write to the verdict ref (`notes ... add|append|...` or
     `update-ref` with `ai-review`, `review-status.sh record`). The cost: those words cannot appear
     in an inline commit message or PR body; write such text to a file and pass it with -F.
  2. Parsed command. The rest work on the parsed command, so word order and flags
     (`pnpm --filter server add x`, `git push origin HEAD:main`) do not get around them.
     Subshells and groups, shell keywords (`if`, `then`), wrappers (`timeout 60`, `nice`,
     `sudo -u x`, `env X=1`) and package runners (`pnpm exec`, `npx`) are split off or stripped;
     in a command that is not git itself (`pnpm git push`), every later `git` word is checked as
     a git command. `xargs`, `find -exec`, `bash -c` and `eval` cannot be parsed, so a push inside
     them is denied. Git aliases are denied where they are set, and an existing alias that may
     push, write notes or change hooks is denied where it is used.

Review gate (issue #3): the lock on pushes is git's own pre-push hook (.githooks/pre-push), which
git runs however the push was started. A verdict note names the commit it was written for, so a
note git copies to another commit (amend or rebase with notes.rewriteRef, from the command or from
~/.gitconfig) does not count. This guard denies what would switch it off (above, plus shell or
git writes to .githooks/, .git/config, .git/refs/ and .git/packed-refs, which hold the verdict
note, and to .claude/settings*.json, where `disableAllHooks` turns this guard off; the Edit and
Write tools on those settings files are denied in .claude/settings.json), checks before any push
that git will run it, and gives an early, readable deny for a push without the reviewer's PASS
note. These paths are matched as text anywhere in a writer's arguments, so a copy out of them
(`cp .git/refs/notes/ai-review /tmp/x`) is denied too, on purpose; reading them (`cat`) is not.
Only the `reviewer` subagent (hook input `agent_type`) may write the note.
`review-status.sh publish` writes to GitHub, so it asks.

Threat model (issue #3): in scope is Claude pushing or recording a verdict by mistake or as a
shortcut, in any ordinary way of writing the command. This guard reads only command text, so it
cannot see a script, Makefile target or inline interpreter (`python3 -c`, `node -e`), words built
from pieces (`R=ai; $R-review`, `--no-$V`, `ai-'review'`), a command name in a variable
(`S=scripts/review-status.sh; $S record`), a path built at run time
(`$(git rev-parse --git-common-dir)/refs`), a path relative to a folder entered first
(`cd .git/refs/notes && cp mine ai-review`) or a copy into a parent folder (`cp -r /tmp/refs .git/`).

Closed by the Bash sandbox (issue #9, `sandbox` in .claude/settings.json; see CLAUDE.md): every
sandboxed command, however it is written, cannot write .githooks/, .git/config, .git/hooks/,
.git/refs/notes/ or .git/packed-refs (also in a worktree's shared git dir, through the
`//**/.git/...` deny rules), .claude settings, hooks and skills, or anything outside the project and
$TMPDIR. So the cases above can no longer write the note, the hooks or git config, or edit
.claude/settings*.json. The Edit and Write tools run outside the sandbox and are denied on .git and
.githooks paths in .claude/settings.json.

Still open, the known limits: `excludedCommands` (git push/fetch/pull, gh, docker compose,
scripts/worktree.sh, scripts/review-status.sh) run unsandboxed and are matched on text, so for them
this guard is the only check (a compose file edited in the repo runs unsandboxed through
`docker compose`); a script that runs `git push --no-verify` is sandboxed but may reach GitHub,
since in auto mode unlisted hosts were reachable (`network.strictAllowlist` lives in user or
managed settings, not here); hooks and MCP servers run outside the sandbox. The main session writes
the reviewer's prompt, so it could talk the reviewer into a PASS. The GitHub `ai-review` status is
built from the same local note, so it makes the verdict visible and required on the PR; it is not
an independent check.

Tests: python3 .claude/hooks/test_guard.py (run by scripts/verify.sh).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys

PROTECTED = {"main", "master"}

# Commands that print or load a file's contents
READERS = {
    "cat", "less", "more", "head", "tail", "bat", "nl", "strings", "xxd", "od", "hexdump",
    "base64", "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "cut", "sort", "uniq",
    "diff", "source", ".", "tac", "column", "jq", "yq", "open", "code", "vim", "vi", "nano",
}
DEP_CHANGE = {"add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade"}
# pnpm/npm/yarn options that take a value (so the value is not read as the subcommand)
PM_VALUE_OPTS = {"--filter", "-F", "-C", "--dir", "--prefix", "--workspace", "--cwd"}
GIT_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
PUSH_VALUE_OPTS = {"--repo", "-o", "--push-option", "--receive-pack", "--exec"}
# gh: anything that is not a read writes to GitHub and needs the user's yes
GH_VALUE_OPTS = {"-R", "--repo", "--hostname"}
GH_READ_ACTIONS = {"list", "view", "status", "diff", "checks", "watch", "download", "checkout"}
GH_FREE_GROUPS = {"search", "browse", "help", "version", "completion"}
GH_API_FIELD_OPTS = {"-f", "-F", "--field", "--raw-field", "--input"}
# Review gate: the reviewer's verdict is a git note on the commit (scripts/review-status.sh)
REVIEW_NOTES_REF = "ai-review"
REVIEWER_AGENT = "reviewer"
NOTES_READ_ACTIONS = {"show", "list", "get-ref"}
GIT_READ_SUBS = {"log", "show", "rev-parse", "status", "diff"}
RECORD_DENIED = ("Only the reviewer subagent records a review verdict. Run the `reviewer` agent on this branch; "
                 "it reviews HEAD and records PASS or FAIL itself.")
PM_HEADS = {"pnpm", "npm", "yarn", "bun"}
PM_RUNNERS = {"exec", "dlx", "x"}
# Paths that turn the pre-push check off when edited from the shell: the hook, the git config,
# the refs that hold the verdict note, and the Claude settings that can switch this guard off
HOOK_PATHS = (".githooks", ".git/config", ".git/hooks", ".git/worktrees", ".git/refs", ".git/packed-refs",
              ".claude/settings")
# git builtins never resolve to an alias (git does not let an alias shadow them)
GIT_BUILTINS = {
    "add", "am", "apply", "bisect", "blame", "branch", "checkout", "cherry-pick", "clean", "clone", "commit",
    "config", "describe", "diff", "fetch", "format-patch", "gc", "grep", "init", "log", "ls-files", "ls-remote",
    "merge", "merge-base", "mv", "notes", "pull", "push", "rebase", "reflog", "remote", "reset", "restore",
    "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "stash", "status", "switch", "tag",
    "update-ref", "worktree", "symbolic-ref", "cat-file", "for-each-ref", "help", "version",
}
ALIAS_RISK = re.compile(r"push|notes|update-ref|ai-review|hookspath|!", re.IGNORECASE)
HOOK_WRITERS = {"rm", "mv", "cp", "chmod", "ln", "tee", "truncate", "unlink", "install", "perl", "dd", "rsync"}
# Commands that run another command given as arguments: the guard cannot parse what they run
EXEC_HEADS = {"xargs", "find", "bash", "sh", "zsh", "dash", "eval", "parallel", "watch", "script", "su", "fd"}
# Prefixes dropped before the real command; value: options of theirs that take a value
WRAPPERS = {
    "sudo": {"-u", "-g", "-C", "-D", "-p", "-U", "-h", "-r", "-t", "-T"}, "env": {"-u", "-C", "-S"},
    "command": set(), "exec": set(), "time": set(), "nohup": set(),
    "npx": {"-p", "--package", "-c", "--call"}, "pnpx": set(), "bunx": {"-p", "--package"},
    "if": set(), "then": set(), "else": set(), "elif": set(), "do": set(), "while": set(), "until": set(), "!": set(),
    "timeout": {"-k", "--kill-after", "-s", "--signal"}, "nice": {"-n", "--adjustment"},
    "stdbuf": {"-i", "-o", "-e"}, "ionice": {"-c", "-n", "-p"},
}


SEPARATORS = {";", "&&", "||", "|", "&", "|&", ";;", "\n", "{", "}"}
SEPARATOR_RUN = re.compile(r"[;&|()\n]+")  # shlex joins adjacent punctuation: `);`, `)&&`, `((`


def segments_of(command: str) -> list[list[str]]:
    """The command's simple commands as token lists, split on ; && || | & and newlines outside quotes.
    Redirections come out as their own tokens (`<`, `>`, `2>&1` -> `2`, `>&`, `1`)."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>()\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        tokens = list(lexer)
    except ValueError:  # unbalanced quotes: fall back to a plain split
        tokens = re.split(r"\s+|(?=[;&|()\n])|(?<=[;&|()\n])", command)
    segments, current = [], []
    for tok in tokens:
        if tok in SEPARATORS or SEPARATOR_RUN.fullmatch(tok):
            segments.append(current)
            current = []
        elif tok:
            current.append(tok)
    segments.append(current)
    # a segment of only `X=1` strips to nothing: drop it after stripping, not before
    return [t for t in (strip_prefix(s) for s in segments) if t]


def strip_prefix(tokens: list[str]) -> list[str]:
    """Drop leading VAR=value assignments and wrappers (`sudo`, `env`, `timeout 60`, `nice -n 5`, ...)."""
    while tokens:
        head = os.path.basename(tokens[0])
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]):
            tokens = tokens[1:]
            continue
        if head in PM_HEADS:  # `pnpm exec x`, `pnpm --filter s dlx x`, `npm exec -- x`: the command is x
            i = 1
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 2 if tokens[i] in PM_VALUE_OPTS else 1
            if i >= len(tokens) or tokens[i] not in PM_RUNNERS:
                break
            tokens = tokens[i + 1:]
            while tokens and tokens[0].startswith("-"):
                tokens = tokens[1:]
            continue
        if head not in WRAPPERS:
            break
        value_opts, i = WRAPPERS[head], 1
        while i < len(tokens) and tokens[i].startswith("-"):
            i += 2 if tokens[i] in value_opts else 1
        if head == "timeout" and i < len(tokens):
            i += 1  # the duration
        tokens = tokens[i:]
    return tokens


def current_branch(cwd: str | None) -> str | None:
    try:
        result = subprocess.run(["git", "branch", "--show-current"], cwd=cwd or None,
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None if result.returncode == 0 else None


def git_subcommand(tokens: list[str]) -> tuple[str | None, list[str]]:
    """('push', [args...]) for `git -C x push ...`; (None, []) when not a git command."""
    if not tokens or os.path.basename(tokens[0]) != "git":
        return None, []
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        if tok in GIT_VALUE_OPTS:
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return tok, tokens[i + 1:]
    return None, []


def is_env_file(token: str) -> bool:
    name = os.path.basename(token.rstrip("/"))
    return name.startswith(".env") and name != ".env.example"


def review_verdict(rev: str, cwd: str | None) -> str:
    """PASS, FAIL or NONE: the reviewer's note on the commit `rev` names; UNKNOWN when `rev` is not a commit."""
    def git(*a: str) -> subprocess.CompletedProcess | None:
        try:
            return subprocess.run(["git", *a], cwd=cwd or None, capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return None
    sha = git("rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    if not sha or sha.returncode != 0:
        return "UNKNOWN"
    commit = sha.stdout.strip()
    note = git("notes", f"--ref={REVIEW_NOTES_REF}", "show", commit)
    lines = note.stdout.splitlines() if note and note.returncode == 0 else []
    if f"commit: {commit}" not in lines:  # no note, or one git copied here from another commit
        return "NONE"
    return {"VERDICT: PASS": "PASS", "VERDICT: FAIL": "FAIL"}.get(lines[0].strip(), "NONE")


def names_review_ref(tokens: list[str]) -> bool:
    """True when a token names the verdict ref: refs/notes/ai-review, --ref[=] ai-review, --notes=ai-review,
    or a notes.* config key/value with it. Plain text such as a commit message or branch name does not count."""
    for i, tok in enumerate(tokens):
        if REVIEW_NOTES_REF not in tok:
            continue
        prev = tokens[i - 1] if i else ""
        if ("notes/" + REVIEW_NOTES_REF in tok or tok.startswith(("--ref=", "--notes=", "notes."))
                or tok.lower().startswith("core.notesref=")
                or prev in {"--ref", "--notes"} or (prev.startswith("notes.") and "=" not in prev)
                or prev.lower() == "core.notesref"):
            return True
    return False


def notes_action(args: list[str]) -> str:
    """The `git notes` subcommand (default: list), skipping options and the --ref value."""
    i = 0
    while i < len(args):
        if args[i] == "--ref":
            i += 2
        elif args[i].startswith("-"):
            i += 1
        else:
            return args[i]
    return "list"


def pre_push_off(cwd: str | None) -> str | None:
    """Why git would not run .githooks/pre-push here, or None when it would."""
    def git(*a: str) -> str | None:
        try:
            r = subprocess.run(["git", *a], cwd=cwd or None, capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return r.stdout.strip() if r.returncode == 0 else None
    top = git("rev-parse", "--show-toplevel")
    if top is None:
        return None  # not a repository: git push fails on its own
    hooks = git("config", "--get", "core.hooksPath")
    if not hooks:
        return "core.hooksPath is not set"
    hook = os.path.join(top, os.path.expanduser(hooks), "pre-push")
    if not (os.path.isfile(hook) and os.access(hook, os.X_OK)):
        return (f"{hook} is missing or not executable; on a branch cut before the hook existed, "
                "rebase on origin/main")
    return None


def alias_of(name: str, cwd: str | None) -> str | None:
    """The expansion of git alias `name` in `cwd`, or None."""
    try:
        r = subprocess.run(["git", "config", "--get", f"alias.{name}"], cwd=cwd or None,
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def check_review_record(tokens: list[str], agent_type: str | None) -> tuple[str, str] | None:
    """Only the reviewer subagent writes verdicts (refs/notes/ai-review); publishing one asks."""
    for i, tok in enumerate(tokens[:-1]):
        if os.path.basename(tok) == "review-status.sh" and tokens[i + 1] == "publish":
            return "ask", "review-status.sh publish posts the `ai-review` commit status to GitHub. Confirm the commit."
    if agent_type == REVIEWER_AGENT:
        return None
    head = os.path.basename(tokens[0])
    # `bash -c '... record ...'`, `xargs scripts/review-status.sh record`: match inside tokens too
    if any(re.search(r"review-status\.sh['\"]?\s+['\"]?record\b", t) for t in tokens) or any(
            os.path.basename(t) == "review-status.sh" and nxt == "record" for t, nxt in zip(tokens, tokens[1:])):
        return "deny", RECORD_DENIED
    if head in EXEC_HEADS:
        # the command it runs is a string or arguments we do not parse: any mention of the ref with notes is enough
        if any(REVIEW_NOTES_REF in t for t in tokens) and any(re.search(r"notes|update-ref|config", t) for t in tokens):
            return "deny", RECORD_DENIED
        return None
    sub, args = git_subcommand(tokens)
    if sub == "notes" and notes_action(args) not in NOTES_READ_ACTIONS and any(
            ("$" in t or "`" in t) and (t.startswith("--ref=") or p == "--ref") for p, t in zip([""] + args, args)):
        return "deny", "A `git notes` write with a variable --ref cannot be checked. Name the ref literally."
    if sub is None or not names_review_ref(tokens):
        return None
    if names_review_ref(tokens[:len(tokens) - len(args) - 1]):  # `git -c notes.rewriteRef=... <sub>`
        return "deny", RECORD_DENIED
    if sub in GIT_READ_SUBS or (sub == "notes" and notes_action(args) in NOTES_READ_ACTIONS):
        return None
    return "deny", RECORD_DENIED


def check_push(args: list[str], branch: str | None, cwd: str | None = None,
               verdict_of=review_verdict) -> tuple[str, str]:
    """('deny'|'ask', reason) for `git push <args>`."""
    if (off := pre_push_off(cwd)):
        return "deny", f"The pre-push review check is off ({off}). Run scripts/worktree.sh setup, then push."
    positional = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in PUSH_VALUE_OPTS:
            i += 2
            continue
        if arg.startswith("--force") or arg == "-f" or (re.fullmatch(r"-[A-Za-z]+", arg) and "f" in arg):
            return "deny", "No force push. Push a new commit instead."
        if arg in {"--all", "--mirror"}:
            return "deny", f"`git push {arg}` would push {'/'.join(sorted(PROTECTED))}. Push one feature branch."
        if arg.startswith("--no-veri"):
            return "deny", "No --no-verify: it skips the pre-push review check. Get the reviewer's PASS, then push."
        if arg in {"--tags", "--follow-tags"}:
            return "deny", f"`git push {arg}` pushes tagged commits the review gate does not check. Push the branch."
        if arg.startswith("-"):
            i += 1
            continue
        positional.append(arg)
        i += 1
    refspecs = positional[1:]  # positional[0] is the remote
    for spec in refspecs:
        if spec.startswith("+"):
            return "deny", "No force push (a '+' refspec forces). Push a new commit instead."
        dst = spec.split(":", 1)[1] if ":" in spec else spec
        dst = dst.removeprefix("refs/heads/")
        if dst in PROTECTED:
            return "deny", f"Never push {dst}. Push a feature branch and open a PR."
    if not refspecs and branch in PROTECTED:
        return "deny", f"You are on {branch}: this push would update it. Create a feature branch from origin/main and open a PR."
    # Review gate: every pushed commit needs the reviewer's PASS note (deletions `:dst` push nothing)
    sources = [s.split(":", 1)[0] for s in refspecs] if refspecs else ["HEAD"]
    for src in (s for s in sources if s):
        verdict = verdict_of(src, cwd)
        if verdict == "PASS":
            continue
        if verdict == "UNKNOWN":
            return "deny", f"Could not resolve `{src}` to a commit, so its review verdict cannot be checked. Push a branch name or HEAD."
        why = "the reviewer failed it" if verdict == "FAIL" else "it has no review verdict (new commits need a new review)"
        return "deny", (f"Push blocked: `{src}` is not reviewed: {why}. Run the `reviewer` agent on this branch; "
                        f"it records the verdict with scripts/review-status.sh. Push only after PASS.")
    return "ask", "git push sends code off this machine. Confirm the branch and remote."


def check_gh(tokens: list[str]) -> tuple[str, str] | None:
    """('deny'|'ask', reason) for a gh command that writes to GitHub; None for reads."""
    words, i = [], 1
    while i < len(tokens):
        tok = tokens[i]
        if tok in GH_VALUE_OPTS:
            i += 2
            continue
        if not tok.startswith("-"):
            words.append(tok)
            if len(words) == 2:
                break
        i += 1
    if not words or words[0] in GH_FREE_GROUPS:
        return None
    group, action = words[0], (words[1] if len(words) > 1 else None)

    if group == "pr" and action == "merge":
        return "deny", "Claude never merges. Tell the user the PR is ready; they merge it on GitHub."
    if group == "api":
        args = tokens[1:]  # flags may come before or after the endpoint
        method = None
        for j, tok in enumerate(args):
            if tok in {"-X", "--method"} and j + 1 < len(args):
                method = args[j + 1].upper()
            elif tok.startswith("--method="):
                method = tok.split("=", 1)[1].upper()
            elif re.fullmatch(r"-X[A-Za-z]+", tok):
                method = tok[2:].upper()
        has_fields = any(t in GH_API_FIELD_OPTS or t.startswith(("--field=", "--raw-field=", "--input=")) for t in args)
        if (method or ("POST" if has_fields else "GET")) != "GET":
            return "ask", "This gh api call writes to GitHub. Confirm the endpoint and the change."
        return None
    if action is None or action in GH_READ_ACTIONS:
        return None
    return "ask", f"`gh {group} {action}` writes to GitHub. Confirm what will be created or changed."


def check_segment(tokens: list[str], branch: str | None, cwd: str | None = None,
                  agent_type: str | None = None, verdict_of=review_verdict) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    if not tokens:
        return found
    head = os.path.basename(tokens[0])

    if record := check_review_record(tokens, agent_type):
        found.append(record)
    sets_hooks = (head == "git" and any(t.lower().startswith("core.hookspath") for t in tokens)) or (
        head in EXEC_HEADS and any("hookspath" in t.lower() for t in tokens))
    if sets_hooks and not ({"--get", "--get-all", "-l", "--list"} & set(tokens)):
        found.append(("deny", "core.hooksPath turns the pre-push review check on or off. Leave it as `.githooks`."))
    def hook_path(t: str) -> bool:
        return any(h in t for h in HOOK_PATHS)
    writes = head in HOOK_WRITERS or (head == "sed" and any(t.startswith(("-i", "--in-place")) for t in tokens))
    if writes and any(hook_path(t) for t in tokens[1:]) or any(
            t in {">", ">>", ">|"} and hook_path(nxt) for t, nxt in zip(tokens, tokens[1:])):
        found.append(("deny", ".githooks/, .git/config, .git/refs and .claude/settings*.json decide whether the review "
                              "check runs. Change .githooks/ in an issue and PR; leave .git/ to git commands; "
                              "the user edits .claude/settings*.json."))
    git_sub, _ = git_subcommand(tokens)
    if git_sub in {"rm", "mv", "restore", "checkout", "update-index"} and any(hook_path(t) for t in tokens):
        found.append(("deny", ".githooks/, .git/config, .git/hooks, .git/refs and .claude/settings*.json decide "
                              "whether the review check runs. "
                              "Change .githooks/ in an issue and PR; the user edits .claude/settings*.json."))
    if git_sub == "config" and ({"--remove-section", "--rename-section"} & set(tokens)) and any(
            t.lower() == "core" or t.lower().startswith("core.") for t in tokens):
        found.append(("deny", "Removing the [core] section turns the pre-push review check off."))
    if head == "git" and any(t.lower().startswith("alias.") for t in tokens) and not (
            {"--get", "--get-all", "--get-regexp", "-l", "--list"} & set(tokens)):
        found.append(("deny", "No git aliases: the guard cannot see what an alias runs. Write the full git command."))
    if head in EXEC_HEADS and any(t.lower().startswith("alias.") or "alias." in t for t in tokens):
        found.append(("deny", "No git aliases: the guard cannot see what an alias runs. Write the full git command."))
    if head in EXEC_HEADS and re.search(r"(^|\s)(\S*/)?git\s(.*\s)?push\b", " ".join(tokens)):
        found.append(("deny", f"Run `git push` directly, not through `{head}`, so the guard can check the branch and the review."))

    # .env contents through the shell (Read(...) deny rules only cover the Read tool)
    if head in READERS and any(is_env_file(t) for t in tokens[1:]):
        found.append(("deny", "Reading .env files is blocked: they hold real secrets. Use .env.example for the variable names."))
    for i, tok in enumerate(tokens[:-1]):
        if tok == "<" and is_env_file(tokens[i + 1]):
            found.append(("deny", "Reading .env files is blocked: they hold real secrets. Use .env.example for the variable names."))
    if head in {"cp", "mv", "scp", "rsync"} and any(is_env_file(t) for t in tokens[1:-1]):
        found.append(("deny", "Copying .env files is blocked: they hold real secrets."))

    sub, args = git_subcommand(tokens)
    if head == "git" and sub and sub not in GIT_BUILTINS and (expansion := alias_of(sub, cwd)) is not None:
        # an alias defined earlier (or in ~/.gitconfig): deny it when it may push, write notes or switch hooks
        if ALIAS_RISK.search(expansion):
            found.append(("deny", f"`git {sub}` is an alias for `{expansion}`, which the guard cannot check. "
                                  "Write the full git command."))
    if sub == "push":
        found.append(check_push(args, branch, cwd, verdict_of))
    elif sub == "commit" and branch in PROTECTED:
        found.append(("deny", f"Never commit on {branch}. Create a branch from origin/main first: git switch -c <branch> origin/main"))
    elif sub == "reset" and "--hard" in args:
        found.append(("ask", "git reset --hard throws away uncommitted work."))

    if head in {"pnpm", "npm", "yarn"}:
        i, pm_sub = 1, None
        while i < len(tokens):
            tok = tokens[i]
            if tok in PM_VALUE_OPTS:
                i += 2
                continue
            if tok.startswith("-"):
                i += 1
                continue
            pm_sub = tok
            break
        rest = [t for t in tokens[i + 1:] if not t.startswith("-")] if pm_sub else []
        if pm_sub in DEP_CHANGE or (pm_sub in {"install", "i"} and rest):
            found.append(("ask", "This changes dependencies and the lockfile. Confirm the package and the workspace."))
        if "db:seed" in tokens:
            found.append(("ask", "db:seed may overwrite local database data."))

    if head == "gh" and (gh := check_gh(tokens)):
        found.append(gh)

    if head in {"docker", "docker-compose"} and "down" in tokens and ({"-v", "--volumes"} & set(tokens)):
        found.append(("ask", "docker compose down -v deletes the database volume."))
    return found


def git_dir_option(tokens: list[str]) -> str | None:
    """The directory of `git -C <dir> ...`, if given."""
    for i, tok in enumerate(tokens[1:-1], start=1):
        if tok == "-C":
            return tokens[i + 1]
        if not tok.startswith("-"):
            return None
    return None


NOTES_WRITE = re.compile(r"\bnotes\b.*\b(add|append|edit|copy|remove|merge|prune)\b|\bupdate-ref\b|notesref", re.S | re.I)


def scan_raw(command: str, agent_type: str | None) -> list[tuple[str, str]]:
    """Layer 1: the dangerous words anywhere in the text, quotes and $(...) included."""
    found = []
    if "--no-veri" in command:
        found.append(("deny", "No --no-verify, anywhere in a command: it skips the pre-push review check. "
                              "Get the reviewer's PASS, then push. (Text that mentions it goes in a file: -F.)"))
    lower = command.lower()
    reads_hooks = re.fullmatch(r"\s*git\s+config\s+(--get|get)\s+core\.hookspath\s*", lower)
    if (("hookspath" in lower and not reads_hooks) or "include.path" in lower or "includeif" in lower
            or re.search(r"(remove|rename)-section\s+['\"]?core\b", lower)):
        found.append(("deny", "core.hooksPath, include.path and the [core] section decide whether the pre-push "
                              "review check runs; they are not changed from Claude. (Text that mentions them goes in a file: -F.)"))
    if re.search(r"rewriteref|notes_rewrite|notes\.rewrite", lower):
        found.append(("deny", "notes.rewriteRef / GIT_NOTES_REWRITE_REF copy notes onto rewritten commits; "
                              "they are not set from Claude. (Text that mentions them goes in a file: -F.)"))
    if "statuses" in lower and REVIEW_NOTES_REF in command and "review-status.sh" not in command:
        found.append(("deny", "The `ai-review` commit status is posted only by scripts/review-status.sh publish."))
    if agent_type != REVIEWER_AGENT and REVIEW_NOTES_REF in command and NOTES_WRITE.search(command):
        found.append(("deny", RECORD_DENIED + " (Text that mentions the verdict ref with notes or update-ref goes in a file: -F.)"))
    return found


def decide(command: str, cwd: str | None, branch_of=current_branch, agent_type: str | None = None,
           verdict_of=review_verdict) -> tuple[str, str] | None:
    """Follows `cd <dir>` and `git -C <dir>` so a commit in a worktree is checked against that worktree's branch."""
    results: list[tuple[str, str]] = []
    cache: dict[str | None, str | None] = {}

    def branch_in(path: str | None) -> str | None:
        if path not in cache:
            cache[path] = branch_of(path)
        return cache[path]

    results.extend(scan_raw(command, agent_type))
    # env assignments are stripped from segments, so check them on the raw text:
    # GIT_NOTES_REF=refs/notes/ai-review, GIT_CONFIG_VALUE_0=..., or R=ai-review used later as $R
    if agent_type != REVIEWER_AGENT and re.search(
            r"(^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=['\"]?[^\s;&|]*" + re.escape(REVIEW_NOTES_REF), command):
        results.append(("deny", RECORD_DENIED))
    if re.search(r"(^|[\s;&|(])[A-Za-z_][A-Za-z0-9_]*=['\"]?[^\s;&|]*(hookspath|alias\.)", command, re.IGNORECASE):
        results.append(("deny", "core.hooksPath and git aliases are set only with plain git commands the guard can read."))
    for tokens in segments_of(command):
        if tokens[0] == "cd" and len(tokens) > 1:
            cwd = os.path.join(cwd or os.getcwd(), os.path.expanduser(tokens[1]))
            continue
        where = cwd
        if os.path.basename(tokens[0]) == "git" and (d := git_dir_option(tokens)):
            where = os.path.join(cwd or os.getcwd(), os.path.expanduser(d))
        results.extend(check_segment(tokens, branch_in(where), where, agent_type, verdict_of))
        # `pnpm git push`, `sudo -u me git ...`, `make GIT=git ...`: a runner the guard does not know may
        # run the git that follows it, so check from every later `git` word as well
        if os.path.basename(tokens[0]) != "git":
            for j in range(1, len(tokens)):
                if os.path.basename(tokens[j]) == "git":
                    results.extend(check_segment(tokens[j:], branch_in(where), where, agent_type, verdict_of))
    for kind in ("deny", "ask"):
        reasons = [r for k, r in results if k == kind]
        if reasons:
            return kind, " ".join(dict.fromkeys(reasons))
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(f"guard.py: could not read the hook input ({e}); not checking this command", file=sys.stderr)
        return 1  # non-blocking error: shown to the user, the command goes on
    command = (payload.get("tool_input") or {}).get("command") or ""
    if not command:
        return 0
    # agent_type is set by Claude Code: the subagent's name inside a subagent, absent in the main session
    try:
        decision = decide(command, payload.get("cwd"), agent_type=payload.get("agent_type"))
    except Exception as e:  # a crash must not let the command through (exit 1 does not block)
        decision = ("deny", f"guard.py failed on this command ({type(e).__name__}: {e}). "
                            "Rewrite it as plain commands, or ask the user to run it.")
    if not decision:
        return 0
    kind, reason = decision
    if kind == "deny":
        print(reason, file=sys.stderr)
        return 2
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": reason,
    }}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
