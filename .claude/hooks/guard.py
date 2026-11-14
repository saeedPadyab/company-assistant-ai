#!/usr/bin/env python3
"""PreToolUse guard for Bash commands.

Claude Code pipes the tool call as JSON on stdin. This script:
  - exit 2 + a reason on stderr  -> the command is blocked, Claude sees the reason
  - prints a JSON "ask" decision  -> the user is asked, whatever the permission rules say
  - exit 0 with no output         -> normal permission flow

Rules work on the parsed command, so word order and flags (`pnpm --filter server add x`,
`git push origin HEAD:main`) do not get around them. It only sees the command text: a script
that pushes on its own is out of reach (that is the sandbox's job).

Review gate: `git push` is denied unless the tip of each pushed ref (HEAD when no refspec) has the
reviewer's PASS note (refs/notes/ai-review, scripts/review-status.sh). Only the `reviewer` subagent
(hook input `agent_type`) may touch that ref: outside it, any git command naming `ai-review` is
denied except reads (log, show, notes show/list), and so is GIT_NOTES_REF / GIT_CONFIG_* pointing
at it. Known limits (text only, as above): a script or `bash -c '...'` that writes the note, or a
file edit under .git/, is not seen. The GitHub `ai-review` status is the second lock.

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
NOTES_ACTIONS = {"add", "append", "edit", "copy", "remove", "merge", "prune", "show", "list", "get-ref"}
NOTES_READ_ACTIONS = {"show", "list", "get-ref"}
GIT_READ_SUBS = {"log", "show", "rev-parse", "status", "diff"}
RECORD_DENIED = ("Only the reviewer subagent records a review verdict. Run the `reviewer` agent on this branch; "
                 "it reviews HEAD and records PASS or FAIL itself.")


SEPARATORS = {";", "&&", "||", "|", "&", "|&", ";;", "\n"}


def segments_of(command: str) -> list[list[str]]:
    """The command's simple commands as token lists, split on ; && || | & and newlines outside quotes.
    Redirections come out as their own tokens (`<`, `>`, `2>&1` -> `2`, `>&`, `1`)."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|<>\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        tokens = list(lexer)
    except ValueError:  # unbalanced quotes: fall back to a plain split
        tokens = re.split(r"\s+|(?=[;&|\n])|(?<=[;&|\n])", command)
    segments, current = [], []
    for tok in tokens:
        if tok in SEPARATORS:
            segments.append(current)
            current = []
        elif tok:
            current.append(tok)
    segments.append(current)
    return [strip_prefix(s) for s in segments if s]


def strip_prefix(tokens: list[str]) -> list[str]:
    """Drop leading VAR=value assignments and wrappers like `sudo`, `env`, `command`."""
    while tokens and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[0]) or tokens[0] in {"sudo", "env", "command", "exec", "time"}):
        tokens = tokens[1:]
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
    note = git("notes", f"--ref={REVIEW_NOTES_REF}", "show", sha.stdout.strip())
    first = note.stdout.splitlines()[0].strip() if note and note.returncode == 0 and note.stdout else ""
    return {"VERDICT: PASS": "PASS", "VERDICT: FAIL": "FAIL"}.get(first, "NONE")


def check_review_record(tokens: list[str], agent_type: str | None) -> tuple[str, str] | None:
    """Only the reviewer subagent writes verdicts (refs/notes/ai-review)."""
    if agent_type == REVIEWER_AGENT:
        return None
    for i, tok in enumerate(tokens[:-1]):
        if os.path.basename(tok) == "review-status.sh" and tokens[i + 1] == "record":
            return "deny", RECORD_DENIED
    sub, args = git_subcommand(tokens)
    if sub is None or not any(REVIEW_NOTES_REF in t for t in tokens[1:]):
        return None
    # git names the ref: allow reads, deny everything else (notes add, update-ref, config notes.rewriteRef, -c ...)
    if sub in GIT_READ_SUBS and not any(t == "-c" for t in tokens):
        return None
    if sub == "notes" and next((a for a in args if a in NOTES_ACTIONS), "list") in NOTES_READ_ACTIONS:
        return None
    return "deny", RECORD_DENIED


def check_push(args: list[str], branch: str | None, cwd: str | None = None,
               verdict_of=review_verdict) -> tuple[str, str]:
    """('deny'|'ask', reason) for `git push <args>`."""
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

    # .env contents through the shell (Read(...) deny rules only cover the Read tool)
    if head in READERS and any(is_env_file(t) for t in tokens[1:]):
        found.append(("deny", "Reading .env files is blocked: they hold real secrets. Use .env.example for the variable names."))
    for i, tok in enumerate(tokens[:-1]):
        if tok == "<" and is_env_file(tokens[i + 1]):
            found.append(("deny", "Reading .env files is blocked: they hold real secrets. Use .env.example for the variable names."))
    if head in {"cp", "mv", "scp", "rsync"} and any(is_env_file(t) for t in tokens[1:-1]):
        found.append(("deny", "Copying .env files is blocked: they hold real secrets."))

    sub, args = git_subcommand(tokens)
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


def decide(command: str, cwd: str | None, branch_of=current_branch, agent_type: str | None = None,
           verdict_of=review_verdict) -> tuple[str, str] | None:
    """Follows `cd <dir>` and `git -C <dir>` so a commit in a worktree is checked against that worktree's branch."""
    results: list[tuple[str, str]] = []
    cache: dict[str | None, str | None] = {}

    def branch_in(path: str | None) -> str | None:
        if path not in cache:
            cache[path] = branch_of(path)
        return cache[path]

    # env assignments are stripped from segments, so check them on the raw text
    if agent_type != REVIEWER_AGENT and REVIEW_NOTES_REF in command and re.search(r"\bGIT_(NOTES_REF|CONFIG_)", command):
        results.append(("deny", RECORD_DENIED))
    for tokens in segments_of(command):
        if tokens[0] == "cd" and len(tokens) > 1:
            cwd = os.path.join(cwd or os.getcwd(), os.path.expanduser(tokens[1]))
            continue
        where = cwd
        if os.path.basename(tokens[0]) == "git" and (d := git_dir_option(tokens)):
            where = os.path.join(cwd or os.getcwd(), os.path.expanduser(d))
        results.extend(check_segment(tokens, branch_in(where), where, agent_type, verdict_of))
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
    decision = decide(command, payload.get("cwd"), agent_type=payload.get("agent_type"))
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
