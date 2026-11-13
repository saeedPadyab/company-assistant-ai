# ADR 002: Postgres, Drizzle, and pgvector

- Status: accepted
- Date: 2026-11-01

## Decision

Version 1 stores all application data in Postgres, running locally in Docker. Schema and migrations are written with Drizzle. Handbook embeddings live in the same database through pgvector.

## Options rejected

- **Prisma.** It generates more for you, and hides more of the SQL. Row-level security and vector queries are easier to read, and to trust, in SQL we wrote. Drizzle stays close to that SQL.
- **A separate vector database.** Pinecone or Qdrant would be a second service to run, back up, and keep in sync with the rows the chunks belong to. This simulation does not need that scale. Vectors sit next to the handbook chunks.

## Reason

There is one database to start, one place for users, requests, and embeddings, and one migration history. Putting vectors in Postgres is the decision that avoids a second store while the handbook is still small.

## Consequences

- Local development depends on Docker Compose with a Postgres image that includes pgvector.
- We write a bit more query code than Prisma would generate.
- Changing the embedding model later means re-embedding the handbook. The vector column width is fixed when the first migration is written.
- Row-level security is out of version 1, but queries are written as explicit SQL so it can be added in the database without replacing the client.
