import type { z } from "zod"
import type { Role } from "../db/schema.js"
import type { ToolContext } from "./context.js"
import type { ToolDefinition } from "./define.js"
import { getMyProfile } from "./get-my-profile.js"
import { listTeamMembers } from "./list-team-members.js"

/** Every tool the assistant has. A new tool is added here and nowhere else. */
export const allTools: readonly ToolDefinition[] = [getMyProfile, listTeamMembers]

/** The tools a role may have. The model of a role never sees the others, so it cannot call them. */
export function toolsForRole(role: Role): ToolDefinition[] {
    return allTools.filter((tool) => tool.roles.includes(role))
}

/** A tool ready to hand to the model: `ctx` is already inside, the model only gives `input`. */
export type BoundTool = {
    description: string
    inputSchema: z.ZodType
    execute(input: unknown): Promise<unknown>
}

/**
 * The tools for one request. `ctx` is captured in a closure: the model's arguments are
 * parsed with the tool's strict schema (extra keys such as `teamId` throw) and `ctx` is
 * passed next to them, so the model can never change who the tool runs as.
 * The shape (description, inputSchema, execute) matches the Vercel AI SDK's tools, wired in #16.
 */
export function buildTools(ctx: ToolContext): Record<string, BoundTool> {
    const tools: Record<string, BoundTool> = {}
    for (const tool of toolsForRole(ctx.role)) {
        tools[tool.name] = {
            description: tool.description,
            inputSchema: tool.input,
            // async: a rejected input becomes a rejected promise, not a synchronous throw.
            execute: async (input) => tool.execute(ctx, tool.input.parse(input)),
        }
    }
    return tools
}
