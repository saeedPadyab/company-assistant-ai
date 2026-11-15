import { MockEmbeddingModelV4 } from "ai/test"
import { EMBEDDING_DIMENSIONS } from "../db/schema.js"

/**
 * A stand-in for the OpenAI embedding model: no network, no key, no cost, same answer every run.
 * Each word adds 1 to one of the 1536 dimensions (picked by a hash of the word), and the vector
 * is scaled to length 1. Texts that share words get a high cosine similarity, so search tests
 * still mean something, without knowing anything about meaning.
 */
export function fakeVector(text: string): number[] {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let hash = 0
        for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
        vector[hash % EMBEDDING_DIMENSIONS] += 1
    }
    const length = Math.hypot(...vector) || 1
    return vector.map((v) => v / length)
}

/**
 * The fake model, and the texts it embedded, in order, so tests can see what was paid for.
 * With failOnCall: n, call number n throws, like an API that is down, and embeds nothing.
 */
export function fakeEmbeddingModel({ failOnCall }: { failOnCall?: number } = {}) {
    const embeddedTexts: string[] = []
    let calls = 0
    const model = new MockEmbeddingModelV4({
        // Like OpenAI's embedding models. The mock's default is 1, which would turn one
        // embedMany of 50 chunks into 50 calls, so "fail on call 2" would hit batch 0.
        maxEmbeddingsPerCall: 2048,
        doEmbed: async ({ values }) => {
            calls++
            if (calls === failOnCall) throw new Error("embedding API unavailable")
            embeddedTexts.push(...values)
            return { embeddings: values.map(fakeVector), warnings: [] }
        },
    })
    return { model, embeddedTexts }
}
