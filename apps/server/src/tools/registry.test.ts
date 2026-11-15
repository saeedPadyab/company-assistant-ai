import { describe, expect, it } from "vitest"
import { allTools, buildTools, toolsForRole } from "./registry.js"

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name).sort()

describe("toolsForRole", () => {
    it("gives an employee no manager or HR tools", () => {
        const employeeTools = toolsForRole("employee")

        expect(names(employeeTools)).toEqual(["getMyProfile"])
        for (const tool of employeeTools) expect(tool.roles).toContain("employee")
    })

    it("gives a manager and HR the team tool", () => {
        expect(names(toolsForRole("manager"))).toEqual(["getMyProfile", "listTeamMembers"])
        expect(names(toolsForRole("hr"))).toEqual(["getMyProfile", "listTeamMembers"])
    })

    it("hands each role exactly the tools whose roles list it", () => {
        for (const role of ["employee", "manager", "hr"] as const) {
            const expected = allTools.filter((tool) => tool.roles.includes(role))
            expect(names(toolsForRole(role))).toEqual(names(expected))
        }
    })
})

describe("buildTools", () => {
    it("binds only the role's tools", () => {
        const ctx = { userId: "u", role: "employee", teamId: "t" } as const
        expect(Object.keys(buildTools(ctx))).toEqual(["getMyProfile"])
    })

    it("has no tool whose input schema accepts an identity field", () => {
        for (const tool of allTools) {
            for (const key of ["userId", "teamId", "role"]) {
                expect(tool.input.safeParse({ [key]: "x" }).success, `${tool.name} accepts ${key}`).toBe(false)
            }
        }
    })
})
