import { eq } from "drizzle-orm"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { closeDb, db } from "./client.js"
import { EMBEDDING_DIMENSIONS, handbookChunks } from "./schema.js"

// A page no real ingest writes, so cleanup leaves real chunks alone.
const PAGE_URL = "https://handbook.test/handbook/schema-test/"

function chunk(chunkIndex: number, embedding: number[] | null = null) {
    return {
        pageUrl: PAGE_URL,
        pageTitle: "Schema test",
        section: "Schema test",
        url: `${PAGE_URL}#schema-test`,
        chunkIndex,
        content: `chunk ${chunkIndex}`,
        tokenCount: 2,
        pageHash: "hash",
        embedding,
    }
}

afterEach(() => db.delete(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL)))
afterAll(() => closeDb())

describe("handbook_chunks", () => {
    it("stores a chunk without an embedding, then with one", async () => {
        await db.insert(handbookChunks).values(chunk(0))
        const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS)
        await db.update(handbookChunks).set({ embedding: vector }).where(eq(handbookChunks.pageUrl, PAGE_URL))

        const [row] = await db.select().from(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL))
        expect(row.embedding).toHaveLength(EMBEDDING_DIMENSIONS)
        expect(row.embedding?.[1]).toBeCloseTo(1 / EMBEDDING_DIMENSIONS)
    })

    it("refuses a second chunk with the same page and index", async () => {
        await db.insert(handbookChunks).values(chunk(0))
        await expect(db.insert(handbookChunks).values(chunk(0))).rejects.toThrow()
    })

    it("refuses a vector of the wrong width", async () => {
        await expect(db.insert(handbookChunks).values(chunk(0, [0.1, 0.2, 0.3]))).rejects.toThrow()
    })
})
