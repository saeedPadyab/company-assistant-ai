"""Tests for .claude/settings.json (sandbox, deny rules, hooks) and a syntax check of the shell scripts."""

from __future__ import annotations

import glob
import json
import os
import subprocess
import unittest

from tmprepo import ROOT

SETTINGS = os.path.join(ROOT, ".claude", "settings.json")


def hook_commands(settings: dict, event: str) -> list[str]:
    return [h.get("command", "") for entry in settings.get("hooks", {}).get(event, []) for h in entry.get("hooks", [])]


class SettingsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with open(SETTINGS) as f:
            cls.settings = json.load(f)

    def test_sandbox_is_on_without_unsandboxed_retry(self) -> None:
        sandbox = self.settings.get("sandbox", {})
        self.assertIs(sandbox.get("enabled"), True)
        self.assertIs(sandbox.get("allowUnsandboxedCommands"), False)

    def test_sandbox_denies_writes_to_the_review_gate(self) -> None:
        deny_write = self.settings["sandbox"].get("filesystem", {}).get("denyWrite", [])
        for path in (".githooks/", ".git/config", ".git/hooks/", ".git/refs/notes/", ".git/packed-refs"):
            with self.subTest(path=path):
                self.assertIn(path, deny_write)

    def test_sandbox_denies_writes_to_worktree_tooling_from_the_main_checkout(self) -> None:
        # Issue #34: worktrees live in .claude/worktrees/<KEY> inside the main checkout, so a session there could
        # otherwise rewrite a worktree's guard, skills, settings or git hooks with Bash. Not checked yet: whether a
        # session that entered a worktree with EnterWorktree resolves these against the main checkout, which
        # would also refuse Bash writes to its own tooling there (Edit and Write are not affected).
        deny_write = self.settings["sandbox"].get("filesystem", {}).get("denyWrite", [])
        for path in (".claude/worktrees/*/.claude/hooks/", ".claude/worktrees/*/.claude/skills/",
                     ".claude/worktrees/*/.claude/settings.json", ".claude/worktrees/*/.claude/settings.local.json",
                     ".claude/worktrees/*/.githooks/"):
            with self.subTest(path=path):
                self.assertIn(path, deny_write)

    def test_file_tools_are_denied_on_git_hooks_and_settings(self) -> None:
        deny = self.settings.get("permissions", {}).get("deny", [])
        for tool in ("Edit", "Write"):
            for path in ("**/.git/**", "**/.githooks/**", "**/.claude/settings.json",
                         "**/.claude/settings.local.json", "//**/.git/config", "//**/.git/hooks/**",
                         "//**/.git/refs/notes/**", "//**/.git/packed-refs"):
                with self.subTest(rule=f"{tool}({path})"):
                    self.assertIn(f"{tool}({path})", deny)

    def test_env_files_are_not_readable(self) -> None:
        deny = self.settings["permissions"]["deny"]
        for path in ("**/.env", "**/.env.local", "**/.env.*.local", "**/.env.production"):
            with self.subTest(path=path):
                self.assertIn(f"Read({path})", deny)

    def test_guard_runs_before_every_bash_command(self) -> None:
        entries = [e for e in self.settings["hooks"]["PreToolUse"] if e.get("matcher") == "Bash"]
        commands = [h["command"] for e in entries for h in e["hooks"]]
        self.assertTrue(any(c.endswith("/.claude/hooks/guard.py") for c in commands), commands)
        self.assertTrue(os.path.isfile(os.path.join(ROOT, ".claude", "hooks", "guard.py")))

    def test_stop_hook_is_registered(self) -> None:
        commands = hook_commands(self.settings, "Stop")
        self.assertTrue(any(c.endswith("/.claude/hooks/verify_on_stop.py") for c in commands), commands)
        self.assertTrue(os.path.isfile(os.path.join(ROOT, ".claude", "hooks", "verify_on_stop.py")))
        timeouts = [h.get("timeout", 0) for e in self.settings["hooks"]["Stop"] for h in e["hooks"]]
        self.assertGreaterEqual(max(timeouts), 600, "verify_on_stop.py gives verify.sh 570s of the hook's timeout")


class ScriptSyntaxTest(unittest.TestCase):
    def test_bash_n(self) -> None:
        scripts = sorted(glob.glob(os.path.join(ROOT, "scripts", "**", "*.sh"), recursive=True)
                         + [p for p in glob.glob(os.path.join(ROOT, ".githooks", "*")) if os.path.isfile(p)])
        self.assertTrue(any(p.endswith("pre-push") for p in scripts))
        for path in scripts:
            with self.subTest(script=os.path.relpath(path, ROOT)):
                p = subprocess.run(["bash", "-n", path], capture_output=True, text=True)
                self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
