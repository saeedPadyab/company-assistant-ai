import type { Role } from "./schema.js"

/**
 * DEV ONLY. Every seeded person signs in with this password, locally and in tests.
 * It is public on purpose (it is in git); the seed refuses to run in production.
 */
export const DEV_PASSWORD = "dev-password-123"

export const SEED_TEAMS = ["Marketing", "Engineering"] as const

type SeedUser = { email: string; name: string; role: Role; team: (typeof SEED_TEAMS)[number] }

/** One manager and one employee per team, plus HR, so cross-team leaks can be tested. */
export const SEED_USERS: readonly SeedUser[] = [
    { email: "sara@example.com", name: "Sara", role: "employee", team: "Marketing" },
    { email: "manager@example.com", name: "Mina", role: "manager", team: "Marketing" },
    { email: "neda@example.com", name: "Neda", role: "employee", team: "Engineering" },
    { email: "reza@example.com", name: "Reza", role: "manager", team: "Engineering" },
    { email: "hr@example.com", name: "Ali", role: "hr", team: "Engineering" },
]
