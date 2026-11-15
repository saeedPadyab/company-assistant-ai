import { embed } from "ai"
import { and, asc, cosineDistance, inArray, isNotNull } from "drizzle-orm"
import { db } from "../db/client.js"
import { handbookChunks } from "../db/schema.js"
import { handbookEmbeddingModel } from "./model.js"

export interface SearchHit {
    pageUrl: string
    pageTitle: string
    section: string
    /** The citation link, with the section's #anchor. */
    url: string
    content: string
    /** Cosine distance, 0 = same direction, 2 = opposite. Smaller is closer. */
    distance: number
}

/**
 * Vector search: embed the question with the same model as the chunks, then let Postgres
 * return the k chunks closest by cosine distance (`<=>`, served by the HNSW index).
 * The agent's handbook tool will call this; the retrieval eval measures it.
 */
export async function searchHandbook(question: string, k = 5, pages?: string[]): Promise<SearchHit[]> {
    const { embedding } = await embed({ model: handbookEmbeddingModel(), value: question })
    const distance = cosineDistance(handbookChunks.embedding, embedding)
    const where = isNotNull(handbookChunks.embedding)
    return db
        .select({
            pageUrl: handbookChunks.pageUrl,
            pageTitle: handbookChunks.pageTitle,
            section: handbookChunks.section,
            url: handbookChunks.url,
            content: handbookChunks.content,
            distance: distance.mapWith(Number),
        })
        .from(handbookChunks)
        // `pages` limits the search to some pages: tests use it to stay out of real chunks.
        // The agent's tool must not let the model pass it: the tool takes the question only.
        .where(pages ? and(where, inArray(handbookChunks.pageUrl, pages)) : where)
        .orderBy(asc(distance))
        .limit(k)
}
