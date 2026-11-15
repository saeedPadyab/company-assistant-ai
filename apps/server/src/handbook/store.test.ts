import { and, asc, eq, isNull } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { closeDb, db } from "../db/client.js"
import { handbookChunks } from "../db/schema.js"
import { fakeEmbeddingModel } from "../test/fake-embedding.js"
import type { Chunk } from "./chunk.js"
import { EMBED_BATCH_SIZE, embedBatch } from "./embed.js"
import { storePage } from "./store.js"

// vi.mock is moved above the imports, so the fake has to be created in vi.hoisted.
const fake = vi.hoisted(() => ({ current: undefined as ReturnType<typeof fakeEmbeddingModel> | undefined }))
vi.mock("./model.js", () => ({ handbookEmbeddingModel: () => fake.current!.model }))

// A page no real ingest writes, so cleanup leaves real chunks alone.
const PAGE_URL = "https://handbook.gitlab.com/handbook/store-test/"

function chunks(n: number, text = (i: number) => `Rule ${i} about expenses.`): Chunk[] {
    return Array.from({ length: n }, (_, i) => ({
        chunkIndex: i,
        section: `Section ${i}`,
        url: `${PAGE_URL}#section-${i}`,
        content: text(i),
        tokenCount: 5,
    }))
}

function page(list: Chunk[]) {
    return { pageUrl: PAGE_URL, pageTitle: "Store test", pageHash: "hash", chunks: list }
}

function rows() {
    return db.select().from(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL)).orderBy(asc(handbookChunks.chunkIndex))
}

beforeEach(async () => {
    fake.current = fakeEmbeddingModel()
    await db.delete(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL))
})
afterAll(async () => {
    await db.delete(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL))
    await closeDb()
})

describe("storePage", () => {
    it("stores the chunks without embeddings and says how many need one", async () => {
        expect(await storePage(page(chunks(3)))).toEqual({ chunkCount: 3, toEmbed: 3 })
        const stored = await rows()
        expect(stored.map((r) => [r.chunkIndex, r.url, r.embedding])).toEqual([
            [0, `${PAGE_URL}#section-0`, null],
            [1, `${PAGE_URL}#section-1`, null],
            [2, `${PAGE_URL}#section-2`, null],
        ])
    })

    it("does not duplicate chunks or drop embeddings when the same page is stored again", async () => {
        await storePage(page(chunks(3)))
        await embedBatch(PAGE_URL, 0)

        expect(await storePage(page(chunks(3)))).toEqual({ chunkCount: 3, toEmbed: 0 })
        const stored = await rows()
        expect(stored).toHaveLength(3)
        expect(stored.every((r) => r.embedding !== null)).toBe(true)
    })

    it("clears the embedding of a chunk whose text changed, and only that one", async () => {
        await storePage(page(chunks(3)))
        await embedBatch(PAGE_URL, 0)

        const changed = chunks(3, (i) => (i === 1 ? "A new rule about travel." : `Rule ${i} about expenses.`))
        expect(await storePage(page(changed))).toEqual({ chunkCount: 3, toEmbed: 1 })
        const empty = await db
            .select({ chunkIndex: handbookChunks.chunkIndex })
            .from(handbookChunks)
            .where(and(eq(handbookChunks.pageUrl, PAGE_URL), isNull(handbookChunks.embedding)))
        expect(empty).toEqual([{ chunkIndex: 1 }])
    })

    it("deletes chunks past the end when a page gets shorter", async () => {
        await storePage(page(chunks(5)))
        await storePage(page(chunks(2)))
        expect((await rows()).map((r) => r.chunkIndex)).toEqual([0, 1])
    })
})

describe("embedBatch", () => {
    it("embeds only the chunks of its own batch", async () => {
        await storePage(page(chunks(EMBED_BATCH_SIZE + 3)))
        expect(await embedBatch(PAGE_URL, 1)).toEqual({ embedded: 3 })
        expect(fake.current!.embeddedTexts).toEqual([0, 1, 2].map((i) => `Rule ${EMBED_BATCH_SIZE + i} about expenses.`))

        const stored = await rows()
        expect(stored.filter((r) => r.embedding !== null).map((r) => r.chunkIndex)).toEqual([0, 1, 2].map((i) => EMBED_BATCH_SIZE + i))
    })

    it("sends nothing to the model for chunks that already have an embedding", async () => {
        await storePage(page(chunks(3)))
        await embedBatch(PAGE_URL, 0)
        fake.current!.embeddedTexts.length = 0

        expect(await embedBatch(PAGE_URL, 0)).toEqual({ embedded: 0 })
        expect(fake.current!.embeddedTexts).toEqual([])
    })
})
