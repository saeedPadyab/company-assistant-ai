import { eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "../db/client.js"
import { teams, users } from "../db/schema.js"
import { defineTool } from "./define.js"

export const getMyProfile = defineTool({
    name: "getMyProfile",
    description: "The signed-in user's own name, email, role and team.",
    roles: ["employee", "manager", "hr"],
    // No arguments: whose profile is decided by ctx.userId, not by the model.
    input: z.strictObject({}),
    async execute(ctx) {
        const [row] = await db
            .select({ name: users.name, email: users.email, role: users.role, team: teams.name })
            .from(users)
            .innerJoin(teams, eq(teams.id, users.teamId))
            .where(eq(users.id, ctx.userId))
        return row ?? null
    },
})
