"""Tests for .claude/hooks/verify_on_stop.py, the Stop hook: hook input on stdin, as Claude Code sends it,
against a temp repo whose scripts/verify.sh is a stub that prints a marker and exits with $STUB_EXIT."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

from tmprepo import ROOT, TempRepo, clean_env

HOOK = os.path.join(ROOT, ".claude", "hooks", "verify_on_stop.py")
MAX_ROUNDS = 2  # the contract (CLAUDE.md, issue #11): at most 2 blocked stops in a row
MARKER = "stub-verify-output"
SESSION = "test-session"
STUB = f"#!/usr/bin/env bash\necho {MARKER}\necho {MARKER}-stderr >&2\nexit \"${{STUB_EXIT:-0}}\"\n"


class StopHookTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = TempRepo(self)
        self.repo.write("scripts/verify.sh", STUB, 0o755)
        self.repo.git("add", "scripts/verify.sh")
        self.repo.commit("stub verify")
        self.repo.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.counter = os.path.join(self.repo.git_dir, f"verify-stop-{SESSION}")

    def stop(self, verify_exit: int, active: bool = False) -> subprocess.CompletedProcess[str]:
        payload = {"cwd": self.repo.path, "session_id": SESSION, "stop_hook_active": active}
        return subprocess.run([sys.executable, "-B", HOOK], input=json.dumps(payload), text=True,
                              capture_output=True, env=clean_env(STUB_EXIT=str(verify_exit)), timeout=60)

    def test_main_is_skipped(self) -> None:
        self.repo.git("switch", "-q", "-c", "main")
        self.repo.commit("ahead of origin/main")
        p = self.stop(verify_exit=1)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn(MARKER, p.stdout + p.stderr)

    def test_nothing_changed_is_skipped(self) -> None:
        p = self.stop(verify_exit=1)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn(MARKER, p.stdout + p.stderr)

    def test_failing_verify_blocks_with_its_output(self) -> None:
        self.repo.commit("work")
        p = self.stop(verify_exit=1)
        self.assertEqual(p.returncode, 2)
        self.assertIn(MARKER, p.stderr)
        self.assertIn(f"{MARKER}-stderr", p.stderr)
        self.assertIn(f"fix round 1 of {MAX_ROUNDS}", p.stderr)

    def test_uncommitted_change_counts(self) -> None:
        self.repo.write("file.txt", "x")
        self.assertEqual(self.stop(verify_exit=1).returncode, 2)

    def test_green_verify_lets_claude_stop(self) -> None:
        self.repo.commit("work")
        p = self.stop(verify_exit=0)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "")

    def test_round_cap_then_warning(self) -> None:
        self.repo.commit("work")
        for round_ in range(1, MAX_ROUNDS + 1):
            p = self.stop(verify_exit=1, active=round_ > 1)
            self.assertEqual(p.returncode, 2, f"round {round_}: {p.stdout}")
            self.assertIn(f"fix round {round_} of {MAX_ROUNDS}", p.stderr)
        p = self.stop(verify_exit=1, active=True)
        self.assertEqual(p.returncode, 0, f"stop {MAX_ROUNDS + 1} must not block: {p.stderr}")
        message = json.loads(p.stdout)["systemMessage"]
        self.assertIn("NOT verified", message)
        self.assertFalse(os.path.exists(self.counter), "the counter is reset after the cap")
        # a new stop (not a continuation) starts at round 1 again
        p = self.stop(verify_exit=1)
        self.assertIn(f"fix round 1 of {MAX_ROUNDS}", p.stderr)

    def test_green_verify_clears_the_counter(self) -> None:
        self.repo.commit("work")
        self.assertEqual(self.stop(verify_exit=1).returncode, 2)
        self.assertTrue(os.path.exists(self.counter))
        self.assertEqual(self.stop(verify_exit=0, active=True).returncode, 0)
        self.assertFalse(os.path.exists(self.counter))
        p = self.stop(verify_exit=1, active=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn(f"fix round 1 of {MAX_ROUNDS}", p.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
