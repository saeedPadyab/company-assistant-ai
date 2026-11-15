import { hashPassword } from "better-auth/crypto"
import { config } from "dotenv"
import { and, eq } from "drizzle-orm"
import { closeDb, db } from "./client.js"
import { accounts, teams, users } from "./schema.js"
import { DEV_PASSWORD, SEED_TEAMS, SEED_USERS } from "./seed-data.js"

config()

if (process.env.NODE_ENV === "production") {
    throw new Error("The seed sets a public dev password; never run it in production")
}

await db
    .insert(teams)
    .values(SEED_TEAMS.map((name) => ({ name })))
    .onConflictDoNothing()

const teamRows = await db.select().from(teams)
const teamId = (name: string) => {
    const team = teamRows.find((row) => row.name === name)
    if (!team) throw new Error(`team ${name} is missing`)
    return team.id
}

await db
    .insert(users)
    .values(SEED_USERS.map((u) => ({ email: u.email, name: u.name, role: u.role, teamId: teamId(u.team) })))
    .onConflictDoNothing()

// Sign-up is closed, so the seed writes the password itself: one Better Auth
// "credential" account per user, holding the hash (never the plain password).
const passwordHash = await hashPassword(DEV_PASSWORD)
for (const { email } of SEED_USERS) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
    if (!user) throw new Error(`user ${email} is missing`)
    const existing = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")))
    if (existing.length === 0) {
        await db.insert(accounts).values({
            accountId: user.id,
            providerId: "credential",
            userId: user.id,
            password: passwordHash,
        })
    }
}

await closeDb()
