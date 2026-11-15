import { InngestTestEngine } from "@inngest/test"
import { and, asc, eq, isNotNull } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { closeDb, db } from "../db/client.js"
import { handbookChunks } from "../db/schema.js"
import { EMBED_BATCH_SIZE } from "../handbook/embed.js"
import { PageFetchError, fetchPage } from "../handbook/fetch.js"
import { HANDBOOK_PAGES } from "../handbook/pages.js"
import { fakeEmbeddingModel } from "../test/fake-embedding.js"
import { INGEST_REQUESTED, PAGE_REQUESTED } from "./client.js"
import { handbookIngest } from "./handbook-ingest.js"
import { ingestPage } from "./ingest-page.js"

// No network in these tests: fetchPage and the embedding model are replaced.
const fake = vi.hoisted(() => ({ current: undefined as ReturnType<typeof fakeEmbeddingModel> | undefined }))
vi.mock("../handbook/model.js", () => ({ handbookEmbeddingModel: () => fake.current!.model }))
vi.mock("../handbook/fetch.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../handbook/fetch.js")>()),
    fetchPage: vi.fn(),
}))

const PAGE_URL = "https://handbook.gitlab.com/handbook/ingest-test/"
const SECTIONS = EMBED_BATCH_SIZE * 2 + 20 // three batches: 50, 50, 20

/** A handbook-shaped page with one short section per heading, so one chunk per section. */
function testPage(): string {
    const sections = Array.from(
        { length: SECTIONS },
        (_, i) => `<h2 id="rule-${i}">Rule ${i}</h2><p>Expense rule number ${i} applies to travel.</p>`,
    )
    return `<html><body><div class="td-content"><h1>Ingest test</h1>${sections.join("")}</div></body></html>`
}

// A tuple, not an array: the test engine wants at least one event.
const pageEvent = (url = PAGE_URL): [{ name: string; data: { url: string } }] => [{ name: PAGE_REQUESTED, data: { url } }]

function rows() {
    return db.select().from(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL)).orderBy(asc(handbookChunks.chunkIndex))
}

beforeEach(async () => {
    fake.current = fakeEmbeddingModel()
    vi.mocked(fetchPage).mockReset().mockResolvedValue(testPage())
    await db.delete(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL))
})
afterAll(async () => {
    await db.delete(handbookChunks).where(eq(handbookChunks.pageUrl, PAGE_URL))
    await closeDb()
})

describe("ingest-page", () => {
    // A new engine for every run. One engine keeps the step results of its last run and
    // replays them, like Inngest does within one run; separate runs need separate engines.
    const run = (options: Parameters<InngestTestEngine["execute"]>[0]) => new InngestTestEngine({ function: ingestPage }).execute(options)

    it("stores every chunk with a link to its section and an embedding", async () => {
        const { result } = await run({ events: pageEvent() })
        expect(result).toEqual({ url: PAGE_URL, chunkCount: SECTIONS, embedded: SECTIONS })

        const stored = await rows()
        expect(stored).toHaveLength(SECTIONS)
        expect(stored[7]).toMatchObject({ url: `${PAGE_URL}#rule-7`, section: "Rule 7", pageTitle: "Ingest test" })
        expect(stored.every((r) => r.embedding !== null)).toBe(true)
    })

    it("runs one step per embedding batch, and step results hold counts, never text", async () => {
        const { ctx } = await run({ events: pageEvent() })
        const stepRun = vi.mocked(ctx.step.run).mock
        expect(stepRun.calls.map(([id]) => id)).toEqual(["fetch-and-chunk", "embed-batch-0", "embed-batch-1", "embed-batch-2"])

        // What each step returned (the engine's `state` is keyed by hashed step ids, so read the spy).
        const results = await Promise.all(stepRun.results.map((r) => r.value))
        expect(results).toEqual([
            { chunkCount: SECTIONS, toEmbed: SECTIONS },
            { embedded: EMBED_BATCH_SIZE },
            { embedded: EMBED_BATCH_SIZE },
            { embedded: SECTIONS - 2 * EMBED_BATCH_SIZE },
        ])
    })

    it("adds no chunks and pays for no embeddings when the page is ingested again", async () => {
        await run({ events: pageEvent() })
        const { result } = await run({ events: pageEvent() })

        expect(result).toEqual({ url: PAGE_URL, chunkCount: SECTIONS, embedded: 0 })
        expect(await rows()).toHaveLength(SECTIONS)
        expect(fake.current!.embeddedTexts).toHaveLength(SECTIONS)
    })

    it("after a failed batch, embeds only what is left, not the batches already done", async () => {
        // The model fails on its second call, which is batch 1: the real step code runs and throws.
        // (Mocking the step itself with `steps: [...]` does not work here: the engine hands the
        // function `undefined` instead of throwing, so the run would fail for the wrong reason.)
        fake.current = fakeEmbeddingModel({ failOnCall: 2 })
        const failed = await run({ events: pageEvent() })
        expect(failed.result).toBeUndefined()
        const embeddedAfterFailure = await db
            .select({ chunkIndex: handbookChunks.chunkIndex })
            .from(handbookChunks)
            .where(and(eq(handbookChunks.pageUrl, PAGE_URL), isNotNull(handbookChunks.embedding)))
        expect(embeddedAfterFailure.map((r) => r.chunkIndex).sort((a, b) => a - b)).toEqual(
            Array.from({ length: EMBED_BATCH_SIZE }, (_, i) => i),
        )
        expect(fake.current!.embeddedTexts).toHaveLength(EMBED_BATCH_SIZE)

        // The retry, with a model that works again. Real Inngest would not even run the finished
        // steps again; here they do run, and still send nothing to the model for batch 0.
        const before = fake.current!.embeddedTexts
        fake.current = fakeEmbeddingModel()
        const { result } = await run({ events: pageEvent() })
        expect(result).toEqual({ url: PAGE_URL, chunkCount: SECTIONS, embedded: SECTIONS - EMBED_BATCH_SIZE })
        expect(fake.current.embeddedTexts).toHaveLength(SECTIONS - EMBED_BATCH_SIZE)
        expect(new Set([...before, ...fake.current.embeddedTexts]).size).toBe(SECTIONS)
    })

    it("refuses a URL outside the handbook without fetching it", async () => {
        const { error } = await run({ events: pageEvent("https://evil.example/handbook/") })
        // The engine may hand back the Error itself or its serialized form.
        expect(error instanceof Error ? error.message : JSON.stringify(error)).toMatch(/handbook\.gitlab\.com/)
        expect(fetchPage).not.toHaveBeenCalled()
    })

    it("stores nothing for a page that is not found", async () => {
        vi.mocked(fetchPage).mockRejectedValue(new PageFetchError(PAGE_URL, 404))
        const { result } = await run({ events: pageEvent() })
        expect(result).toBeUndefined()
        expect(await rows()).toHaveLength(0)
    })
})

describe("handbook-ingest", () => {
    const runIngest = (options: Parameters<InngestTestEngine["execute"]>[0]) =>
        new InngestTestEngine({ function: handbookIngest }).execute(options)
    // Sending events needs the Inngest server; the step is replaced, and the test checks what it was given.
    const steps = [{ id: "fan-out-pages", handler: () => ({ ids: [] }) }]

    it("sends one page event for every page in the list", async () => {
        const { ctx, result } = await runIngest({ events: [{ name: INGEST_REQUESTED, data: {} }], steps })
        expect(result).toEqual({ pages: HANDBOOK_PAGES.length })
        expect(ctx.step.sendEvent).toHaveBeenCalledWith(
            "fan-out-pages",
            HANDBOOK_PAGES.map((url) => ({ name: PAGE_REQUESTED, data: { url } })),
        )
    })

    it("uses the urls in the event when there are some", async () => {
        const { ctx } = await runIngest({ events: [{ name: INGEST_REQUESTED, data: { urls: [PAGE_URL] } }], steps })
        expect(ctx.step.sendEvent).toHaveBeenCalledWith("fan-out-pages", [{ name: PAGE_REQUESTED, data: { url: PAGE_URL } }])
    })
})
