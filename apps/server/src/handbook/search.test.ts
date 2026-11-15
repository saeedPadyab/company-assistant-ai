import { eq, like } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { closeDb, db } from "../db/client.js"
import { handbookChunks } from "../db/schema.js"
import { fakeEmbeddingModel } from "../test/fake-embedding.js"
import { embedBatch } from "./embed.js"
import { hitAtK, loadGoldenQuestions, recallAtK } from "./recall.js"
import { searchHandbook } from "./search.js"
import { storePage } from "./store.js"

const fake = vi.hoisted(() => ({ current: undefined as ReturnType<typeof fakeEmbeddingModel> | undefined }))
vi.mock("./model.js", () => ({ handbookEmbeddingModel: () => fake.current!.model }))

// Two made-up pages under a path no real ingest writes.
const BASE = "https://handbook.gitlab.com/handbook/search-test/"
const LEAVE = `${BASE}leave/`
const TRAVEL = `${BASE}travel/`
// The search is limited to these two pages: the database may also hold a real ingest,
// whose OpenAI vectors mean nothing next to the fake ones.
const PAGES = [LEAVE, TRAVEL]

async function ingest(pageUrl: string, title: string, texts: string[]) {
    await storePage({
        pageUrl,
        pageTitle: title,
        pageHash: "hash",
        chunks: texts.map((content, i) => ({ chunkIndex: i, section: title, url: `${pageUrl}#s${i}`, content, tokenCount: 10 })),
    })
    await embedBatch(pageUrl, 0)
}

beforeAll(async () => {
    fake.current = fakeEmbeddingModel()
    await db.delete(handbookChunks).where(like(handbookChunks.pageUrl, `${BASE}%`))
    await ingest(LEAVE, "Leave", ["Parental leave is sixteen weeks of paid leave.", "Sick leave needs no doctor note."])
    await ingest(TRAVEL, "Travel", ["Book flights in economy class.", "Use a VPN on hotel wifi."])
})
afterAll(async () => {
    await db.delete(handbookChunks).where(like(handbookChunks.pageUrl, `${BASE}%`))
    await closeDb()
})

describe("searchHandbook", () => {
    it("returns the closest chunk first, with its citation link", async () => {
        const [top] = await searchHandbook("how many weeks of parental leave", 3, PAGES)
        expect(top).toMatchObject({ pageUrl: LEAVE, url: `${LEAVE}#s0`, pageTitle: "Leave" })
    })

    it("returns at most k chunks, closest first", async () => {
        const hits = await searchHandbook("vpn hotel wifi", 2, PAGES)
        expect(hits).toHaveLength(2)
        expect(hits[0].url).toBe(`${TRAVEL}#s1`)
        expect(hits[0].distance).toBeLessThanOrEqual(hits[1].distance)
    })

    it("skips chunks that have no embedding yet", async () => {
        await db.update(handbookChunks).set({ embedding: null }).where(eq(handbookChunks.pageUrl, TRAVEL))
        const hits = await searchHandbook("vpn hotel wifi", 10, PAGES)
        expect(hits.every((h) => h.pageUrl !== TRAVEL)).toBe(true)
        await embedBatch(TRAVEL, 0)
    })
})

describe("recall@k", () => {
    const runs = [
        { resultPageUrls: [LEAVE, TRAVEL], expectedPages: [LEAVE] },
        { resultPageUrls: [LEAVE, TRAVEL], expectedPages: [TRAVEL] },
        { resultPageUrls: [LEAVE, LEAVE], expectedPages: [TRAVEL] },
    ]

    it("counts a question as found when an expected page is in the top k", () => {
        expect(hitAtK([LEAVE, TRAVEL], [TRAVEL], 1)).toBe(false)
        expect(hitAtK([LEAVE, TRAVEL], [TRAVEL], 2)).toBe(true)
        expect(recallAtK(runs, 1)).toBeCloseTo(1 / 3)
        expect(recallAtK(runs, 2)).toBeCloseTo(2 / 3)
    })

    it("loads a golden set whose pages are all in the ingest list", () => {
        expect(loadGoldenQuestions().length).toBeGreaterThanOrEqual(10)
    })
})
