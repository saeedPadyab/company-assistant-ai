import { NonRetriableError } from "inngest"
import { HANDBOOK_PAGES } from "../handbook/pages.js"
import { INGEST_REQUESTED, PAGE_REQUESTED, ingestRequestedData, inngest } from "./client.js"

/**
 * Fan-out: one `handbook/page.requested` event per page. Each page then runs as its own
 * `ingest-page` run, so one bad page fails alone and the others go on.
 */
export const handbookIngest = inngest.createFunction(
    { id: "handbook-ingest", triggers: [{ event: INGEST_REQUESTED }] },
    async ({ event, step }) => {
        const parsed = ingestRequestedData.safeParse(event.data ?? {})
        // Bad input will be just as bad on a retry: fail once, with the reason.
        if (!parsed.success) throw new NonRetriableError(`bad ${INGEST_REQUESTED} data: ${parsed.error.message}`)

        const urls = parsed.data.urls ?? HANDBOOK_PAGES
        await step.sendEvent(
            "fan-out-pages",
            urls.map((url) => ({ name: PAGE_REQUESTED, data: { url } })),
        )
        return { pages: urls.length }
    },
)
