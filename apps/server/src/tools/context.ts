import type { CurrentUser } from "../auth/middleware.js"
import type { Role } from "../db/schema.js"

/**
 * Who is calling a tool. Built only on the server, from the session user that
 * requireUser read from the database; never from message text or model arguments.
 */
export type ToolContext = Readonly<{
    userId: string
    role: Role
    teamId: string
}>

export function toolContextFor(user: CurrentUser): ToolContext {
    return Object.freeze({ userId: user.id, role: user.role, teamId: user.teamId })
}
