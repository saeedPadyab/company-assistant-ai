// Retrieval eval: `pnpm --filter server eval:retrieval`.
// Needs an ingested handbook and OPENAI_API_KEY: it embeds every golden question (a few cents
// at most). Not part of CI; CI tests use the fake model. Prints recall@k and the misses.
import { closeDb } from "../db/client.js"
import { loadGoldenQuestions, recallAtK } from "./recall.js"
import { searchHandbook } from "./search.js"

const KS = [1, 3, 5]
const questions = loadGoldenQuestions()
const runs = []

for (const q of questions) {
    const hits = await searchHandbook(q.question, Math.max(...KS))
    runs.push({ question: q.question, expectedPages: q.pages, resultPageUrls: hits.map((h) => h.pageUrl), top: hits[0] })
}

console.log(`retrieval eval: ${questions.length} golden questions\n`)
for (const k of KS) console.log(`recall@${k}: ${(recallAtK(runs, k) * 100).toFixed(0)}%`)

const misses = runs.filter((r) => !r.resultPageUrls.slice(0, Math.max(...KS)).some((u) => r.expectedPages.includes(u)))
if (misses.length > 0) {
    console.log(`\nnot in the top ${Math.max(...KS)}:`)
    for (const m of misses) console.log(`- ${m.question}\n  expected ${m.expectedPages.join(" or ")}\n  top hit  ${m.top?.url ?? "(none)"}`)
}
await closeDb()
