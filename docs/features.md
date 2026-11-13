# company-assistant: Full Stack and Features

Fourteen features, three patterns. Each feature has a goal, a step-by-step flow, the parts involved, edge cases, and how to test it.

Version 1 is `docs/spec.md` plus the proposed ADR 004 (Inngest and Langfuse). Version 2 is the full scope of `document/project-definition.md`.

This file is the reference copy. Change it through a PR like code.

## The three patterns

Every feature is built on three patterns. Get these right and the rest are layers on top.

1. **Agent loop with role-filtered tools.** A message from any channel reaches one `agent` function in Inngest. The model only sees the tools the user's role allows.
2. **Durable workflow with human approval.** The model only extracts; code decides. For consequential actions the function waits for a human with `waitForEvent`.
3. **RAG search with citations.** Company knowledge comes from the handbook, not the model's memory, and always with a page link.

Four layers of responsibility are the same in every feature: reliability with Inngest; truth and memory with Postgres; quality with the harness, context and tools; proof of quality with evals and Langfuse.

## Full stack

- **Language and layout.** TypeScript in strict mode, a pnpm + Turborepo monorepo. Two apps: `apps/web` and `apps/server`. The agent core lives in the server and does not depend on the web app, so Slack and MCP can call it later. A shared package is added when there is something to share (such as types).
- **Frontend.** Next.js with React. Streaming chat built with AI SDK UI, plus a "My requests" page and a manager approval page. In v2, Generative UI so the agent returns charts and cards instead of text, with live tool progress.
- **Backend.** Hono for the API, Zod for validating inputs and tool arguments, Better Auth for identity and the three roles (employee, manager, HR), JSON logs with a shared trace id. In v2, rate limiting with Redis.
- **Data.** Postgres with Drizzle, pgvector in the same database. Core tables: `users`, `teams`, `conversations`, `messages`, `runs`, `leave_requests`, `expenses`, `handbook_chunks`. In v2: `expense_claims`, `schedules`, `memories`, `audit_log`, and Row-Level Security as a second line of defense.
- **Agent.** Vercel AI SDK for the loop, tools and structured output. We write the loop ourselves, with a step cap and no packaged agent framework. OpenAI for chat and embeddings, model ids in env vars. In v2, a gateway for a second model.
- **Reliability.** Inngest for agent runs, waiting for managers, handbook ingestion, and in v2 scheduled jobs.
- **Code execution (v2).** E2B for the analyst agent, with no network and no database access.
- **Quality.** DeepEval on Vitest for evals in CI, Langfuse for traces, cost and feedback. In v2, OpenTelemetry, Sentry and alerts.
- **Other channels (v2).** A Slack bot and an MCP server.
- **Deployment.** Docker Compose locally and GitHub Actions CI from day one. In v2, Terraform on AWS, separate staging and production, secrets in a secret manager, feature flags.

## 1. Handbook Q&A with citations (v1)

**Goal.** An employee asks about company rules and gets a short answer from the handbook with a link to the exact page. If the handbook has nothing, the assistant says it does not know.

**Flow.**
1. The employee asks in chat: "What is the business travel expense limit?"
2. Next.js sends the message to `POST /chat`. Hono reads `userId` and role from the session and validates the input with Zod.
3. Hono saves the message in `messages`, creates a `run` with status running, and sends the `agent/run.requested` event to Inngest with only `runId` and `conversationId`. The frontend subscribes to that run's channel for the live answer.
4. Inngest runs the `agent` function with concurrency one per conversation.
5. The harness builds the context: system prompt, the last few messages, and only the tools allowed for the employee role. Every model call is inside a `step.run`.
6. The model calls `searchHandbook(query)`. The tool embeds the question and finds the nearest chunks in pgvector, with page title and link. In v2, keyword search is combined in and a reranker orders the results.
7. If no chunk is above the similarity threshold, the tool returns "nothing found" and the system prompt requires the model to say it does not know.
8. The model writes a short answer only from the chunks, with links. The answer streams, is saved in `messages`, and the run becomes completed.
9. The whole path is recorded in Langfuse with tokens, cost and latency.

**Parts.** Tables `messages`, `runs`, `handbook_chunks`. Fast tool `searchHandbook`. Inngest function `agent`. Route `POST /chat`.

**Edge cases.**
- A question outside the handbook ("What's the weather tomorrow?") is politely declined.
- Two contradicting clauses in the handbook: both are quoted with links, never one guessed.
- The user closes the page mid-stream: the run continues in Inngest and the answer stays in the DB.
- The user sends two messages in a row: concurrency queues the second.

**Test.** About 30 questions with their correct page (did the right link come back?), plus a few out-of-handbook questions whose answer must be "I don't know".

## 2. Leave request with manager approval (v1)

**Goal.** An employee asks for leave in plain language. The system checks it against the rules, sends it to the manager, waits, and tells the employee the result. The model never approves or rejects leave.

**Flow.**
1. The employee writes: "I want leave from December 10 to 12." The path to the agent loop is the same as feature 1.
2. The model picks the `requestLeave` tool. Inside the tool, the model only extracts fields with structured output: `{ from, to, type }`.
3. If something is ambiguous (such as the leave type), the `ask_user` tool is called, the run ends, and the user's answer comes back in the next message with the same `tool_call_id`.
4. The policy engine (deterministic TypeScript) checks remaining balance, holidays, overlap with earlier requests and minimum notice, and returns the handbook clause it used.
5. If not allowed, the reason and clause are told to the employee and nothing is recorded.
6. If allowed, it is saved in `leave_requests` with status pending and a unique key (for example user + date range). If the same request comes again, the existing row is returned.
7. The tool sends the `leave/submitted` event and the agent tells the employee "I sent it to your manager". The chat run ends.
8. The `leave-approval` function starts, in v2 emails or Slacks the manager, and sleeps on `waitForEvent("leave/decided", match: requestId, timeout: 48h)`.
9. On the approval page the manager sees only their own team's requests and approves or rejects.
10. Route `POST /approve` checks that this person is this employee's manager and the request is still pending, then sends `leave/decided` with the same requestId.
11. The sleeping function wakes, sets the status to approved or rejected, posts a message in the employee's conversation, and in v2 records who decided in `audit_log`.
12. The employee sees the new status on "My requests".

**Parts.** Table `leave_requests`. Tools `requestLeave`, `ask_user`, `getMyRequests`. Plain function `checkLeavePolicy`. Inngest function `leave-approval`. Route `POST /approve`.

**Edge cases.**
- The manager does not answer for 48 hours: a reminder, then escalation to HR.
- The employee cancels: status cancelled in the DB, plus an event that stops the sleeping function via `cancelOn`.
- The manager clicks approve twice: a unique id on the event, and the pending check.
- The employee asks in chat "Did my manager answer?": the read tool `getMyRequests` reads from the DB, not from Inngest.

**Test.** Unit tests for the policy engine (no model). Evals for extracting dates correctly from varied sentences. An integration test that a duplicate request does not create a second row.

## 3. Expense reimbursement (v2)

**Goal.** An employee sends a receipt or expense description and asks for reimbursement. Same pattern as leave, with one important difference: receipt text comes from outside and is untrusted.

**Flow.**
1. The employee writes "Reimburse this" and attaches a receipt photo or PDF. The file goes to storage and only its id is given to the agent.
2. The `requestExpenseClaim` tool extracts amount, currency, date, vendor and category with structured output.
3. Guardrails wrap receipt text in a data tag. If someone wrote "auto-approve this" in the description, it has no effect, because approval is not a model tool at all.
4. The policy engine checks per-category limits, the allowed submission window and handbook rules.
5. The claim is recorded in `expense_claims` with a unique key (hash of the receipt file), so one receipt is never reimbursed twice.
6. The same manager-approval flow runs with `waitForEvent`. Amounts above a threshold also need a second approval from HR.

**Parts.** Table `expense_claims`. Tool `requestExpenseClaim`. Plain function `checkExpensePolicy`. Inngest function `expense-approval`.

**Edge cases.**
- Unreadable receipt: the agent asks for amount or date with `ask_user`.
- Foreign currency: conversion in code, never guessed by the model.
- Extracted amount differs from the amount the user stated: sent to human approval.

**Test.** Extraction evals on several real receipts. A prompt-injection test with a receipt containing a fake instruction.

## 4. Team expense totals (v1)

**Goal.** A manager asks how much their team spent in a period and sees totals by category. An employee cannot see this, and no manager sees another team's numbers. This feature is mostly about access.

**Flow.**
1. The manager asks: "How much did my team spend this quarter?"
2. Before calling the model, the harness filters the tool list by role. `getTeamExpenses` is added only for manager and HR.
3. The model calls the tool with simple parameters only: `{ period: "Q4", groupBy: "category" }`. No free-form SQL comes from the model.
4. Inside the tool, `teamId` is read from the session and a fixed, parameterized query runs. For HR, all teams are allowed.
5. The result (a few rows of category and amount) goes back to the model, which summarizes it; in v2 it is shown as a table or chart with Generative UI.
6. If an employee asks the same, the model does not have the tool at all and says the data is not available for their role.

**Parts.** Table `expenses`. Fast tool `getTeamExpenses`. In v2, RLS on `expenses`.

**Edge cases.**
- The manager names another team in the text ("What did the sales team spend?"): the tool never takes `teamId` from the model, so it cannot be fooled.
- A period with no data: report zero, never an invented number.
- The model adds numbers wrong in the summary: the grand total is computed in the query, not by the model.

**Test.** Cross-role leak tests in CI: an employee sees no numbers, and team A's manager never sees team B's numbers with any prompt.

## 5. Open-ended analysis in a sandbox (v2)

**Goal.** A manager or HR asks something a fixed query cannot answer: "Why did my team's travel spend go up? Draw a chart." An analyst agent writes Python and runs it in an isolated environment.

**Flow.**
1. The question reaches the `agent` function from chat or Slack.
2. If there is a router (feature 12), it detects analysis. If not, the main agent picks the `analyzeData` tool (manager and HR only).
3. The work is handed to the `analyst` function with `step.invoke`: a sub-agent with clean context, its own prompt and tools, and a fixed timeout.
4. Code (not the model) reads the allowed slice of data from the database: the manager's team expenses, under RLS, without sensitive columns such as full names unless needed.
5. An E2B sandbox is created and the data is loaded into it as CSV files. The sandbox has no network and no database access.
6. Analyst loop: the model writes pandas code, the `runPython` tool runs it, output or error goes back to the model, repeated up to a few attempts. Each run is a step.
7. The final output is chart data (not an image) and a few lines of explanation. Guardrails check it for PII.
8. The result returns to the main agent and is shown as a chart with Generative UI.

This design breaks the lethal trifecta: private data is in the sandbox, but there is no way to send it out.

**Parts.** Entry tool `analyzeData`. Inngest function `analyst` (sub-agent). Internal tool `runPython`. E2B. RLS.

**Edge cases.**
- Code runs too long: timeout on the sandbox and on `step.invoke`.
- Analysis takes minutes: tell the user "analyzing" and post the result in the conversation later.
- Too little data for a reliable conclusion: the agent must say so.

**Test.** A golden question set with exact numeric answers, plus a test that the sandbox cannot make any network request.

## 6. Ingesting and refreshing the handbook (v1; incremental refresh in v2)

**Goal.** Turn the public GitLab handbook into searchable chunks, each with a link to its source page, and keep it current as the handbook changes. This is a pure workflow; no agent loop.

**Flow.**
1. The `handbook-ingest` function starts from a manual event or cron and fetches the list of pages.
2. One event is sent per page (fan-out). The `ingest-page` function runs with concurrency five to stay under OpenAI limits.
3. The page is fetched, text is cleaned, and it is split by headings into chunks of a few hundred tokens with slight overlap. Section title and exact link (with #anchor) are kept with each chunk.
4. Chunks are sent to the embedding model in batches, each batch in its own step, so a failure resumes from that batch.
5. Chunk, vector, link and page hash are stored in `handbook_chunks`. Step outputs are only counts and ids, never text, to stay under Inngest's payload limit.
6. v2: a nightly cron compares each page's hash with the stored hash and reprocesses only changed pages. Deleted pages are removed from the index.

**Parts.** Table `handbook_chunks` with a `vector(1536)` column. Inngest functions `handbook-ingest` and `ingest-page`, and in v2 `handbook-reindex`.

**Edge cases.**
- 429 from OpenAI: automatic step retry and throttle on the function.
- Changing the embedding model: re-embed the whole handbook, and a new migration if the dimension changes (ADR 003).
- Badly chosen chunk size: the retrieval eval shows it, not intuition.

**Test.** Retrieval eval: for each golden question, is the correct page in the top results (recall@k)?

## 7. Roles and preventing data leaks (v1)

**Goal.** Each user sees only data their role allows: employee only their own leave and data, manager their team, HR everyone. Code guarantees this, not the prompt. If the model is fooled, nothing should still leak.

**Flow.**
1. Better Auth reads the session, and `userId`, `role` and `teamId` are passed from the session to the run. None of them come from message text or model arguments.
2. Before calling the model, the tool list is filtered by role. `getTeamExpenses` is never given to an employee's model, so there is nothing to abuse.
3. Each tool checks again: it takes `userId` and `teamId` from the server context and puts them in the query's `WHERE`. If the model sends another team's `teamId`, it is ignored.
4. Last layer (optional in v1, recommended in v2): Postgres Row Level Security. Even a wrongly written query gets no unauthorized rows back.
5. The model's answer is built only from tool results, so data a tool did not return is not in the answer.

**Parts.** Session middleware in Hono, `toolsForRole(role)`, a server-built `ToolContext` passed to tools, and RLS policies on `leave_requests` and `expenses`.

**Edge cases.**
- An employee asks "What is my colleague's salary?": no tool exists for it; the answer is a polite "I don't have access".
- Prompt injection in handbook text or a message: since authorization is in code, the worst case is a bad answer, not a leak.
- A manager moved to another team: role and team are read from the DB on every request, not from a stale cache.

**Test.** Leak tests in CI: for each role a set of "forbidden" questions runs and checks that no other user's or team's data appears in the answer or in tool calls. These must always be green; one red means do not merge.

## 8. Slack and MCP (v2)

**Goal.** Users can also talk to the assistant from Slack, and other tools (such as Claude or Cursor) can search the handbook through MCP. No new "brain" is built; only more entry points.

**Flow (Slack).**
1. Slack sends the message to a webhook in Hono. First: verify the Slack signature. Invalid means reject.
2. The server must reply within three seconds, so it only saves the message, sends `agent/run.requested`, and returns 200 immediately.
3. The Slack user id is linked to the internal user and role through `user_identities`. Unknown users get "connect your account first".
4. The same `agent` function that answers the web runs, with the same roles and tools.
5. At the end, a step posts the answer to the same thread through the Slack API. Slack's event id is the idempotency key so Slack retries do not create duplicate messages.

**Flow (MCP).** A small MCP server exposes `searchHandbook`. Auth with OAuth or a token, and the same role check inside the tool. Only read tools are exposed, never leave submission.

**Parts.** Route `/slack/events`, table `user_identities`, step `postToSlack`, and package `apps/mcp`.

**Edge cases.**
- Slack sends the same event twice: idempotency on the event id.
- Manager approval from a Slack button: the same `leave/decided` event the web sends, so `waitForEvent` sees no difference.
- The user writes in Slack and on the web at the same time: concurrency on `conversationId`.

**Test.** Unit test for signature verification, and an end-to-end test with a recorded Slack payload through to the posted answer.

## 9. Reminders and automatic follow-up (v2)

**Goal.** Two things: a request the manager has not answered is never lost; and a user can say "Every Monday at 9, send me my team's expense summary".

**Flow (manager follow-up).**
1. After a request is recorded, the leave function waits for `leave/decided` with `waitForEvent` and a three-day timeout. The wait uses no server resources.
2. On timeout, a reminder goes to the manager and it waits two more days.
3. If there is still no answer, the request escalates to HR and its status in `leave_requests` becomes `escalated`.

**Flow (user schedules).**
1. The model calls `createSchedule`. Input is structured (cron expression, time zone Europe/Stockholm, job type) and code validates it.
2. A row is saved in `schedules` with `next_run_at`. Schedules live in our DB, not as separate crons in Inngest.
3. One cron, `schedule-tick`, picks up due rows every minute and sends `agent/run.requested` for each. The next time is computed with `cron-parser` and saved.
4. The new run executes like any other and the result is sent to web or Slack.

**Parts.** Table `schedules`, tools `createSchedule`, `listSchedules`, `deleteSchedule`, function `schedule-tick`, and function `notify`.

**Edge cases.**
- The tick picks a row twice: idempotency key from `scheduleId` and the due time.
- Daylight saving change: the stored time zone lets cron-parser compute correctly.
- A user whose role changed: the scheduled run uses the user's current role, not the role at creation.

**Note.** Feature 2 uses a 48-hour timeout for the first wait; this feature extends it to the three-day/two-day reminder-then-escalate path in v2.

**Test.** Unit test for computing `next_run_at`, and an Inngest test with virtual time for the timeout and escalation path.

## 10. Memory and context management (v2)

**Goal.** Long conversations do not become slow, expensive or confused, and the assistant remembers important things across sessions. Three things are kept separate: history (every message in `messages`, forever), state (where we are now, such as a half-finished leave request), and context (what is actually given to the model on each call). In frontend terms, history is the store and context is a selector.

**Flow.**
1. For each run, `buildContext` builds the context: system prompt, a state summary, the user's relevant memories, and the last few messages.
2. If history exceeds a token cap, older messages are summarized (compaction) by a cheap model and the summary is saved in `conversations.summary`. Original messages are never deleted.
3. In-progress state (such as a leave request without an end date) is read from DB tables and added as a few lines to the system prompt. The model is never the source of truth for state.
4. Long-term memory: the `remember` tool saves only explicit user preferences in `memories` (for example "keep answers short"). The user can list and delete them.

**Parts.** `buildContext`, column `conversations.summary`, table `memories`, tools `remember` and `forget`.

**Edge cases.**
- The summary drops an important number: that is why numbers and statuses come from the DB, not from the summary.
- GDPR: memory is personal data; limited retention, deletable, and never sensitive data without an explicit request.
- One user's memory never appears in another user's context (the rule from feature 7).

**Test.** A long-conversation eval: a forty-message scenario where a detail from the start must still be used correctly at the end, plus token measurement per run.

## 11. Cost and resilience (v2)

**Goal.** Know what each run cost, stop one user from burning the budget, and keep the system up when OpenAI is slow or down. This is the question every enterprise customer asks in the first meeting.

**Flow.**
1. After each model call, usage (input and output tokens) is read from the AI SDK response and multiplied by the model price. The result is recorded in `runs.cost_usd` and in Langfuse.
2. Before each run, the user's spend today is compared with their cap. If over, a polite message with no model call.
3. The agent loop has a step cap (for example six tool calls) so a runaway loop does not burn money.
4. Each model call is in a step, so 429 or 500 errors are handled by Inngest's retry and backoff, and earlier steps are not re-run.
5. If it still fails after several attempts, a gateway (AI SDK provider registry or a managed gateway) switches to a fallback model. Finally, `onFailure` marks the run `failed` and the user gets a clear message.

**Parts.** Column `runs.cost_usd`, a daily usage table or view, `checkBudget`, and retry and throttle settings on functions.

**Edge cases.**
- The fallback model behaves differently: the same evals also run on the fallback model.
- Retry on an irreversible action: protected by an idempotency key (the leave feature).
- The open numbers in the spec (cost per run, latency) are filled from this data, not guessed.

**Test.** A test that mocks the model to return 429 twice and then answer, and checks the run succeeded and no action happened twice. Another test for the budget cap.

## 12. Router (only if evals show it is needed)

**Goal.** If one agent with all tools gets confused or expensive, first classify the request and send each type to its own simpler path. This feature is deliberately conditional: in v1 one agent with four or five tools is enough. An early router means an extra call, more latency, and one more place to be wrong.

**When to add it.** When evals show one of: frequent wrong tool choice, a prompt made expensive by many tools, or the expensive model called for simple questions.

**Flow.**
1. A cheap model with structured output returns one label: `handbook_qa`, `leave`, `expenses`, `other`. No tools, classification only.
2. Code picks the path with a `switch`. Deterministic paths (such as the expense report) have no agent loop at all; just a query and one model call to write the answer.
3. `other` or low confidence goes to the general agent, so nothing is lost.
4. If a path needs a full sub-agent, it is called with `step.invoke`.

**Parts.** `classifyIntent` with a Zod schema, and a new ADR recording the before and after numbers (accuracy, cost, latency).

**Edge cases.**
- A mixed message ("What's the leave policy, and book next week for me"): goes to the general agent.
- The router itself makes mistakes: it needs its own eval (classification accuracy).
- The router has nothing to do with security; role filtering stays inside the tools.

**Test.** A dataset of fifty labeled messages, and a comparison of all evals with and without the router. If it is not better, the router is not added.

## 13. Evals, tracing and the improvement loop (v1, extended in v2)

**Goal.** Every change to a prompt, model or tool is measured with numbers, not feel. This is the proof-of-quality layer, and the most important for an FDE interview: "I took it from 72% to 91% and these tests prove it."

**Flow (v1).**
1. About thirty golden questions with reference answers and source pages in one dataset file: handbook questions, leave cases (valid, incomplete, out of policy), and expense questions.
2. DeepEval TS on Vitest runs them: retrieval (recall@k), faithfulness to the source, correct citation, and deterministic checks of extracted leave fields.
3. The leak tests (feature 7) are a fixed part of this set.
4. They run in CI on every PR. A leak is a hard red; a quality drop beyond a threshold is red.
5. Every run is traced in Langfuse: prompt, tool calls, retrieved chunks, tokens and cost, with a shared `runId` to get from the DB to the trace.

**Flow (v2).**
1. Prompt-injection evals: text in a message or document saying "ignore your instructions".
2. An LLM judge for free-form answer quality, itself calibrated against hand-labeled samples.
3. Thumbs up/down in the web app attached as a score to the Langfuse trace.
4. Improvement loop: every bad production answer is reviewed and turned into a new eval case. Then it is fixed, and CI proves it does not come back.
5. Prompts are versioned (in code or Langfuse) and the prompt version is recorded on each run.

**Parts.** An `evals/` folder with datasets, a GitHub Actions workflow, Langfuse connected through OpenTelemetry in the AI SDK, and column `runs.prompt_version`.

**Edge cases.**
- Non-deterministic evals: temperature zero and reasonable thresholds, not an expectation of 100%.
- CI cost: a small set on every PR, the full set nightly.
- Personal data in traces: mask before sending to Langfuse, preferably self-hosted or in the EU region.

**Test.** This feature is the test. Success: a before/after table in the README, updated every time, that goes straight into the case study.

## 14. Deployment and operations (v2)

**Goal.** The system runs on a real cloud with a public URL, is built from reproducible code, and when something breaks you know what to do.

**Flow.**
1. Each app has a Dockerfile. Local docker compose brings up Postgres, the Inngest dev server and the servers.
2. Terraform on AWS: server on ECS Fargate or App Runner, Postgres on RDS with pgvector, secrets in Secrets Manager, all in eu-north-1 (Stockholm) for GDPR. The web app can stay on Vercel.
3. Inngest Cloud or self-hosted (Redis and Postgres); the choice is recorded in an ADR.
4. GitHub Actions: tests and evals, build the image, run migrations, deploy to staging, and production with manual approval.
5. Feature flags for new features (such as Slack or the router) to turn them on or off without a redeploy.
6. Automatic RDS backups with restore tests, Sentry for errors, and alerts on run failure rate and daily cost.
7. A short runbook: what to do if OpenAI is down, runs are stuck, or a leak is reported.

**Parts.** An `infra/` folder with Terraform, Dockerfiles, `docker-compose.yml`, deploy workflows, and `docs/runbook.md`.

**Edge cases.**
- A migration that breaks data: always run it first on staging with a copy of the data.
- Deploying during a long run (such as a three-day `waitForEvent`): renaming or reordering steps can break in-flight runs; step names must stay stable.
- Cloud cost for a personal project: after recording the demo and screenshots, staging can be shut down; Terraform rebuilds it with one command.

**Test.** A smoke test after every deploy (one handbook question and one leak check), and one full restore drill from backup.
