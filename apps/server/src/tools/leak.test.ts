import { afterAll, describe, expect, it } from "vitest"
import { ZodError } from "zod"
import { closeDb } from "../db/client.js"
import { SEED_USERS } from "../db/seed-data.js"
import { ctxFor, teamByName, userByEmail } from "../test/helpers.js"
import { ToolForbiddenError } from "./define.js"
import { listTeamMembers } from "./list-team-members.js"
import { buildTools } from "./registry.js"

/**
 * Leak tests: for each role, hostile inputs (another team's or user's id, as a fooled
 * model would send them) must never return data outside what the role may see.
 */

afterAll(() => closeDb())

const emailsOf = (rows: unknown) => (rows as { email: string }[]).map((row) => row.email).sort()
const seededEmails = (team: string) =>
    SEED_USERS.filter((u) => u.team === team)
        .map((u) => u.email)
        .sort()

describe("employee (Sara, Marketing)", () => {
    it("has no team tool at all", async () => {
        const tools = buildTools(await ctxFor("sara@example.com"))
        expect(tools.listTeamMembers).toBeUndefined()
    })

    it("gets only her own profile, even when the model names another user", async () => {
        const tools = buildTools(await ctxFor("sara@example.com"))
        const reza = await userByEmail("reza@example.com")

        expect(await tools.getMyProfile.execute({})).toMatchObject({ email: "sara@example.com" })
        await expect(tools.getMyProfile.execute({ userId: reza.id })).rejects.toThrow(ZodError)
        await expect(tools.getMyProfile.execute({ email: reza.email })).rejects.toThrow(ZodError)
    })

    it("cannot run the team tool even when it is called directly", async () => {
        const ctx = await ctxFor("sara@example.com")
        await expect(listTeamMembers.execute(ctx, {})).rejects.toThrow(ToolForbiddenError)
    })
})

describe("manager (Mina, Marketing)", () => {
    it("sees only the Marketing team", async () => {
        const tools = buildTools(await ctxFor("manager@example.com"))

        const rows = await tools.listTeamMembers.execute({})

        expect(emailsOf(rows)).toEqual(seededEmails("Marketing"))
        expect(JSON.stringify(rows)).not.toMatch(/reza@|neda@|hr@/)
    })

    it("never sees Engineering, whatever teamId the model sends", async () => {
        const tools = buildTools(await ctxFor("manager@example.com"))
        const engineering = await teamByName("Engineering")

        for (const hostile of [
            { teamId: engineering.id },
            { teamId: engineering.id, userId: (await userByEmail("reza@example.com")).id },
            { team: "Engineering" },
            { role: "hr" },
        ]) {
            await expect(tools.listTeamMembers.execute(hostile)).rejects.toThrow(ZodError)
        }
    })
})

describe("manager (Reza, Engineering)", () => {
    it("sees only the Engineering team", async () => {
        const tools = buildTools(await ctxFor("reza@example.com"))

        const rows = await tools.listTeamMembers.execute({})

        expect(emailsOf(rows)).toEqual(seededEmails("Engineering"))
        expect(JSON.stringify(rows)).not.toMatch(/sara@|manager@/)
    })
})

describe("HR (Ali)", () => {
    it("sees every team", async () => {
        const tools = buildTools(await ctxFor("hr@example.com"))

        const rows = await tools.listTeamMembers.execute({})

        expect(emailsOf(rows)).toEqual(SEED_USERS.map((u) => u.email).sort())
    })
})
