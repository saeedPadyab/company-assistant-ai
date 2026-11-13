import { describe, expect, it } from "vitest"
import app from "./app.js"

describe("GET /health", () => {
  it("returns ok", async () => {
    const response = await app.request("/health")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})