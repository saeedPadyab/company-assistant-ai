import { afterAll, describe, expect, it } from "vitest"
import app, { createApp } from "./app.js"
import { closeDb } from "./db/client.js"

afterAll(() => closeDb())

describe("GET /health", () => {
  it("reports the database up when it answers", async () => {
    const response = await app.request("/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, db: "up" })
  })

  it("reports the database down without leaking the error", async () => {
    const failing = createApp({
      pingDb: () =>
        Promise.reject(
          new Error("connect ECONNREFUSED postgres://admin:secret@db.internal:5432/assistant"),
        ),
    })
    const response = await failing.request("/health")
    const text = await response.text()
    expect(response.status).toBe(503)
    expect(JSON.parse(text)).toEqual({ ok: false, db: "down" })
    expect(text).not.toMatch(/secret|postgres:\/\/|ECONNREFUSED/)
  })

  it("reports the database down when it is too slow", async () => {
    const slow = createApp({ pingDb: () => new Promise(() => {}), pingTimeoutMs: 20 })
    const response = await slow.request("/health")
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, db: "down" })
  })
})
