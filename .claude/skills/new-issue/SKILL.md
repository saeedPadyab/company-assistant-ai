---
name: new-issue
description: Draft a GitHub issue from the user's description and create it after their yes. Use when the user asks to create, open, file or write up an issue or ticket, or when /work-on finds no issue for the work.
argument-hint: <what the issue is about>
---

# Create a GitHub issue

Creating an issue writes to GitHub: show the full draft and create it only after the user's yes. The guard hook asks again before `gh issue create`; that is expected.

## 1. Understand the work

- Use the user's description. Read the code it touches and, for a product feature, its section in `docs/features.md`, so the issue names real files and behavior.
- Check for a duplicate first: `gh issue list --state open --search "<keywords>"`. If one exists, show it and ask whether to use it instead.
- One small change per issue. If the description holds several independent changes, propose one issue each.

## 2. Draft

```markdown
<one or two sentences: what is wrong or missing today, and why it matters>

## What to do
- <concrete change, naming files, commands or endpoints>

## Acceptance criteria
- [ ] <observable check: a test, a command's result, a behavior>
- [ ] `scripts/verify.sh` passes.
```

- Title: what changes, imperative or descriptive, under about 70 characters, no issue number.
- Label, one of the repo's: `feature` (product behavior), `chore` (tooling, CI, config), `security`, `eval`, `bug` (something broken), `documentation`.
- Milestone: `v1` or `v2`, from the feature's version in `docs/features.md`; tooling goes to the current one (`v1`).
- Write it in English, like the rest of the repo.

## 3. Show it, wait for yes

Show title, label, milestone and the full body. Apply the user's corrections and show it again if they changed anything substantial.

## 4. Create it

```bash
gh issue create --title "<title>" --label <label> --milestone <milestone> --body-file - <<'EOF'
<body>
EOF
```

Report the link and offer the next step: `/work-on <number>`.
