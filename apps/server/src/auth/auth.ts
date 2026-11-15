import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { SERVER_URL, WEB_ORIGIN } from "../config.js"
import { db } from "../db/client.js"
import { accounts, sessions, users, verifications } from "../db/schema.js"

/**
 * Better Auth on our own tables. The keys of `schema` are Better Auth's model names,
 * the values our Drizzle tables, so its "user" is our `users` table.
 *
 * The secret comes from BETTER_AUTH_SECRET (Better Auth reads it itself). Without it,
 * dev and tests fall back to a public default with a warning; production refuses to start.
 */
export const auth = betterAuth({
    baseURL: SERVER_URL,
    basePath: "/api/auth",
    // Better Auth refuses state-changing requests (sign-in, sign-out) from any other origin.
    trustedOrigins: [WEB_ORIGIN],
    database: drizzleAdapter(db, {
        provider: "pg",
        schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    advanced: {
        // Our ids are Postgres uuids (gen_random_uuid), not Better Auth's random strings.
        database: { generateId: "uuid" },
        // Better Auth turns its CSRF origin check off when it detects a test run. Keep it on
        // everywhere, so the tests exercise the same check production runs.
        disableOriginCheck: false,
    },
    emailAndPassword: {
        enabled: true,
        // Users come only from the seed (later an admin). Open sign-up would let anyone in.
        disableSignUp: true,
    },
    user: {
        additionalFields: {
            // input: false means no client request can set these; only our server code writes them.
            role: { type: ["employee", "manager", "hr"], required: true, input: false },
            teamId: { type: "string", required: true, input: false },
        },
    },
    telemetry: { enabled: false },
})

export type Auth = typeof auth
