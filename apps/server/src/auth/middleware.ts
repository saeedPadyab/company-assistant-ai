import { eq } from "drizzle-orm"
import { createMiddleware } from "hono/factory"
import { db } from "../db/client.js"
import { type Role, users } from "../db/schema.js"
import { auth } from "./auth.js"

/** The signed-in user as the server knows it. Built only here, never from request input. */
export type CurrentUser = {
    id: string
    email: string
    name: string
    role: Role
    teamId: string
}

/** Hono env for routes behind `requireUser`: `c.get("user")` is the current user. */
export type AuthEnv = { Variables: { user: CurrentUser } }

/**
 * Lets the request through only with a valid session; otherwise 401.
 *
 * Better Auth checks the session cookie (signature, expiry, row in `sessions`).
 * Only the user id is taken from it: role and team are read from `users` on every
 * request, so a user moved to another team or role gets the new one on the next request.
 */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ error: "unauthorized" }, 401)

    const [row] = await db
        .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            teamId: users.teamId,
        })
        .from(users)
        .where(eq(users.id, session.user.id))
    if (!row) return c.json({ error: "unauthorized" }, 401)

    c.set("user", row)
    await next()
})
