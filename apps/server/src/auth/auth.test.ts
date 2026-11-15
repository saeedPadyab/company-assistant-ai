import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"
import app from "../app.js"
import { closeDb, db } from "../db/client.js"
import { users } from "../db/schema.js"
import { DEV_PASSWORD } from "../db/seed-data.js"
import { deleteTestSessions, signIn, teamByName, userByEmail } from "../test/helpers.js"

afterAll(async () => {
    await deleteTestSessions()
    await closeDb()
})

describe("GET /me", () => {
    it("is 401 without a session", async () => {
        const response = await app.request("/me")
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: "unauthorized" })
    })

    it("is 401 with a forged session cookie", async () => {
        const response = await app.request("/me", {
            headers: { cookie: "better-auth.session_token=forged.value" },
        })
        expect(response.status).toBe(401)
    })

    it("returns the signed-in user with role and team from the database", async () => {
        const sara = await userByEmail("sara@example.com")
        const cookie = await signIn(sara.email)

        const response = await app.request("/me", { headers: { cookie } })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            id: sara.id,
            email: "sara@example.com",
            name: "Sara",
            role: "employee",
            teamId: sara.teamId,
        })
    })

    it("is 401 again after sign-out", async () => {
        const cookie = await signIn("sara@example.com")
        const out = await app.request("/api/auth/sign-out", {
            method: "POST",
            headers: { cookie, origin: "http://localhost:3001" },
        })
        expect(out.status).toBe(200)

        const response = await app.request("/me", { headers: { cookie } })
        expect(response.status).toBe(401)
    })

    it("shows a user moved to another team the new team on the next request", async () => {
        const sara = await userByEmail("sara@example.com")
        const engineering = await teamByName("Engineering")
        const cookie = await signIn(sara.email)
        try {
            await db.update(users).set({ teamId: engineering.id }).where(eq(users.id, sara.id))

            const response = await app.request("/me", { headers: { cookie } })

            expect((await response.json()).teamId).toBe(engineering.id)
        } finally {
            await db.update(users).set({ teamId: sara.teamId }).where(eq(users.id, sara.id))
        }
    })

    it("shows a user whose role changed the new role on the next request", async () => {
        const sara = await userByEmail("sara@example.com")
        const cookie = await signIn(sara.email)
        try {
            await db.update(users).set({ role: "manager" }).where(eq(users.id, sara.id))

            const promoted = await app.request("/me", { headers: { cookie } })
            expect((await promoted.json()).role).toBe("manager")

            await db.update(users).set({ role: "employee" }).where(eq(users.id, sara.id))

            const demoted = await app.request("/me", { headers: { cookie } })
            expect((await demoted.json()).role).toBe("employee")
        } finally {
            await db.update(users).set({ role: sara.role }).where(eq(users.id, sara.id))
        }
    })
})

describe("sign-up", () => {
    it("is closed: nobody can create an account, let alone pick a role", async () => {
        const response = await app.request("/api/auth/sign-up/email", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                email: "intruder@example.com",
                password: DEV_PASSWORD,
                name: "Intruder",
                role: "hr",
                teamId: "00000000-0000-0000-0000-000000000000",
            }),
        })

        expect(response.status).toBe(400)
        const rows = await db.select().from(users).where(eq(users.email, "intruder@example.com"))
        expect(rows).toEqual([])
    })
})
