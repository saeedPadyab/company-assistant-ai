import type { z } from "zod"
import type { Role } from "../db/schema.js"
import type { ToolContext } from "./context.js"

/**
 * One tool the model may call.
 *
 * - `roles`: who gets this tool at all (toolsForRole filters on it).
 * - `input`: a strict Zod object (z.strictObject) with NO identity fields: userId and
 *   teamId come from `ctx`, so an extra key like `teamId` from the model is rejected.
 * - `execute`: gets `ctx` from the server, never from the model.
 */
export type ToolDefinition<Input extends z.ZodType = z.ZodType, Output = unknown> = {
    name: string
    description: string
    roles: readonly Role[]
    input: Input
    // Method syntax on purpose: lets a tool with a specific input sit in a list of tools.
    execute(ctx: ToolContext, input: z.infer<Input>): Promise<Output>
}

export function defineTool<Input extends z.ZodType, Output>(
    tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
    return tool
}

/** Thrown when a tool runs for a role it was not built for (a second check after toolsForRole). */
export class ToolForbiddenError extends Error {
    constructor(tool: string, role: Role) {
        super(`${tool} is not allowed for role ${role}`)
        this.name = "ToolForbiddenError"
    }
}
