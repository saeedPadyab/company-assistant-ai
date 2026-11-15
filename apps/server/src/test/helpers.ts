import { eq } from "drizzle-orm"
import app from "../app.js"
import { db } from "../db/client.js"
import { teams, users } from "../db/schema.js"
import { DEV_PASSWORD } from "../db/seed-data.js"
import { type ToolContext, toolContextFor } from "../tools/context.js"

/** Signs a seeded user in through Better Auth and returns the session cookie ("name=value"). */
export async function signIn(email: string): Promise<string> {
    const response = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: DEV_PASSWORD }),
    })
    const cookie = response.headers.get("set-cookie")
    if (response.status !== 200 || !cookie) throw new Error(`sign-in failed for ${email}: ${response.status}`)
    return cookie.split(";")[0]
}

export async function userByEmail(email: string) {
    const [user] = await db.select().from(users).where(eq(users.email, email))
    if (!user) throw new Error(`no seeded user ${email}`)
    return user
}

export async function teamByName(name: string) {
    const [team] = await db.select().from(teams).where(eq(teams.name, name))
    if (!team) throw new Error(`no seeded team ${name}`)
    return team
}

/** The ToolContext the server would build for this seeded user. */
export async function ctxFor(email: string): Promise<ToolContext> {
    return toolContextFor(await userByEmail(email))
}
