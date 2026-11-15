# ADR 005: Better Auth on our own users table, sign-up closed

- Status: accepted
- Date: 2026-11-15

## Decision

Version 1 signs people in with Better Auth, email and password, mounted in the Hono server at `/api/auth/*`. Its Drizzle adapter uses our existing `users` table as its user model. Better Auth adds only `sessions`, `accounts` and `verifications`, and four columns on `users` (`email_verified`, `image`, `created_at`, `updated_at`). Ids are Postgres uuids like the rest of the schema.

`role` and `teamId` stay our columns. Better Auth knows them as additional fields with `input: false`, so no request can set them. Public sign-up is turned off (`emailAndPassword.disableSignUp`). People come from the seed, later from an admin action.

The session only proves who the caller is. On every request the middleware takes the user id from the session and reads `role` and `team_id` from `users` again. A user moved to another team gets the new team on the next request.

## Options rejected

- **Writing auth ourselves.** Password hashing, session tokens, cookie flags, expiry and CSRF are easy to get almost right. Better Auth is a library inside our server, not a hosted service, so the data stays in our Postgres.
- **A hosted provider (Clerk, Auth0).** Users and roles would live in a second system that has to be kept in sync with `users.team_id`. Every request would depend on it, and tests would need it or a mock of it.
- **Better Auth's own `user` table next to ours.** Two tables for one person, joined by email or id, and two places a role could come from. One table keeps role and team where the queries already read them.
- **Open sign-up.** Anyone who reached the page could create an account. With roles in the same table, one wrong default or one missed `input: false` would let a stranger pick `hr`.
- **Role and team stored in the session or the cookie.** Cheaper per request, but stale: a manager moved to another team would keep seeing the old team until the session expired. That is the leak `docs/features.md` section 7 rules out.

## Reason

RBAC has to be decided by code from data the server owns. Keeping auth inside the server, on our own `users` table, with no way for a client to create users or set roles, leaves exactly one source for "who is this and what may they see": the `users` row, read fresh on each request.

## Consequences

- Each authenticated request does one extra primary-key read of `users`. That is cheap at this scale; caching it would bring back the stale-team problem.
- Production needs `BETTER_AUTH_SECRET` (Better Auth refuses to start without it there) and `BETTER_AUTH_URL`. Dev and tests fall back to Better Auth's public default secret with a warning.
- The seed writes a public dev password (`dev-password-123`) as a Better Auth credential account and refuses to run with `NODE_ENV=production`.
- Adding users needs an admin path, which does not exist yet. Until then, new users are seeded.
- Better Auth's telemetry is turned off.
- The web app on port 3000 talks to the server on port 3001, so CORS and `trustedOrigins` have to allow that origin with credentials.
- Row-level security on data tables is still optional in version 1 (ADR 002). The session and the `ToolContext` built from it are what every query filters on until then.
