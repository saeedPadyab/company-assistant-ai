import { Inngest } from "inngest"
import { z } from "zod"
import { isHandbookUrl } from "../handbook/fetch.js"

// With INNGEST_DEV=1 (local .env) the SDK talks to the Dev Server and needs no keys.
// In production it needs INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY (ADR 004).
export const inngest = new Inngest({ id: "company-assistant" })

const handbookUrl = z.url().refine(isHandbookUrl, "must be a page on https://handbook.gitlab.com")

/** Starts a full ingest. Without `urls`, the pages in src/handbook/pages.ts. */
export const INGEST_REQUESTED = "handbook/ingest.requested"
export const ingestRequestedData = z.object({ urls: z.array(handbookUrl).min(1).optional() })

/** One page to fetch, chunk, embed and store. Sent by handbook-ingest, one per page. */
export const PAGE_REQUESTED = "handbook/page.requested"
export const pageRequestedData = z.object({ url: handbookUrl })
