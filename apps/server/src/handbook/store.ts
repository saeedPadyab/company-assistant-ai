import { and, count, eq, gte, isNull, sql } from "drizzle-orm"
import { db } from "../db/client.js"
import { handbookChunks } from "../db/schema.js"
import type { Chunk } from "./chunk.js"

export interface PageToStore {
    pageUrl: string
    pageTitle: string
    pageHash: string
    chunks: Chunk[]
}

/** Counts only: this is a step result, and step results never carry text (ADR 004). */
export interface StoredPage {
    chunkCount: number
    /** Chunks with no embedding yet: new ones and ones whose text changed. */
    toEmbed: number
}

/**
 * Writes a page's chunks, safe to run any number of times:
 * - a chunk that already exists (same page, same index) is overwritten, not added again;
 * - its embedding is kept if the text is the same, and cleared if the text changed,
 *   so a re-run does not pay for embeddings it already has;
 * - chunks past the new end (the page got shorter) are deleted.
 * One transaction: a crash halfway leaves the page as it was before.
 */
export async function storePage(page: PageToStore): Promise<StoredPage> {
    return db.transaction(async (tx) => {
        if (page.chunks.length > 0) {
            await tx
                .insert(handbookChunks)
                .values(
                    page.chunks.map((c) => ({
                        pageUrl: page.pageUrl,
                        pageTitle: page.pageTitle,
                        pageHash: page.pageHash,
                        section: c.section,
                        url: c.url,
                        chunkIndex: c.chunkIndex,
                        content: c.content,
                        tokenCount: c.tokenCount,
                    })),
                )
                .onConflictDoUpdate({
                    target: [handbookChunks.pageUrl, handbookChunks.chunkIndex],
                    // `excluded` is Postgres's name for the row we tried to insert.
                    set: {
                        pageTitle: sql`excluded.page_title`,
                        pageHash: sql`excluded.page_hash`,
                        section: sql`excluded.section`,
                        url: sql`excluded.url`,
                        content: sql`excluded.content`,
                        tokenCount: sql`excluded.token_count`,
                        embedding: sql`CASE WHEN ${handbookChunks.content} = excluded.content THEN ${handbookChunks.embedding} ELSE NULL END`,
                        updatedAt: sql`now()`,
                    },
                })
        }

        const thisPage = eq(handbookChunks.pageUrl, page.pageUrl)
        await tx.delete(handbookChunks).where(and(thisPage, gte(handbookChunks.chunkIndex, page.chunks.length)))

        const [{ toEmbed }] = await tx
            .select({ toEmbed: count() })
            .from(handbookChunks)
            .where(and(thisPage, isNull(handbookChunks.embedding)))
        return { chunkCount: page.chunks.length, toEmbed }
    })
}
