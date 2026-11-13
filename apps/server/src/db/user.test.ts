import { afterAll, describe, expect, it } from "vitest"
import { closeDb, db } from "./client.js"
import { users } from "./schema.js"

afterAll(() => closeDb())

describe("users", () => {
    it("reads the seeded people", async () => {
        const rows = await db.select().from(users)
        const emails = rows.map((row) => row.email).sort()
        expect(emails).toEqual([
            "hr@example.com",
            "manager@example.com",
            "sara@example.com",
        ])
    })
})