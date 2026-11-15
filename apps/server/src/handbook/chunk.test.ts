import { describe, expect, it } from "vitest"
import { chunkPage, countTokens, hashPage, packBlocks } from "./chunk.js"
import type { CleanPage } from "./clean.js"

const PAGE_URL = "https://handbook.gitlab.com/handbook/finance/travel/"

/** n distinct sentences, so overlap and order can be checked by content. */
function sentences(n: number, prefix = "Sentence"): string[] {
    return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1} explains one more rule about booking travel.`)
}

const page: CleanPage = {
    title: "Global Travel Policy",
    sections: [
        { headings: [], anchor: null, blocks: ["This policy applies to all team members."] },
        { headings: ["1. Policy", "Airfare"], anchor: "airfare", blocks: ["Book at least 14 days ahead."] },
        { headings: ["1. Policy", "Lodging"], anchor: "lodging", blocks: sentences(60) },
    ],
}

describe("chunkPage", () => {
    const options = { maxTokens: 120, overlapTokens: 20 }
    const chunks = chunkPage(page, PAGE_URL, options)

    it("links text before the first heading to the page itself", () => {
        expect(chunks[0]).toMatchObject({
            chunkIndex: 0,
            section: "Global Travel Policy",
            url: PAGE_URL,
            content: "Global Travel Policy\n\nThis policy applies to all team members.",
        })
    })

    it("links a section's chunk to its #anchor and starts it with the heading path", () => {
        expect(chunks[1]).toMatchObject({
            section: "1. Policy › Airfare",
            url: `${PAGE_URL}#airfare`,
            content: "Global Travel Policy › 1. Policy › Airfare\n\nBook at least 14 days ahead.",
        })
    })

    it("splits a long section into several chunks, none over the limit", () => {
        const lodging = chunks.filter((c) => c.section === "1. Policy › Lodging")
        expect(lodging.length).toBeGreaterThan(1)
        for (const c of lodging) {
            expect(c.url).toBe(`${PAGE_URL}#lodging`)
            expect(c.content.startsWith("Global Travel Policy › 1. Policy › Lodging\n\n")).toBe(true)
            expect(c.tokenCount).toBe(countTokens(c.content))
            expect(c.tokenCount).toBeLessThanOrEqual(options.maxTokens)
        }
    })

    it("loses no sentence when it splits", () => {
        const text = chunks.map((c) => c.content).join("\n")
        for (const s of sentences(60)) expect(text).toContain(s)
    })

    it("numbers chunks 0..n-1 across the whole page", () => {
        expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
    })

    it("gives the same chunks for the same page", () => {
        expect(chunkPage(page, PAGE_URL, options)).toEqual(chunks)
    })
    it("finishes when the heading line alone is longer than maxTokens", () => {
        const longHeading = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
        const page: CleanPage = { title: "T", sections: [{ headings: [longHeading], anchor: "x", blocks: sentences(30) }] }
        const chunks = chunkPage(page, "https://handbook.gitlab.com/handbook/t/", options)
        expect(chunks.length).toBeGreaterThan(0)
        expect(chunks.every((c) => c.content.startsWith(`T › ${longHeading}`))).toBe(true)
    })
})

describe("packBlocks", () => {
    it("repeats the end of one piece at the start of the next", () => {
        const pieces = packBlocks(sentences(20), 60, 15)
        expect(pieces.length).toBeGreaterThan(1)
        for (let i = 1; i < pieces.length; i++) {
            const firstLine = pieces[i].split("\n")[0]
            // The overlap is a tail of the previous piece, so it is not a whole sentence of its own.
            expect(pieces[i - 1].endsWith(firstLine)).toBe(true)
            expect(countTokens(firstLine)).toBeLessThanOrEqual(15)
        }
    })

    it("adds no overlap when it is 0", () => {
        const pieces = packBlocks(sentences(20), 60, 0)
        expect(pieces.join("\n").split("\n")).toEqual(sentences(20))
    })

    it("cuts a block longer than the limit by tokens", () => {
        const long = sentences(40).join(" ")
        const pieces = packBlocks([long], 50, 0)
        expect(pieces.length).toBeGreaterThan(1)
        for (const p of pieces) expect(countTokens(p)).toBeLessThanOrEqual(50)
    })
})

describe("hashPage", () => {
    it("is the same for the same text and changes when the text changes", () => {
        const changed: CleanPage = { ...page, sections: [{ ...page.sections[0], blocks: ["Changed."] }, ...page.sections.slice(1)] }
        expect(hashPage(page)).toBe(hashPage(structuredClone(page)))
        expect(hashPage(changed)).not.toBe(hashPage(page))
    })
})
