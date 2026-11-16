"""Tests for copy_env in scripts/worktree.sh: the script is sourced in a temp repo, so only its functions run
(no Docker, no git worktree)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest

from tmprepo import ROOT, TempRepo, clean_env

SCRIPT = os.path.join(ROOT, "scripts", "worktree.sh")


class CopyEnvTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = TempRepo(self)

    def copy(self, text: str) -> str:
        src = os.path.join(self.repo.path, "src.env")
        dest = os.path.join(self.repo.path, "out", ".env")
        with open(src, "w") as f:
            f.write(text)
        p = subprocess.run(["bash", "-c", f'source "{SCRIPT}" && copy_env "$1" "$2" assistant_7', "_", src, dest],
                           cwd=self.repo.path, text=True, capture_output=True, env=clean_env(), timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(dest) as f:
            return f.read()

    def test_adds_the_missing_final_newline(self) -> None:
        self.assertEqual(self.copy("A=1\nOPENAI_API_KEY=x"), "A=1\nOPENAI_API_KEY=x\n")

    def test_adds_it_when_database_url_is_rewritten(self) -> None:
        out = self.copy("DATABASE_URL=postgres://u:p@localhost:5432/assistant?sslmode=disable\nB=2")
        self.assertEqual(out, "DATABASE_URL=postgres://u:p@localhost:5432/assistant_7?sslmode=disable\nB=2\n")

    def test_an_appended_line_stays_on_its_own_line(self) -> None:
        out = self.copy("A=1") + "INNGEST_DEV=1\n"
        self.assertEqual(out.splitlines(), ["A=1", "INNGEST_DEV=1"])

    def test_leaves_a_file_that_ends_in_a_newline_as_it_is(self) -> None:
        self.assertEqual(self.copy("A=1\n"), "A=1\n")

    def test_leaves_an_empty_file_empty(self) -> None:
        self.assertEqual(self.copy(""), "")


class WorktreeRootTest(unittest.TestCase):
    """Issue #34: worktrees go inside the main checkout, in .claude/worktrees/, which git ignores."""

    def test_root_is_claude_worktrees_of_the_main_checkout(self) -> None:
        repo = TempRepo(self)
        p = subprocess.run(["bash", "-c", f'source "{SCRIPT}" && printf %s "$WT_ROOT|$MAIN"'],
                           cwd=repo.path, text=True, capture_output=True, env=clean_env(), timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        root, main = p.stdout.split("|")
        self.assertEqual(root, os.path.join(main, ".claude", "worktrees"))

    def test_gitignore_keeps_worktrees_out_of_git(self) -> None:
        p = subprocess.run(["git", "check-ignore", "-q", ".claude/worktrees/34/apps/server/src/x.ts"],
                           cwd=ROOT, env=clean_env(), timeout=30)
        self.assertEqual(p.returncode, 0, ".claude/worktrees/ is not in .gitignore")


class WorktreeOfIssueTest(unittest.TestCase):
    """remove finds an issue's worktree wherever git has it, also the old ../<repo>-wt/<issue> ones."""

    def setUp(self) -> None:
        self.repo = TempRepo(self, branch="main")
        self.old_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.old_root, True)

    def add(self, branch: str, name: str) -> str:
        path = os.path.join(self.old_root, name)
        self.repo.git("worktree", "add", "-q", "-b", branch, path)
        return path

    def find(self, issue: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", "-c", f'source "{SCRIPT}" && worktree_of_issue "$1"', "_", issue],
                              cwd=self.repo.path, text=True, capture_output=True, env=clean_env(), timeout=30)

    def test_finds_a_worktree_outside_claude_worktrees_by_its_branch(self) -> None:
        self.add("feat/340-other", "340")
        path = self.add("chore/34-session-flow", "34")
        p = self.find("34")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(os.path.realpath(p.stdout.strip()), os.path.realpath(path))

    def test_falls_back_to_claude_worktrees_when_no_branch_matches(self) -> None:
        self.add("feat/340-other", "340")
        p = self.find("34")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(p.stdout.strip().endswith(os.path.join(".claude", "worktrees", "34")), p.stdout)

    def test_refuses_two_worktrees_for_one_issue(self) -> None:
        self.add("feat/34-a", "a")
        self.add("fix/34-b", "b")
        p = self.find("34")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("more than one worktree for issue 34", p.stderr)


if __name__ == "__main__":
    unittest.main()
