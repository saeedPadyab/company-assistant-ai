import { handbookIngest } from "./handbook-ingest.js"
import { ingestPage } from "./ingest-page.js"

/** Every Inngest function this server serves at /api/inngest. */
export const functions = [handbookIngest, ingestPage]
