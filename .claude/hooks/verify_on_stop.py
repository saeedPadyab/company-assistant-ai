#!/usr/bin/env python3
"""Stop hook: Claude cannot end its turn while scripts/verify.sh is red.

Claude Code runs this when Claude is about to stop, with JSON on stdin.
  - exit 0                       -> Claude stops
  - exit 2 + reason on stderr    -> Claude keeps going, with the reason as its next input

Skipped (exit 0) on main/master or when nothing changed vs origin/main, so plain Q&A stays fast.
At most MAX_ROUNDS blocked stops in a row; after that Claude may stop and the user gets a warning,
so a failure Claude cannot fix does not loop forever.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

MAX_ROUNDS = 2
BASE = "origin/main"
TAIL_LINES = 60
TIMEOUT = 570  # the hook's own timeout in settings.json is 600


def git(cwd: str, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=20)
    return result.stdout.strip() if result.returncode == 0 else ""


def allow_with_warning(message: str) -> int:
    print(json.dumps({"systemMessage": message}))
    return 0


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    cwd = payload.get("cwd") or os.getcwd()
    top = git(cwd, "rev-parse", "--show-toplevel")
    if not top:
        return 0
    if git(top, "branch", "--show-current") in {"main", "master"}:
        return 0
    dirty = git(top, "status", "--porcelain")
    ahead = git(top, "rev-list", "--count", f"{BASE}..HEAD") or "0"
    if not dirty and ahead == "0":
        return 0
    script = os.path.join(top, "scripts", "verify.sh")
    if not os.access(script, os.X_OK):
        return 0

    git_dir = git(top, "rev-parse", "--absolute-git-dir")
    counter = os.path.join(git_dir, f"verify-stop-{payload.get('session_id', 'none')}")
    rounds = 0
    if payload.get("stop_hook_active"):
        try:
            with open(counter) as f:
                rounds = int(f.read().strip() or 0)
        except (OSError, ValueError):
            rounds = 0

    try:
        result = subprocess.run([script], cwd=top, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return allow_with_warning(f"verify.sh timed out after {TIMEOUT}s; the change is not verified.")

    if result.returncode == 0:
        try:
            os.remove(counter)
        except OSError:
            pass
        return 0

    rounds += 1
    if rounds > MAX_ROUNDS:
        try:
            os.remove(counter)
        except OSError:
            pass
        return allow_with_warning(
            f"verify.sh is still failing after {MAX_ROUNDS} fix rounds. The change is NOT verified; "
            "run scripts/verify.sh to see the errors.")
    with open(counter, "w") as f:
        f.write(str(rounds))

    tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-TAIL_LINES:])
    print(f"scripts/verify.sh failed (fix round {rounds} of {MAX_ROUNDS}). Fix these errors before "
          f"saying the change is done; do not weaken or skip checks.\n\n{tail}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
