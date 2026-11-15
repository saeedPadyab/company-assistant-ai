import { afterEach, describe, expect, it, vi } from "vitest"
import { OffSiteRedirectError, PageFetchError, fetchPage, normalizeHandbookUrl } from "./fetch.js"

const PAGE = "https://handbook.gitlab.com/handbook/finance/expenses/"

/** A stand-in for fetch's Response: only what fetchPage reads. `url` is where redirects ended. */
function respond(url: string, status = 200, body = "<html></html>") {
    vi.stubGlobal("fetch", vi.fn(async () => ({ url, status, ok: status >= 200 && status < 300, text: async () => body })))
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("normalizeHandbookUrl", () => {
    it("drops the #fragment and ?query and adds the trailing slash", () => {
        expect(normalizeHandbookUrl("https://handbook.gitlab.com/handbook/finance/expenses?x=1#travel")).toBe(PAGE)
    })

    it("leaves a normalized URL as it is", () => {
        expect(normalizeHandbookUrl(PAGE)).toBe(PAGE)
    })
})

describe("fetchPage", () => {
    it("returns the page's HTML", async () => {
        respond(PAGE, 200, "<p>hi</p>")
        expect(await fetchPage(PAGE)).toBe("<p>hi</p>")
    })

    it("follows a redirect that stays in the handbook", async () => {
        respond("https://handbook.gitlab.com/handbook/finance/spending/", 200, "<p>moved</p>")
        expect(await fetchPage(PAGE)).toBe("<p>moved</p>")
    })

    it("refuses a page whose redirect ended outside the handbook", async () => {
        respond("https://evil.example/handbook/finance/expenses/", 200, "<p>not policy</p>")
        await expect(fetchPage(PAGE)).rejects.toBeInstanceOf(OffSiteRedirectError)
    })

    it("throws with the status on a non-2xx answer", async () => {
        respond(PAGE, 404)
        await expect(fetchPage(PAGE)).rejects.toMatchObject({ name: PageFetchError.name, status: 404 })
    })

    it("does not fetch a URL outside the handbook", async () => {
        respond(PAGE)
        await expect(fetchPage("https://evil.example/")).rejects.toThrow(/not a handbook URL/)
        expect(fetch).not.toHaveBeenCalled()
    })
})
