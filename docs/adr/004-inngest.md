# ADR 004: Inngest for durable workflows, starting with handbook ingestion

- Status: accepted
- Date: 2026-11-15

## Decision

Version 1 runs handbook ingestion as Inngest functions inside the Hono server, served at `/api/inngest` with the `inngest` TypeScript SDK. Two functions:

- `handbook-ingest`, started by a manual event, lists the pages and sends one event per page.
- `ingest-page` handles one page, at most five at a time, with each embedding batch in its own `step.run`.

Inngest records the result of every finished step. When a step fails, the function is retried from the top, finished steps return their recorded result without running again, and work continues at the step that failed. Retries on 429 and other errors are Inngest's step retries, with a throttle on `ingest-page` to stay under the embedding rate limit.

Step results are stored by Inngest and have a size limit, so a step returns counts and ids only, never chunk text or vectors. The text lives in Postgres between steps.

Locally, the Inngest Dev Server (`npx inngest-cli@latest dev`) runs next to `pnpm dev` and calls the server's endpoint. Tests use `@inngest/test`, which runs a function in process with no Dev Server and lets a test make a single step fail.

Only ingestion uses Inngest in this version. The agent loop, leave approval with `waitForEvent`, reminders and the nightly re-index come later, each in its own issue. Langfuse, which `docs/features.md` groups with this ADR, gets its own ADR when tracing is built.

## Options rejected

- **A plain script.** One process that loops over the pages is simpler until it fails on page 300 of 2,000. It then starts again from page one and pays again for every embedding it already made, unless we write our own checkpoint table, retry and backoff, and concurrency limit. That is the part Inngest already does.
- **A job queue on Postgres or Redis (pg-boss, BullMQ).** It retries a job, but a job is the unit. Resuming inside a job, at the batch that failed, would still be our own code. BullMQ also adds Redis to version 1.
- **A hosted workflow engine with its own workers (Temporal).** Durable in the same way, but it needs its own server and worker processes. That is more to run than this project needs.

## Reason

Ingestion is a fixed sequence of steps that calls a paid, rate-limited API many times. A failure halfway must not cost the work already done. Inngest gives step-level resume, retries, concurrency and throttling as configuration on the function, and the same model fits the later workflows in `docs/features.md` (approval waits, reminders, re-index).

## Consequences

- Local development runs one more process, the Inngest Dev Server. It is not started by `pnpm dev`.
- Production needs Inngest Cloud or a self-hosted Inngest server, and `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`. Deployment is version 2 and decides which.
- `docs/spec.md` listed Inngest as out of scope for version 1. It now lists ingestion as the one Inngest workflow in version 1; event-started work after a request (reminders, background agents) stays out of scope.
- Code inside a function must be safe to run again: anything outside a `step.run` runs on every retry, and a step may run more than once if it fails after writing. Writes are idempotent (upserts keyed on page and chunk).
- Changing a function's steps while runs are in flight can confuse resume. Ingestion runs are short and started by hand, so that is accepted for now.
