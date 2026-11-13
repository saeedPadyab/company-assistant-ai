# ADR 003: One model provider for version 1

- Status: accepted
- Date: 2026-11-01

## Decision

Version 1 uses OpenAI for both chat and embeddings. The application calls models through the Vercel AI SDK. The agent loop does not import a provider SDK itself. Model ids live in environment variables, not in code.

Starting ids, both overridable without a new ADR:

| Job | Environment variable | Starting id |
|---|---|---|
| Chat and tool calling | `OPENAI_CHAT_MODEL` | `gpt-4.1-mini` |
| Embeddings | `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` |

`text-embedding-3-small` produces 1536-dimensional vectors. The first migration uses that width.

## Options rejected

- **Two providers in version 1.** Anthropic for chat and OpenAI for embeddings means two keys, two bills, and two failure modes. A second provider, and fallback when the first one fails, is already scoped to version 2. The SDK boundary is what makes that swap a later change instead of a rewrite.
- **A local model.** Running Ollama on a laptop avoids a key, and it also makes tool calling and the evaluation score depend on whichever machine ran them. Version 1 needs one score that CI can reproduce.

## Reason

Chat and embeddings are different models, but they do not need to be different vendors yet. One provider keeps the first version small. Recording the ids as configuration keeps a model upgrade from pretending to be an architecture change.

## Consequences

- Local development and CI need an OpenAI API key. The key is never committed.
- Every handbook question and every chat turn spends money. The cost ceiling itself is still an open number in `docs/spec.md`.
- Switching the embedding id means re-embedding the handbook and, if the width changes, a new migration.
- The loop we write may use the SDK to talk to the model. It does not hand the loop over to a packaged agent framework.
