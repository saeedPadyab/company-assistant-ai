import { config } from "dotenv"

config()

/** The web app's origin: the only browser origin allowed to call this server with cookies. */
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000"

/** This server's own public URL; Better Auth builds its links and cookie settings from it. */
export const SERVER_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3001"

/**
 * The embedding model id (ADR 003). Read when it is used, not at import, so code and tests
 * that never embed do not need it. No default: the vector column width depends on this model.
 */
export function embeddingModelId(): string {
    const id = process.env.OPENAI_EMBEDDING_MODEL
    if (!id) throw new Error("OPENAI_EMBEDDING_MODEL is not set")
    return id
}
