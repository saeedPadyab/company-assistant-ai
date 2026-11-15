import { readFileSync } from "node:fs"
import { z } from "zod"
import { isHandbookUrl } from "./fetch.js"
import { HANDBOOK_PAGES } from "./pages.js"

export const GOLDEN_FILE = new URL("../../evals/handbook-golden.json", import.meta.url)

const goldenSchema = z.object({
    questions: z.array(
        z.object({
            question: z.string().min(1),
            pages: z.array(z.url().refine(isHandbookUrl)).min(1),
        }),
    ),
})
export type GoldenQuestion = z.infer<typeof goldenSchema>["questions"][number]

/** Reads the golden set and checks it: every expected page must be one that ingest stores. */
export function loadGoldenQuestions(file: URL = GOLDEN_FILE): GoldenQuestion[] {
    const { questions } = goldenSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    for (const q of questions) {
        for (const page of q.pages) {
            if (!HANDBOOK_PAGES.includes(page)) throw new Error(`"${q.question}" expects ${page}, which is not in pages.ts`)
        }
    }
    return questions
}

/** Did one of the first k results come from one of the expected pages? */
export function hitAtK(resultPageUrls: string[], expectedPages: string[], k: number): boolean {
    return resultPageUrls.slice(0, k).some((url) => expectedPages.includes(url))
}

/** recall@k: the share of questions with a hit in the top k, from 0 to 1. */
export function recallAtK(runs: { resultPageUrls: string[]; expectedPages: string[] }[], k: number): number {
    if (runs.length === 0) return 0
    return runs.filter((r) => hitAtK(r.resultPageUrls, r.expectedPages, k)).length / runs.length
}
