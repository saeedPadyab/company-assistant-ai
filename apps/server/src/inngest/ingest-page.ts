import { APICallError } from "ai"
import { NonRetriableError, RetryAfterError } from "inngest"
import { chunkPage, hashPage } from "../handbook/chunk.js"
import { cleanPage } from "../handbook/clean.js"
import { batchCount, embedBatch } from "../handbook/embed.js"
import { OffSiteRedirectError, PageFetchError, fetchPage } from "../handbook/fetch.js"
import { storePage } from "../handbook/store.js"
import { PAGE_REQUESTED, inngest, pageRequestedData } from "./client.js"

/**
 * One page: fetch, clean, chunk and store it in one step, then embed it batch by batch,
 * one step per batch. Inngest records each finished step; after a failure the run starts
 * again from the top, finished steps return their recorded result without running, and
 * work goes on at the step that failed (ADR 004).
 *
 * Step results are counts only. The chunk text goes to Postgres, not into the step result.
 */
export const ingestPage = inngest.createFunction(
    {
        id: "ingest-page",
        triggers: [{ event: PAGE_REQUESTED }],
        // At most five pages at a time, and at most 30 page runs started per minute, to stay
        // under the embedding API's rate limit (docs/features.md, feature 6).
        // And one run per page: two runs of one page could otherwise interleave, and the older
        // run write the embedding of the old text onto a chunk the newer run just rewrote.
        // The key is the URL as handbook-ingest sends it, already normalized (client.ts).
        concurrency: [{ limit: 5 }, { key: "event.data.url", limit: 1 }],
        throttle: { limit: 30, period: "1m" },
        retries: 4,
    },
    async ({ event, step }) => {
        const parsed = pageRequestedData.safeParse(event.data)
        if (!parsed.success) throw new NonRetriableError(`bad ${PAGE_REQUESTED} data: ${parsed.error.message}`)
        const { url } = parsed.data

        const stored = await step.run("fetch-and-chunk", async () => {
            const html = await fetchPage(url).catch((error: unknown) => {
                // A missing page stays missing: no point retrying. A 5xx or a timeout may pass.
                if (error instanceof PageFetchError && error.status >= 400 && error.status < 500) {
                    throw new NonRetriableError(error.message)
                }
                if (error instanceof OffSiteRedirectError) throw new NonRetriableError(error.message)
                throw error
            })
            let page
            try {
                page = cleanPage(html)
            } catch (error) {
                // Not a handbook page (no content area): fetching it again gives the same HTML.
                throw new NonRetriableError(error instanceof Error ? error.message : String(error))
            }
            return storePage({ pageUrl: url, pageTitle: page.title, pageHash: hashPage(page), chunks: chunkPage(page, url) })
        })

        let embedded = 0
        for (let i = 0; i < batchCount(stored.chunkCount); i++) {
            const result = await step.run(`embed-batch-${i}`, () => embedBatch(url, i).catch(rethrowRateLimit))
            embedded += result.embedded
        }

        return { url, chunkCount: stored.chunkCount, embedded }
    },
)

/**
 * A 429 from the embedding API: retry when the API says it is ready again (its
 * retry-after header), not on Inngest's normal backoff schedule.
 */
export function rethrowRateLimit(error: unknown): never {
    if (APICallError.isInstance(error) && error.statusCode === 429) {
        const seconds = Number(error.responseHeaders?.["retry-after"])
        throw new RetryAfterError("embedding API rate limit (429)", Number.isFinite(seconds) && seconds > 0 ? `${Math.ceil(seconds)}s` : "30s", {
            cause: error,
        })
    }
    throw error
}
