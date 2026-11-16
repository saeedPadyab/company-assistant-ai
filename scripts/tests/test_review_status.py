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

    # carry (issue #34): PASS onto HEAD only over docs-only commits since a passed ancestor

    def change(self, rel: str, text: str = "x\n") -> None:
        self.repo.write(rel, text)
        self.repo.git("add", "-A")
        self.repo.commit(f"change {rel}")

    def carry(self) -> subprocess.CompletedProcess[str]:
        return self.run_script("carry")

    def test_carry_over_docs_commits(self) -> None:
        self.record("PASS")
        passed = self.repo.head()
        self.change("docs/notes.md")
        self.change("README.md")
        p = self.carry()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(f"carried PASS from {passed[:12]}", p.stdout)
        self.assertEqual(self.get(), "PASS")
        note = self.repo.git("notes", "--ref=ai-review", "show", "HEAD")
        self.assertIn(f"carried-from: {passed}", note)
        self.assertIn("2 docs-only commit(s)", note)

    def test_carry_refuses_code_and_tooling(self) -> None:
        for path in ("src/app.ts", ".claude/agents/reviewer.md", ".github/pull_request_template.md",
                     ".githooks/notes.md", "CLAUDE.md", "apps/server/CLAUDE.md", "AGENTS.md", "notes.txt"):
            with self.subTest(path=path):
                self.repo.git("notes", "--ref=ai-review", "remove", "--ignore-missing", "HEAD")
                self.record("PASS")
                self.change(path)
                p = self.carry()
                self.assertNotEqual(p.returncode, 0)
                self.assertIn("not docs-only", p.stderr)
                self.assertIn(path, p.stderr)
                self.assertEqual(self.get(), "NONE")

    def test_carry_refuses_code_among_docs_and_a_rename_to_markdown(self) -> None:
        self.record("PASS")
        self.change("docs/a.md")
        self.repo.git("mv", "file.txt", "docs/file.md")
        self.repo.commit("rename code to markdown")
        p = self.carry()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("file.txt", p.stderr)
        self.assertEqual(self.get(), "NONE")

    def test_carry_refuses_without_a_passed_ancestor(self) -> None:
        self.change("docs/a.md")
        p = self.carry()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("no passed ancestor", p.stderr)
        self.assertEqual(self.get(), "NONE")

    def test_carry_refuses_when_the_nearest_verdict_is_fail(self) -> None:
        self.record("PASS")
        self.repo.commit("two")
        self.record("FAIL")
        self.change("docs/a.md")
        p = self.carry()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("FAIL", p.stderr)
        self.assertEqual(self.get(), "NONE")

    def test_carry_refuses_a_merge(self) -> None:
        self.record("PASS")
        self.repo.git("switch", "-q", "-c", "side")
        self.change("docs/side.md")
        self.repo.git("switch", "-q", "-")
        self.change("docs/main.md")
        self.repo.git("merge", "-q", "--no-ff", "-m", "merge side", "side")
        p = self.carry()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("merge", p.stderr)
        self.assertEqual(self.get(), "NONE")

    def test_carry_refuses_uncommitted_changes_and_a_reviewed_head(self) -> None:
        self.record("PASS")
        p = self.carry()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("already has a verdict", p.stderr)
        self.change("docs/a.md")
        self.repo.write("file.txt", "changed\n")
        p = self.carry()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("uncommitted changes", p.stderr)
        self.assertEqual(self.get(), "NONE")


if __name__ == "__main__":
    unittest.main(verbosity=1)
