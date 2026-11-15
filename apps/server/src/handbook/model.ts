import { openai } from "@ai-sdk/openai"
import type { EmbeddingModel } from "ai"
import { embeddingModelId } from "../config.js"

/**
 * The model that embeds handbook chunks and search questions. Both must be the same model,
 * or the vectors are not comparable. Its own module so tests can swap it for a fake one.
 */
export function handbookEmbeddingModel(): EmbeddingModel {
    return openai.embedding(embeddingModelId())
}
