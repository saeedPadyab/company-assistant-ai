import { asc, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "../db/client.js"
import { teams, users } from "../db/schema.js"
import { defineTool, ToolForbiddenError } from "./define.js"

export const listTeamMembers = defineTool({
    name: "listTeamMembers",
    description:
        "People on the caller's team (manager) or on every team (HR): name, email, role and team.",
    roles: ["manager", "hr"],
    // No teamId argument: a manager's team is ctx.teamId; HR sees all teams.
    input: z.strictObject({}),
    async execute(ctx) {
        const query = db
            .select({ name: users.name, email: users.email, role: users.role, team: teams.name })
            .from(users)
            .innerJoin(teams, eq(teams.id, users.teamId))
            .orderBy(asc(teams.name), asc(users.name))

        // Checked again here, not only in toolsForRole: a wrongly wired tool still leaks nothing.
        if (ctx.role === "hr") return query
        if (ctx.role === "manager") return query.where(eq(users.teamId, ctx.teamId))
        throw new ToolForbiddenError("listTeamMembers", ctx.role)
    },
})
