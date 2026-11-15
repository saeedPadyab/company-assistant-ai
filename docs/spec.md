# company-assistant, version 1

Product contract for the first version. Technical choices live in ADRs. Anything not listed under "In scope" is out of this version, even if it appears in the long-term project definition.

The company is simulated. Its policies are the public GitLab Handbook. Three roles exist: employee, manager, and HR. A person only sees and does what their role allows.

## Users

| Role | Pain this version addresses |
|---|---|
| Employee | Needs an answer from the handbook, with a link, and a way to submit a leave request and see its status. |
| Manager | Needs to approve or reject the team's leave requests, and to see the team's expense total. |
| HR | Same access as a manager for this version, across teams. Deeper HR workflows are out of scope. |

## In scope

Three jobs, one agent, one web app.

### 1. Answer a handbook question

The user asks a question such as "What is the travel expense limit?". The answer comes from the handbook and links to the exact page. If nothing relevant is found, the assistant says it does not know.

Retrieval in this version is vector search only: chunk the handbook, embed the chunks, search with pgvector, and return citations. Hybrid search, reranking, and incremental re-indexing are out of scope.

### 2. Submit a leave request

The user says "I need leave from 10 to 12 December". The model only extracts the fields into a schema. A deterministic policy engine decides whether the request is allowed and points at the handbook clause it used. The model never approves or rejects leave.

An allowed request is stored with status `pending`. The manager approves or rejects it on a page. The employee sees the status. A retried or duplicate submission is not stored twice.

### 3. Answer a team expense total

The manager asks "How much did my team spend this quarter?". One fixed SQL query returns the total grouped by category. There is no sandbox and no model-written code. An employee cannot ask this.

## Scenarios

### Handbook question

| User says | System result |
|---|---|
| "What is the travel expense limit?" | A short answer with a link to the handbook page the passage came from. |
| A question the handbook does not cover | The assistant says it does not know. It does not invent a policy. |

### Leave request

| User says | System result |
|---|---|
| "I need leave from 10 to 12 December." | The request is stored as `pending`, or refused with the handbook clause that makes it invalid. |
| The same request is submitted again | The existing request is returned. A second row is not created. |
| The manager approves it | Status becomes approved and the employee can see it. |
| The manager rejects it | Status becomes rejected and the employee can see it. |

### Team expenses

| User says | System result |
|---|---|
| A manager asks "How much did my team spend this quarter?" | A total grouped by category, for that manager's team only. |
| An employee asks the same question | The assistant cannot run the query. The employee does not learn another team's numbers. |

## Shape of the system

These constraints are part of the contract. Relaxing them is a new version, not a refactor hidden inside this one.

- One agent. The loop is ours, with a step cap. No router and no second agent.
- The server injects the user's identity and role. The model never supplies `userId` or `teamId`.
- Tools visible to the model are filtered by role.
- Context is the last few messages only. There is no separate summary state and no compactor.
- The web app has three surfaces: a streaming chat, "my requests", and the manager approval page.
- About 30 evaluation questions, each with the correct handbook page, plus a few cross-role data-leak tests. Both run in CI.
- Every request writes a JSON log line with a trace ID.

## Out of scope

Deliberately later. See `document/assistant-versions.html` for the full second version.

- Hybrid search, reranking, and hash-based incremental handbook updates
- A function started by an event after the request ends (Inngest), except handbook ingestion, which runs on Inngest in this version (ADR 004). Fixed steps are a workflow, such as a reminder or a handbook re-index. An uncertain next step, chosen by the model, is a background agent. Version 1 stores leave as `pending`; the manager's click is a new request
- Row-level security, rate limiting, and an audit log beyond request status
- Sandbox, code execution, charts, and free-form analysis
- Routing, handoff, and an analyst agent
- Splitting history, state, and context
- MCP server and Slack
- Prompt-injection defenses, PII redaction, and a red-team table
- Per-user token budgets, retry on provider rate limits in chat (ingestion retries through Inngest), and model fallback
- The full evaluation set, LLM-as-judge, and prompt versioning
- Langfuse, OpenTelemetry, Sentry, metrics, and alerts
- Playwright, production deployment, Terraform, feature flags, and backups

## Open numbers

The product owner will set these before implementation starts. They are part of the contract once filled in.

| Number | Value |
|---|---|
| Time to first token | to be decided |
| Maximum cost per question | to be decided |
| Simulated user count | to be decided |

## Done

Version 1 is done when all of the following are true:

- An employee asks a handbook question and gets an answer with a link to the page.
- An employee submits leave, a manager approves it, and the employee sees the new status.
- A manager sees their team's expense total, and an employee cannot.
- CI is green, including the evaluation questions and the cross-role leak tests.
- No role can read another role's data.

