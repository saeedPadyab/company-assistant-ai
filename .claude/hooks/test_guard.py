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
REVIEW_STATUS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "review-status.sh")
GITHOOKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".githooks")


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
        # The git dir sits outside the repo, as in a worktree. A `.git` folder would not work under the
        # Bash sandbox, which denies writes to `.git/config`, `.git/hooks/` and `.git/refs/notes/` anywhere.
        gitdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, gitdir, True)
        self.git("init", "-q", "-b", "feat/1-x", f"--separate-git-dir={gitdir}")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "test")
        os.mkdir(os.path.join(self.repo, ".githooks"))
        shutil.copy2(os.path.join(GITHOOKS, "pre-push"), os.path.join(self.repo, ".githooks", "pre-push"))
        self.git("config", "core.hooksPath", ".githooks")  # as scripts/worktree.sh setup does
        self.commit("one")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout

    def commit(self, msg: str) -> None:
        self.git("commit", "-q", "--allow-empty", "-m", msg)

    def note(self, verdict: str, commit: str | None = None) -> None:
        """A verdict note on HEAD as review-status.sh writes it; `commit` overrides the commit it names."""
        commit = commit or self.git("rev-parse", "HEAD").strip()
        self.git("notes", "--ref=ai-review", "add", "-f", "-m", f"VERDICT: {verdict}", "-m", "summary",
                 "-m", f"commit: {commit}", "HEAD")

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

    def test_a_note_for_another_commit_does_not_count(self) -> None:
        self.git("notes", "--ref=ai-review", "add", "-f", "-m", "VERDICT: PASS", "HEAD")  # names no commit
        self.check([("git push", "deny")])
        self.note("PASS", commit="0" * 40)
        self.check([("git push", "deny")])

    def test_push_of_unknown_ref_is_denied(self) -> None:
        self.check([("git push origin nosuchref", "deny")])

    def test_wrappers_do_not_hide_a_push(self) -> None:
        self.check([(c, "deny") for c in [
            "X=1; git push", "X=1; git push origin main", "timeout 60 git push -u origin feat/1-x",
            "timeout -k 5 60 git push", "nice git push", "nice -n 5 git push", "nohup git push",
            "env X=1 git push", "echo HEAD | xargs git push origin", "bash -c 'git push'",
            "find . -maxdepth 0 -exec git push \\;", "eval git push", "git push origin --tags",
            "(git push)", "(cd . && git push)", "{ git push; }", "( git push );", "if true; then git push; fi",
            "sudo -u me git push", "! git push",
            "pnpm exec git push", "pnpm --filter server exec git push", "pnpm dlx git push",
            "npm exec -- git push", "npx git push", "yarn exec git push",
            "pnpm git push", "pnpm --filter server git push", "pnpm -C . git push", "bun git push",
        ]])
        self.note("PASS")
        self.check([("timeout 60 git push", "ask"), ("X=1; git push", "ask"), ("(git push)", "ask")])

    def test_the_pre_push_hook_stays_on(self) -> None:
        self.note("PASS")
        self.check([(c, "deny") for c in [
            "git push --no-verify", "git push -u origin feat/1-x --no-verify",
            "git config core.hooksPath /dev/null", "git config --unset core.hooksPath",
            "git -c core.hooksPath=/dev/null push", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath git push",
            "rm .githooks/pre-push", "chmod -x .githooks/pre-push", "echo exit 0 > .githooks/pre-push",
            "bash -c 'git config core.hooksPath x'",
            "git push --no-verif", "npx git push --no-verify", "pnpm exec git push --no-verify",
            "git -c alias.p='push --no-verify' p origin feat/1-x", "git config alias.p 'push --no-verify'",
            "git config --global alias.p push", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p",
            "printf '[core]\\n\\thooksPath = /dev/null\\n' >> .git/config", "tee -a .git/config",
            "rm -rf .git/hooks", "sed -i '' s/x/y/ .git/config",
            "pnpm git push --no-verify", "pnpm git config core.hooksPath /dev/null",
            "pnpm git -c core.hooksPath=/dev/null push", "pnpm --filter server git push --no-verify",
            "git config --remove-section core", "git config --rename-section core x",
            "git rm .githooks/pre-push", "git mv .githooks/pre-push x", "git restore --source=HEAD~1 .githooks",
            # inside quotes, $(...) and backticks
            'out="$(git push --no-verify origin HEAD 2>&1)"; echo "$out"',
            'echo "pushed: `git push --no-verify`"',
            "git config remove-section core", "git config rename-section core x",
            "git --config-env=core.hooksPath=V push", "git config include.path /tmp/x",
            # the cost of the raw scan: an inline message that names it
            "git commit -m '3: document core.hooksPath'",
        ]])

    def test_push_is_denied_when_the_hook_is_off(self) -> None:
        self.note("PASS")
        self.git("config", "--unset", "core.hooksPath")
        self.check([("git push", "deny")])
        self.git("config", "core.hooksPath", ".githooks")
        os.chmod(os.path.join(self.repo, ".githooks", "pre-push"), 0o644)
        self.check([("git push", "deny")])
        self.check([(c, "allow") for c in [
            "git config --get core.hooksPath", "cat .githooks/pre-push",
            "git commit -F /tmp/msg.txt",  # text that names the dangerous words goes in a file
            "git config --get-regexp alias", "cat .git/config",
        ]])

    def test_verdict_refs_and_settings_stay_out_of_shell_writes(self) -> None:
        # issue #5: copying a note ref over the verdict ref forges a PASS; disableAllHooks turns the guard off
        self.check([(c, "deny") for c in [
            "cp .git/refs/notes/mine .git/refs/notes/ai-review", "mv /tmp/x .git/refs/notes/ai-review",
            "tee .git/refs/notes/ai-review", "echo x > .git/refs/notes/ai-review",
            "cp /tmp/x /repo/.git/refs/notes/ai-review",
            "cp /tmp/packed .git/packed-refs", "mv /tmp/packed .git/packed-refs",
            "tee -a .git/packed-refs", "echo x >> .git/packed-refs",
            "echo '{\"disableAllHooks\": true}' > .claude/settings.local.json",
            "tee .claude/settings.json", "sed -i '' s/x/y/ .claude/settings.local.json",
            "cp /tmp/s.json .claude/settings.local.json", "rm .claude/settings.json",
            "git checkout -- .claude/settings.json", "git rm .claude/settings.local.json",
            "git restore --source=HEAD~1 .claude/settings.json",
            "rsync /tmp/x .git/refs/notes/ai-review", "rsync /tmp/s.json .claude/settings.local.json",
            # over-blocking on purpose: a copy out of these paths is denied as well
            "cp .git/refs/notes/ai-review /tmp/backup",
        ]])
        self.check([(c, "allow") for c in [
            "cat .git/refs/notes/ai-review", "cat .git/packed-refs", "cat .claude/settings.json",
        ]])

    def test_existing_aliases(self) -> None:
        self.git("config", "alias.p", "push --no-verify")
        self.git("config", "alias.n", "notes --ref=ai-review add -f -m x")
        self.git("config", "alias.sh", "!git push")
        self.git("config", "alias.st", "status --short")
        self.check([("git p origin feat/1-x", "deny"), ("git n", "deny"), ("git sh", "deny"), ("git st", "allow")])

    def test_earlier_push_rules_still_win(self) -> None:
        self.note("PASS")
        self.check([("git push origin main", "deny"), ("git push --force", "deny"), ("git push origin +feat/1-x", "deny")])


class PrePushHook(GuardTest):
    """.githooks/pre-push with real pushes to a local bare remote: git runs it however the push starts."""

    def setUp(self) -> None:
        super().setUp()
        self.remote = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.remote, True)
        subprocess.run(["git", "init", "-q", "--bare", self.remote], check=True)
        self.git("remote", "add", "origin", self.remote)
        self.git("config", "core.hooksPath", os.path.abspath(GITHOOKS))

    def push(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "push", "-q", *args], cwd=self.repo, capture_output=True, text=True)

    def test_unreviewed_push_fails(self) -> None:
        p = self.push("origin", "feat/1-x")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("no review verdict", p.stderr)

    def test_failed_review_fails(self) -> None:
        self.note("FAIL")
        self.assertIn("failed this commit", self.push("origin", "feat/1-x").stderr)

    def test_pass_pushes_and_new_commit_needs_review(self) -> None:
        self.note("PASS")
        self.assertEqual(self.push("origin", "feat/1-x").returncode, 0)
        self.commit("two")
        self.assertNotEqual(self.push("origin", "feat/1-x").returncode, 0)

    def test_paths_the_guard_cannot_see_still_hit_the_hook(self) -> None:
        for cmd in (["sh", "-c", "(git push -q origin feat/1-x)"],
                    ["git", "-c", "alias.p=push", "p", "-q", "origin", "feat/1-x"],
                    [sys.executable, "-c", "import subprocess; raise SystemExit(subprocess.call(['git','push','-q','origin','feat/1-x']))"]):
            with self.subTest(cmd=cmd):
                self.assertNotEqual(subprocess.run(cmd, cwd=self.repo, capture_output=True).returncode, 0)

    def test_every_pushed_ref_is_checked(self) -> None:
        self.git("branch", "other")  # same commit, then a new unreviewed one on it
        self.git("switch", "-q", "other")
        self.commit("unreviewed")
        self.git("switch", "-q", "feat/1-x")
        self.note("PASS")
        self.assertNotEqual(self.push("origin", "feat/1-x", "other").returncode, 0)
        self.git("config", "push.default", "matching")
        self.assertEqual(self.push("origin", "feat/1-x").returncode, 0)
        self.git("push", "-q", "--no-verify", "origin", "other")  # `other` now exists on the remote
        self.git("switch", "-q", "other")
        self.commit("more")
        self.git("switch", "-q", "feat/1-x")
        self.assertNotEqual(self.push().returncode, 0)  # matching pushes `other` too: caught

    def test_a_pass_copied_by_amend_does_not_count(self) -> None:
        self.note("PASS")
        self.git("-c", "notes.rewriteRef=refs/notes/*", "commit", "-q", "--amend", "--allow-empty", "-m", "changed")
        self.assertIn("VERDICT: PASS", self.git("notes", "--ref=ai-review", "show", "HEAD"))  # git copied it
        self.assertIn("no review verdict", self.push("origin", "feat/1-x").stderr)
        get = subprocess.run([REVIEW_STATUS, "get"], cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(get.stdout.strip(), "NONE")

    def test_deleting_a_branch_passes(self) -> None:
        self.git("push", "-q", "--no-verify", "origin", "feat/1-x:old")
        self.assertEqual(self.push("origin", ":old").returncode, 0)


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
        "git config core.notesRef ai-review",
        "git -c core.notesRef=ai-review notes add -m 'VERDICT: PASS' HEAD",
        "(git notes --ref=ai-review add -m x HEAD)",
        "{ git notes --ref=ai-review add -m x HEAD; }",
        "git -c alias.n='notes --ref=ai-review add -f -m x' n",
        "git config alias.n 'notes --ref=ai-review add -f -m x'",
        "npx git notes --ref=ai-review add -m x",
        "pnpm exec git notes --ref=ai-review add -m x",
        "pnpm git notes --ref ai-review add -f -m 'VERDICT: PASS' HEAD",
        'echo "$(git notes --ref=ai-review add -f -m "VERDICT: PASS" HEAD)"',
        'msg="$(git notes --ref=ai-review add -f -m PASS HEAD 2>&1)"',
        "echo `git notes --ref=ai-review add -m x`",
        "git notes --re=ai-review add -m 'VERDICT: PASS' HEAD",
        "git -c notes.rewriteRef='refs/notes/*' commit --amend --no-edit",
        "GIT_NOTES_REWRITE_REF='refs/notes/*' git commit --amend --no-edit",
        "git config notes.rewriteRef 'refs/notes/*'",
        "git -c notes.rewriteRef=refs/notes/* rebase origin/main",
        "gh api repos/o/r/statuses/abc -f context=ai-review -f state=success",
    ]
    READS = [
        "scripts/review-status.sh get",
        "scripts/review-status.sh carry",  # issue #34: the script checks docs-only in code, any session may run it
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


class SandboxExcludedAlone(GuardTest):
    """Issue #13: excludedCommands leave the sandbox only as the whole call, after at most `cd <dir> &&`."""

    def test_chained_forms_are_denied(self) -> None:
        self.note("PASS")  # so a chained push is denied by this rule, not by the review gate
        self.check([(c, "deny") for c in [
            "git status && gh issue view 1", "git log; scripts/review-status.sh get", "gh pr view 1 | cat",
            "gh issue view 1 && git status", "gh issue view 1\ngit status", "out=$(gh pr view 1); echo $out",
            "cd /x && git status && gh issue view 1", "cd /x; ls && gh issue view 1",
            "git status && git push", "ls; git fetch origin", "git pull || true",
            "docker compose up -d && pnpm test", "ls && scripts/worktree.sh setup",
            "git status && ./scripts/review-status.sh get",
            # command substitution inside double quotes, and an unquoted heredoc that substitutes
            'gh pr create --title x --body "$(cat notes.md)"', 'gh issue comment 1 --body "see `git log -1`"',
            "gh pr create --title x --body \"$(cat <<'EOF'\nbody\nEOF\n)\"",
            "gh pr create --body-file - <<EOF\n$(git log -1)\nEOF",
            "gh pr create --body-file - <<-EOF\n\tbody\n\t\tEOF\ngit status",  # resumes after the terminator line
            # `<<` inside quotes is text, not a heredoc: the lines after it are still commands
            'echo "<<EOF"\ngit status && gh issue view 1', "echo '<<EOF'\ngh issue view 1",
        ]])
        self.check([("git status; scripts/review-status.sh record PASS x", "deny")], agent_type="reviewer")

    def test_alone_or_after_cd_passes_as_before(self) -> None:
        self.note("PASS")
        self.check([
            ("gh issue view 1", "allow"), ("cd /x && gh issue view 1", "allow"),
            ('cd "/a b" && gh pr view 1 --json state', "allow"), ("scripts/review-status.sh get", "allow"),
            ("git status && git log", "allow"), ("cd . && git push", "ask"), ("git push", "ask"),
            ("gh pr create --base main --title x --body-file - <<'EOF'\nfirst line\n- second; line\nEOF", "ask"),
            ("gh pr create --body-file - <<'EOF'\nuses `$(x)` and `y`\nEOF", "ask"),  # quoted heredoc: literal
            ("gh pr create --body-file - <<-EOF\n\tbody\n\t\tEOF\n", "ask"),  # indented `<<-` terminator
            ("gh pr view 1 --json title --jq '.title | \"$(x)\"'", "allow"),  # single quotes: literal
            # quoted code that mentions gh and `<<EOF` is one command, not a chain
            ("cd /x && python3 -c '\nx = \"a; gh issue view 1\"\ny = \"<<EOF\"\n'", "allow"),
        ])
        self.check([(f"cd {self.repo} && scripts/review-status.sh record PASS ok", "allow")], agent_type="reviewer")

    def test_deny_says_run_it_on_its_own(self) -> None:
        payload = {"cwd": self.repo, "tool_input": {"command": "git status && gh issue view 11"}}
        p = subprocess.run([sys.executable, "-B", GUARD], input=json.dumps(payload), text=True, capture_output=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn("Run `gh` on its own", p.stderr)


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
