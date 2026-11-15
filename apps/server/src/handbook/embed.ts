import { embedMany } from "ai"
import { and, asc, eq, gte, isNull, lt } from "drizzle-orm"
import { db } from "../db/client.js"
import { EMBEDDING_DIMENSIONS, handbookChunks } from "../db/schema.js"
import { handbookEmbeddingModel } from "./model.js"

/**
 * Chunks per embedding call, and per Inngest step. Smaller batches lose less work when one
 * fails; larger ones make fewer calls. 50 chunks of at most 400 tokens is 20k tokens, far
 * under the API's per-call limit.
 */
export const EMBED_BATCH_SIZE = 50

export function batchCount(chunkCount: number): number {
    return Math.ceil(chunkCount / EMBED_BATCH_SIZE)
}

/**
 * Embeds batch `batchIndex` of a page: chunks batchIndex*50 .. batchIndex*50+49.
 * Only chunks without an embedding are sent, so running a batch again (a retry, a second
 * ingest) costs nothing for the chunks it already did.
 */
export async function embedBatch(pageUrl: string, batchIndex: number): Promise<{ embedded: number }> {
    const from = batchIndex * EMBED_BATCH_SIZE
    const rows = await db
        .select({ id: handbookChunks.id, content: handbookChunks.content })
        .from(handbookChunks)
        .where(
            and(
                eq(handbookChunks.pageUrl, pageUrl),
                gte(handbookChunks.chunkIndex, from),
                lt(handbookChunks.chunkIndex, from + EMBED_BATCH_SIZE),
                isNull(handbookChunks.embedding),
            ),
        )
        .orderBy(asc(handbookChunks.chunkIndex))
    if (rows.length === 0) return { embedded: 0 }

    const { embeddings } = await embedMany({
        model: handbookEmbeddingModel(),
        values: rows.map((r) => r.content),
        // No retries here: the Inngest step retries, with backoff, and knows about 429s.
        // Retrying in both places would multiply the attempts.
        maxRetries: 0,
    })
    if (embeddings.some((e) => e.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(`the embedding model returned vectors that are not ${EMBEDDING_DIMENSIONS} wide (ADR 003)`)
    }

    await db.transaction(async (tx) => {
        for (const [i, row] of rows.entries()) {
            await tx.update(handbookChunks).set({ embedding: embeddings[i] }).where(eq(handbookChunks.id, row.id))
        }
    })
    return { embedded: rows.length }
}
