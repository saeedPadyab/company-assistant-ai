// Starts a full ingest: `pnpm --filter server handbook:ingest`.
// Needs the Inngest Dev Server (`pnpm --filter server inngest:dev`) and the server (`pnpm dev`).
// First import: loads .env, so the client sees INNGEST_DEV=1 and sends to the Dev Server.
// Without it the client is in cloud mode and asks for INNGEST_EVENT_KEY.
import "../config.js"
import { INGEST_REQUESTED, inngest } from "../inngest/client.js"
import { HANDBOOK_PAGES } from "./pages.js"

const { ids } = await inngest.send({ name: INGEST_REQUESTED, data: {} })
console.log(`sent ${INGEST_REQUESTED} (event ${ids[0]}) for ${HANDBOOK_PAGES.length} pages`)
console.log("follow the runs at http://localhost:8288")
