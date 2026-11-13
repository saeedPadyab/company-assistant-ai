import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core"

export const userRole = pgEnum("user_role", ["employee", "manager", "hr"])

export const teams = pgTable("teams", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
})

export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: userRole("role").notNull(),
    teamId: uuid("team_id")
        .notNull()
        .references(() => teams.id),
})