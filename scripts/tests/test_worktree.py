"""Tests for copy_env in scripts/worktree.sh: the script is sourced in a temp repo, so only its functions run
(no Docker, no git worktree)."""

from __future__ import annotations

import os
import subprocess
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


if __name__ == "__main__":
    unittest.main()
