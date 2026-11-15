import { afterAll, describe, expect, it } from "vitest"
import app from "./app.js"
import { WEB_ORIGIN } from "./config.js"
import { closeDb, db } from "./db/client.js"
import { sessions } from "./db/schema.js"
import { DEV_PASSWORD } from "./db/seed-data.js"

afterAll(async () => {
    await db.delete(sessions)
    await closeDb()
})

const preflight = (origin: string) =>
    app.request("/api/auth/sign-in/email", {
        method: "OPTIONS",
        headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
        },
    })

describe("CORS", () => {
    it("lets the web app call the server with cookies", async () => {
        const response = await preflight(WEB_ORIGIN)

        expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN)
        expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    })

    it("gives any other origin no CORS headers", async () => {
        const response = await preflight("https://evil.example")

        expect(response.headers.get("access-control-allow-origin")).toBeNull()
    })

    it("puts CORS headers on a 401 too, so the web app can read it", async () => {
        const response = await app.request("/me", { headers: { origin: WEB_ORIGIN } })

        expect(response.status).toBe(401)
        expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN)
    })
})

// CSRF: another site makes the browser send a request that carries the user's cookie.
// Better Auth checks the Origin of every cookie-carrying POST against trustedOrigins.
describe("trusted origins", () => {
    const signIn = async () => {
        const response = await app.request("/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin: WEB_ORIGIN },
            body: JSON.stringify({ email: "sara@example.com", password: DEV_PASSWORD }),
        })
        expect(response.status).toBe(200)
        return response.headers.get("set-cookie")!.split(";")[0]
    }
    const signOutFrom = (origin: string, cookie: string) =>
        app.request("/api/auth/sign-out", { method: "POST", headers: { origin, cookie } })

    it("refuses a cookie-carrying request from another site, and the session survives", async () => {
        const cookie = await signIn()

        expect((await signOutFrom("https://evil.example", cookie)).status).toBe(403)
        expect((await app.request("/me", { headers: { cookie } })).status).toBe(200)
    })

    it("accepts the same request from the web app", async () => {
        const cookie = await signIn()

        expect((await signOutFrom(WEB_ORIGIN, cookie)).status).toBe(200)
        expect((await app.request("/me", { headers: { cookie } })).status).toBe(401)
    })
})
