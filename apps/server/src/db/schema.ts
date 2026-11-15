import {
    boolean,
    index,
    integer,
    pgEnum,
    pgTable,
    text,
    timestamp,
    unique,
    uuid,
    vector,
} from "drizzle-orm/pg-core"

export const userRole = pgEnum("user_role", ["employee", "manager", "hr"])

export type Role = (typeof userRole.enumValues)[number]

export const teams = pgTable("teams", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
})

// Our own users table, also used by Better Auth as its "user" model (src/auth/auth.ts).
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

/** Width of `handbook_chunks.embedding`. Fixed by the embedding model (ADR 003); a new model width needs a new migration. */
export const EMBEDDING_DIMENSIONS = 1536

/**
 * One piece of a handbook page, small enough to embed and to quote as a source.
 * A page is stored as chunks 0..n-1; (page_url, chunk_index) is unique, so ingesting a page
 * again overwrites its chunks instead of adding copies.
 */
export const handbookChunks = pgTable(
    "handbook_chunks",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        /** The page without an anchor, e.g. https://handbook.gitlab.com/handbook/people-group/paid-time-off/ */
        pageUrl: text("page_url").notNull(),
        pageTitle: text("page_title").notNull(),
        /** The heading the chunk sits under; the page title for text before the first heading. */
        section: text("section").notNull(),
        /** The link a citation opens: pageUrl plus the section's #anchor. */
        url: text("url").notNull(),
        chunkIndex: integer("chunk_index").notNull(),
        content: text("content").notNull(),
        tokenCount: integer("token_count").notNull(),
        /** Hash of the page's cleaned text. Same hash on the next ingest: nothing to redo (v2 re-index). */
        pageHash: text("page_hash").notNull(),
        /** Empty until the chunk's embedding batch has run (ADR 004: chunks are stored first, embedded later). */
        embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
        unique("handbook_chunks_page_chunk_unique").on(t.pageUrl, t.chunkIndex),
        // HNSW: an approximate nearest-neighbour index, so a search does not compare the
        // question with every row. vector_cosine_ops matches the `<=>` (cosine distance) queries.
        index("handbook_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    ],
)
