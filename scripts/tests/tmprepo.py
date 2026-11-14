"""A throwaway git repo for the tooling tests (scripts/test-tooling.sh runs them)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def clean_env(**extra: str) -> dict[str, str]:
    """The environment without GIT_* variables, so a test run from a git hook still talks to its temp repo."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(extra)
    return env


class TempRepo:
    """A repo in $TMPDIR on branch `branch` with one commit.

    The git dir sits outside the repo, as in a worktree: the Bash sandbox denies writes to `.git/config`,
    `.git/hooks/` and `.git/refs/notes/` anywhere, so a plain `.git` folder would not work under it.
    """

    def __init__(self, case: unittest.TestCase, branch: str = "feat/1-x") -> None:
        self.path = tempfile.mkdtemp()
        case.addCleanup(shutil.rmtree, self.path, True)
        self.git_dir = tempfile.mkdtemp()
        case.addCleanup(shutil.rmtree, self.git_dir, True)
        self.git("init", "-q", "-b", branch, f"--separate-git-dir={self.git_dir}")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "test")
        self.git("config", "commit.gpgsign", "false")
        self.commit("one")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.path, check=True, capture_output=True, text=True,
                              env=clean_env()).stdout.strip()

    def commit(self, msg: str) -> str:
        self.git("commit", "-q", "--allow-empty", "-m", msg)
        return self.head()

    def head(self) -> str:
        return self.git("rev-parse", "HEAD")

    def write(self, rel: str, text: str, mode: int | None = None) -> None:
        path = os.path.join(self.path, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        if mode is not None:
            os.chmod(path, mode)
