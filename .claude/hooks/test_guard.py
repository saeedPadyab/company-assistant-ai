#!/usr/bin/env python3
"""Tests for guard.py: pipes hook input into it, as Claude Code does, against a throwaway git repo.

    python3 .claude/hooks/test_guard.py        (scripts/verify.sh runs it)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

GUARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guard.py")


def run_guard(command: str, cwd: str, agent_type: str | None = None) -> str:
    """'deny', 'ask' or 'allow' (normal permission flow)."""
    payload = {"cwd": cwd, "agent_type": agent_type, "tool_input": {"command": command}}
    p = subprocess.run([sys.executable, "-B", GUARD], input=json.dumps(payload), text=True, capture_output=True)
    if p.returncode == 2:
        return "deny"
    if p.returncode != 0:
        raise AssertionError(f"guard exited {p.returncode}: {p.stderr}")
    return "ask" if '"ask"' in p.stdout else "allow"


class GuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.git("init", "-q", "-b", "feat/1-x")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "test")
        self.commit("one")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout

    def commit(self, msg: str) -> None:
        self.git("commit", "-q", "--allow-empty", "-m", msg)

    def note(self, verdict: str) -> None:
        self.git("notes", "--ref=ai-review", "add", "-f", "-m", f"VERDICT: {verdict}", "HEAD")

    def check(self, cases: list[tuple[str, str]], agent_type: str | None = None, cwd: str | None = None) -> None:
        for command, want in cases:
            with self.subTest(command=command, agent_type=agent_type):
                self.assertEqual(run_guard(command, cwd or self.repo, agent_type), want)


class ReviewGate(GuardTest):
    def test_push_without_verdict_is_denied(self) -> None:
        self.check([("git push", "deny"), ("git push -u origin feat/1-x", "deny")])

    def test_push_with_fail_is_denied(self) -> None:
        self.note("FAIL")
        self.check([("git push origin HEAD", "deny")])

    def test_push_with_pass_asks(self) -> None:
        self.note("PASS")
        self.check([
            ("git push", "ask"),
            ("git push -u origin feat/1-x", "ask"),
            ("git push origin HEAD:feat/1-x", "ask"),
            ("git push origin :old-branch", "ask"),  # a deletion pushes no commit
        ])
        self.check([(f"cd {self.repo} && git push", "ask"), (f"git -C {self.repo} push", "ask")], cwd="/")

    def test_new_commit_after_pass_needs_a_new_review(self) -> None:
        self.note("PASS")
        self.commit("two")
        self.check([("git push", "deny"), ("git push origin feat/1-x~1:feat/1-x", "ask")])

    def test_push_of_unknown_ref_is_denied(self) -> None:
        self.check([("git push origin nosuchref", "deny")])

    def test_wrappers_do_not_hide_a_push(self) -> None:
        self.check([(c, "deny") for c in [
            "X=1; git push", "X=1; git push origin main", "timeout 60 git push -u origin feat/1-x",
            "timeout -k 5 60 git push", "nice git push", "nice -n 5 git push", "nohup git push",
            "env X=1 git push", "echo HEAD | xargs git push origin", "bash -c 'git push'",
            "find . -maxdepth 0 -exec git push \\;", "eval git push", "git push origin --tags",
        ]])
        self.note("PASS")
        self.check([("timeout 60 git push", "ask"), ("X=1; git push", "ask")])

    def test_earlier_push_rules_still_win(self) -> None:
        self.note("PASS")
        self.check([("git push origin main", "deny"), ("git push --force", "deny"), ("git push origin +feat/1-x", "deny")])


class WhoRecords(GuardTest):
    WRITES = [
        "scripts/review-status.sh record PASS ok",
        "bash scripts/review-status.sh record PASS ok",
        "cd . && ./scripts/review-status.sh record FAIL bad",
        "git notes --ref=ai-review add -m 'VERDICT: PASS' HEAD",
        "git notes --ref ai-review append -m x",
        "git update-ref refs/notes/ai-review HEAD",
        "git fetch origin refs/notes/ai-review:refs/notes/ai-review",
        "git config notes.rewriteRef refs/notes/ai-review",
        "git -c notes.rewriteRef=refs/notes/ai-review commit --amend --no-edit",
        "GIT_NOTES_REF=refs/notes/ai-review git notes add -f -m 'VERDICT: PASS' HEAD",
        "export GIT_NOTES_REF=refs/notes/ai-review",
        "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=notes.rewriteRef GIT_CONFIG_VALUE_0=refs/notes/ai-review git rebase main",
        "R=ai-review; git notes --ref=$R add -f -m 'VERDICT: PASS' HEAD",
        "git notes --ref=$R add -f -m x HEAD",
        "git rev-parse HEAD | xargs git notes --ref=ai-review add -fm 'VERDICT: PASS'",
        "timeout 5 git notes --ref=ai-review add -fm 'VERDICT: PASS' HEAD",
        "nice -n 5 git notes --ref=ai-review add -m x",
        "find . -maxdepth 0 -exec git notes --ref=ai-review add -m x HEAD \\;",
        "bash -c 'git notes --ref=ai-review add -m x'",
        "bash -c 'scripts/review-status.sh record PASS x'",
        "echo PASS | xargs scripts/review-status.sh record",
        "git config notes.displayRef ai-review",
    ]
    READS = [
        "scripts/review-status.sh get",
        "git notes --ref=ai-review show HEAD",
        "git notes --ref ai-review list",
        "git log --notes=ai-review -1",
        "git notes add -m hi HEAD",  # other notes refs are not the gate's
        "git log -c --notes=ai-review -1",
        # normal work that only mentions the name
        "git commit -m '3: fix ai-review gate'",
        "git switch -c chore/5-ai-review-tweak",
        "git grep ai-review",
        "git add docs/ai-review.md",
        "echo ai-review",
    ]

    def test_main_session_cannot_write_the_verdict(self) -> None:
        self.check([(c, "deny") for c in self.WRITES])
        self.check([(c, "deny") for c in self.WRITES], agent_type="general-purpose")

    def test_reviewer_can_record(self) -> None:
        self.check([("scripts/review-status.sh record PASS ok", "allow"),
                    ("git notes --ref=ai-review add -m x HEAD", "allow")], agent_type="reviewer")

    def test_reads_are_free(self) -> None:
        self.check([(c, "allow") for c in self.READS])

    def test_publish_asks(self) -> None:
        self.check([("scripts/review-status.sh publish", "ask")])
        self.check([("scripts/review-status.sh publish", "ask")], agent_type="reviewer")


class GitHubWrites(GuardTest):
    def test_merge_is_denied(self) -> None:
        self.check([(c, "deny") for c in [
            "gh pr merge 13", "gh pr merge --squash --delete-branch",
            "gh -R o/r pr merge 13", "echo ok && gh pr merge 1",
        ]])

    def test_writes_ask(self) -> None:
        self.check([(c, "ask") for c in [
            "gh issue create --title x --body y", "gh issue comment 6 --body hi",
            "gh issue edit 6 --add-label chore", "gh issue close 6",
            "gh pr create --base main --title x --body y", "gh pr review 13 --approve",
            "gh label create foo", "gh workflow run ci", "gh repo edit --visibility public",
            "gh api -X POST repos/o/r/issues -f title=x", "gh api --method=PATCH repos/o/r/issues/1",
            "gh api repos/o/r/issues -f title=x", "gh api -XDELETE repos/o/r/labels/x",
        ]])

    def test_reads_are_free(self) -> None:
        self.check([(c, "allow") for c in [
            "gh issue view 6 --json title", "gh issue list --limit 5", "gh pr view 13 --json state",
            "gh pr checks 13", "gh pr diff 13", "gh run view 123 --log-failed", "gh run list --limit 5",
            "gh api repos/o/r/milestones --jq '.[].title'", "gh api -X GET repos/o/r/issues",
            "gh search issues ci", "gh auth status", "gh label list", "git status",
        ]])


class LocalRules(GuardTest):
    def test_env_files_and_main(self) -> None:
        self.check([
            ("cat apps/server/.env", "deny"), ("grep KEY < .env.local", "deny"),
            ("cp apps/server/.env /tmp/x", "deny"), ("cat .env.example", "allow"),
            ("pnpm --filter server add zod", "ask"), ("git reset --hard", "ask"),
        ])
        self.git("switch", "-q", "-c", "main")
        self.check([("git commit -m x", "deny"), ("git push", "deny")])


if __name__ == "__main__":
    unittest.main(verbosity=1)
