import { createHash } from "node:crypto"
import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base"
import type { CleanPage } from "./clean.js"

/** One chunk, ready to store in handbook_chunks (pageUrl, title and hash are added per page). */
export interface Chunk {
    chunkIndex: number
    /** Heading path joined with " › ", or the page title for text before the first heading. */
    section: string
    /** The page link plus the section's #anchor. */
    url: string
    /** "Page title › section" on the first line, then the text. */
    content: string
    tokenCount: number
}

export interface ChunkOptions {
    /** Upper limit for a chunk, heading line included. */
    maxTokens: number
    /** How many tokens from the end of a chunk are repeated at the start of the next one in the same section. */
    overlapTokens: number
}

// A starting point, not a measured one: the retrieval eval (step 8) decides.
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 400, overlapTokens: 50 }

/** Tokens as the embedding model counts them: text-embedding-3-* use the cl100k_base encoding. */
export function countTokens(text: string): number {
    return encode(text).length
}

/** Hash of the cleaned page. The same text gives the same hash, whatever changed in the page's HTML around it. */
export function hashPage(page: CleanPage): string {
    return createHash("sha256").update(JSON.stringify(page)).digest("hex")
}

/**
 * Splits a cleaned page into chunks. A chunk never crosses a heading, so its link points at
 * the one section it came from. A long section becomes several chunks with a small overlap,
 * so a sentence cut at the boundary is still whole in one of them.
 */
export function chunkPage(page: CleanPage, pageUrl: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
    const chunks: Chunk[] = []
    for (const s of page.sections) {
        const section = s.headings.length > 0 ? s.headings.join(" › ") : page.title
        // The heading line goes into every chunk: "Airfare" alone says little, "Global Travel and
        // Expense Policy › 4. Procedures › Airfare" tells the embedding what the text is about.
        const headingLine = s.headings.length > 0 ? `${page.title} › ${section}` : page.title
        const url = s.anchor ? `${pageUrl}#${s.anchor}` : pageUrl
        // One token of slack: tokens of joined text can differ by one from the sum of the parts.
        const bodyBudget = options.maxTokens - countTokens(`${headingLine}\n\n`) - 1

        for (const body of packBlocks(s.blocks, bodyBudget, options.overlapTokens)) {
            const content = `${headingLine}\n\n${body}`
            chunks.push({ chunkIndex: chunks.length, section, url, content, tokenCount: countTokens(content) })
        }
    }
    return chunks
}

/**
 * Packs blocks, in order, into pieces of at most maxTokens. Blocks stay whole unless one is
 * longer than maxTokens on its own. Each piece after the first starts with the last
 * overlapTokens tokens of the piece before it.
 */
export function packBlocks(blocks: string[], maxTokens: number, overlapTokens: number): string[] {
    const units = blocks.flatMap((block) => (countTokens(block) > maxTokens ? splitByTokens(block, maxTokens) : [block]))
    const pieces: string[] = []
    let current: string[] = []

    for (const unit of units) {
        if (current.length > 0 && countTokens([...current, unit].join("\n")) > maxTokens) {
            const finished = current.join("\n")
            pieces.push(finished)
            const tail = overlapTokens > 0 ? lastTokens(finished, overlapTokens) : ""
            // Keep the overlap only if it still leaves room for the next block.
            current = tail && countTokens(`${tail}\n${unit}`) <= maxTokens ? [tail] : []
        }
        current.push(unit)
    }
    if (current.length > 0) pieces.push(current.join("\n"))
    return pieces
}

// Cutting a token list and decoding it does not always give text with that many tokens:
// trim() removes the space that belonged to a token (" explains" is one token, "explains"
// may be two), and a word cut in half can encode differently on its own. So both helpers
// below count the result again and shrink the cut until it fits.

/** Last resort for one very long block: cut it into pieces of at most maxTokens. */
function splitByTokens(text: string, maxTokens: number): string[] {
    const tokens = encode(text)
    const parts: string[] = []
    let start = 0
    while (start < tokens.length) {
        let end = Math.min(start + maxTokens, tokens.length)
        let part = decode(tokens.slice(start, end)).trim()
        while (end > start + 1 && countTokens(part) > maxTokens) {
            end--
            part = decode(tokens.slice(start, end)).trim()
        }
        if (part) parts.push(part)
        start = end
    }
    return parts
}

/** The end of text, at most n tokens long once trimmed. */
function lastTokens(text: string, n: number): string {
    const tokens = encode(text)
    let start = Math.max(0, tokens.length - n)
    let tail = decode(tokens.slice(start)).trim()
    while (start < tokens.length - 1 && countTokens(tail) > n) {
        start++
        tail = decode(tokens.slice(start)).trim()
    }
    return tail
}
