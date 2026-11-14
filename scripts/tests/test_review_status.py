"""Tests for scripts/review-status.sh `record` and `get` in a temp repo (`publish` needs GitHub and is not run).

The script runs here as a subprocess of the test, in the temp repo; nothing is recorded on this repo."""

from __future__ import annotations

import os
import subprocess
import unittest

from tmprepo import ROOT, TempRepo, clean_env

SCRIPT = os.path.join(ROOT, "scripts", "review-status.sh")


class ReviewStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = TempRepo(self)
        self.repo.write("file.txt", "one\n")
        self.repo.git("add", "file.txt")
        self.repo.commit("add file")

    def run_script(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([SCRIPT, *args], cwd=self.repo.path, text=True, capture_output=True,
                              env=clean_env(), timeout=30)

    def get(self, rev: str = "HEAD") -> str:
        p = self.run_script("get", rev)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip()

    def record(self, verdict: str) -> None:
        p = self.run_script("record", verdict, "summary")
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_no_note_is_none(self) -> None:
        self.assertEqual(self.get(), "NONE")

    def test_record_then_get(self) -> None:
        self.record("PASS")
        self.assertEqual(self.get(), "PASS")
        self.record("FAIL")
        self.assertEqual(self.get(), "FAIL")

    def test_new_commit_has_no_verdict(self) -> None:
        self.record("PASS")
        self.repo.commit("two")
        self.assertEqual(self.get(), "NONE")
        self.assertEqual(self.get("HEAD~1"), "PASS")

    def test_note_copied_to_another_commit_does_not_count(self) -> None:
        self.record("PASS")
        self.repo.commit("two")
        self.repo.git("notes", "--ref=ai-review", "copy", "HEAD~1", "HEAD")
        self.assertIn("VERDICT: PASS", self.repo.git("notes", "--ref=ai-review", "show", "HEAD"))
        self.assertEqual(self.get(), "NONE")

    def test_record_refuses_uncommitted_changes(self) -> None:
        self.repo.write("file.txt", "changed\n")
        p = self.run_script("record", "PASS", "summary")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("uncommitted changes", p.stderr)
        self.assertEqual(self.get(), "NONE")

    def test_record_needs_a_verdict_and_summary(self) -> None:
        for args in (["record", "MAYBE", "summary"], ["record", "PASS"], ["record"]):
            with self.subTest(args=args):
                self.assertNotEqual(self.run_script(*args).returncode, 0)
        self.assertEqual(self.get(), "NONE")

    def test_unknown_rev_is_none(self) -> None:
        self.assertEqual(self.get("no-such-rev"), "NONE")


if __name__ == "__main__":
    unittest.main(verbosity=1)
