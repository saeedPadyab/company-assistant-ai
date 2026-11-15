import { boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const userRole = pgEnum("user_role", ["employee", "manager", "hr"])

export type Role = (typeof userRole.enumValues)[number]

export const teams = pgTable("teams", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
})

// Our own users table, also used by Better Auth as its "user" model (src/auth.ts).
// role and teamId are ours: Better Auth may read them but never lets a client set them.
export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: userRole("role").notNull(),
    teamId: uuid("team_id")
        .notNull()
        .references(() => teams.id),
    // Columns Better Auth needs on its user model.
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// The three tables below belong to Better Auth; their columns follow its core schema.

/** A signed-in browser: the cookie holds `token`, which points at one row here. */
export const sessions = pgTable("sessions", {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/** How a user signs in. For email and password: providerId "credential" and the password hash. */
export const accounts = pgTable("accounts", {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/** Short-lived codes (email verification, password reset). */
export const verifications = pgTable("verifications", {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
