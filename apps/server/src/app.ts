import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve as serveInngest } from "inngest/hono"
import { WEB_ORIGIN } from "./config.js"
import { auth } from "./auth/auth.js"
import { requireUser } from "./auth/middleware.js"
import { db } from "./db/client.js"
import { inngest } from "./inngest/client.js"
import { functions } from "./inngest/functions.js"

export type AppDeps = {
  /** Runs a trivial query; resolves when the database answers. */
  pingDb: () => Promise<unknown>
  /** How long the ping may take before the database counts as down. */
  pingTimeoutMs?: number
}

async function databaseIsUp(ping: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([ping().then(() => true), timeout])
  } catch {
    // The error may hold the connection string or credentials: never expose it.
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function createApp({ pingDb, pingTimeoutMs = 2000 }: AppDeps) {
  const app = new Hono()

  // The web app (another origin: port 3000) calls this server from the browser with its
  // session cookie. Only that origin gets CORS headers, and credentials are allowed.
  // Registered first, so it also covers 401s and errors from the routes below.
  app.use(
    "*",
    cors({
      origin: WEB_ORIGIN,
      credentials: true,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  )

  app.get("/health", async (c) => {
    if (await databaseIsUp(pingDb, pingTimeoutMs)) {
      return c.json({ ok: true, db: "up" }, 200)
    }
    return c.json({ ok: false, db: "down" }, 503)
  })

  // Better Auth answers everything under /api/auth (sign-in, sign-out, get-session, ...).
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

  // Who am I? Role and team come fresh from the database (see requireUser).
  app.get("/me", requireUser, (c) => c.json(c.get("user")))

  // Inngest calls this route to learn the functions (PUT) and to run their steps (POST).
  // No user session here: outside dev mode the SDK checks Inngest's request signature
  // (INNGEST_SIGNING_KEY), and with INNGEST_DEV=1 only the local Dev Server calls it.
  const inngestHandler = serveInngest({ client: inngest, functions })
  app.on(["GET", "POST", "PUT"], "/api/inngest", (c) => inngestHandler(c))

  return app
}

const app = createApp({ pingDb: () => db.execute(sql`select 1`) })

export default app
