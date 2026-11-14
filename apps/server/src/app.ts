import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { db } from "./db/client.js"

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

  app.get("/health", async (c) => {
    if (await databaseIsUp(pingDb, pingTimeoutMs)) {
      return c.json({ ok: true, db: "up" }, 200)
    }
    return c.json({ ok: false, db: "down" }, 503)
  })

  return app
}

const app = createApp({ pingDb: () => db.execute(sql`select 1`) })

export default app
