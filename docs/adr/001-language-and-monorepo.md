# ADR 001: TypeScript, pnpm, and a monorepo

- Status: accepted
- Date: 2026-11-01

## Decision

Version 1 is a TypeScript monorepo with `strict` turned on. Packages are linked with pnpm workspaces and tasks are run with Turborepo. The web app and the HTTP server are separate apps from the first commit. The server lives in `apps/server`, not `apps/api`: the folder holds auth, the database, and the agent, and `api` sounds like a thin list of routes.

## Options rejected

- **Python as the application language.** One language for the API, the web app, and the agent, with types shared across them. A Python service would split the contract in `docs/spec.md` across two codebases before the product works.
- **A single Next.js app that also serves the API.** The agent core has to stay callable later from an MCP server and from Slack without going through the website. Those channels are out of version 1, but the folder boundary is cheap now and expensive after the core sits inside the web app.

## Reason

The language and the repo shape are the decisions every later file sits on. Strict TypeScript is also how generated code is checked: the compiler rejects a drifted type instead of leaving it for a reviewer to notice.

## Consequences

- The toolchain is Node, pnpm, and Turborepo. A person should be able to install, typecheck, and test from the repository root.
- `apps/web` and `apps/server` do not import each other's internals. Shared types will live in a package when there is something to share. The web app may import the server's route types for the Hono client.
- Evaluations use the DeepEval TypeScript SDK, which runs on Vitest. Python is not required for that. The Python SDK is still ahead on dataset synthesis, benchmarks, and prompt optimization, none of which version 1 needs.
