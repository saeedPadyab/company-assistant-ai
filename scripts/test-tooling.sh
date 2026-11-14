#!/usr/bin/env bash
# Tests for the team's own tooling: no network, no Docker, no real agents; a few seconds.
#
#   scripts/test-tooling.sh
#
#   guard + pre-push:    .claude/hooks/test_guard.py
#   Stop hook, review-status.sh, .claude/settings.json, bash -n on scripts/ and .githooks/:
#                        scripts/tests/test_*.py
#   ship-branch workflow: scripts/tests/*.test.mjs (node --test)
# Run by scripts/verify.sh and the CI `hooks` job. A new guard rule, hook or tooling script gets its test here.
set -uo pipefail

cd "$(dirname "$0")/.."
failed=()
python3 -B .claude/hooks/test_guard.py || failed+=(guard)
python3 -B -m unittest discover -s scripts/tests -p 'test_*.py' || failed+=(python)
node --test scripts/tests/*.test.mjs || failed+=(node)

if [ ${#failed[@]} -gt 0 ]; then
  echo "test-tooling: FAILED (${failed[*]})" >&2
  exit 1
fi
echo "test-tooling: OK"
