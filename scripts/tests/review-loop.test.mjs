// Tests for .claude/workflows/review-loop.js with stub agent()/phase()/log() and canned verdicts.
//
//   node --test scripts/tests/review-loop.test.mjs     (scripts/test-tooling.sh runs it)
//
// The workflow is not a module: it uses the globals args/agent/phase/log and a top-level `return`. So the
// harness reads its source, turns `export const meta` into `const meta` and runs the body as an async function.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const MAX_FIX_ROUNDS = 2 // the contract (CLAUDE.md, issue #7): never a third fix round
const SOURCE = readFileSync(new URL('../../.claude/workflows/review-loop.js', import.meta.url), 'utf8')
const BODY = SOURCE.replace(/^export const meta\b/m, 'const meta')
assert.notEqual(BODY, SOURCE, 'review-loop.js no longer starts with `export const meta`')
const AsyncFunction = (async () => {}).constructor
const ARGS = { key: 11, worktree: '/tmp/wt-11' }

const blocker = (n) => ({ location: `src/x.ts:${n}`, defect: `defect ${n}`, scenario: `input ${n} → crash (expected: ok)` })
const review = (sha, verdict, { blockers = [], shouldFix = [], nits = [] } = {}) => ({
  agentType: 'reviewer',
  result: {
    sha, scope: 'full — test', verdict, verdictRecorded: true, blockers, earlierBlockers: [],
    shouldFix, nits, markdown: `report ${sha}\nVERDICT: ${verdict}`,
  },
})
const fix = (sha) => ({ agentType: 'fixer', result: { sha, fixed: ['fixed'], notFixed: [], verify: 'green' } })

const qaReport = (sha, verify = 'green', { missing = 0 } = {}) => ({
  agentType: 'qa-verifier',
  result: {
    sha, verify, verifyDetail: verify === 'red' ? 'server tests failed' : 'lint, typecheck, test',
    criteria: Array.from({ length: missing }, (_, i) => ({ criterion: `c${i}`, status: 'missing', evidence: 'none' })),
    findings: [], markdown: `qa ${sha}`,
  },
})

// Runs the workflow. reviewer/fixer calls take the next canned answer in `answers`, which must be for the same
// agent type. qa-verifier calls take the next one in `qaAnswers`; without `qaAnswers`, each QA call reports green
// on the SHA of the reviewer answer that comes next. A call with no canned answer left throws, as a real agent
// error would.
async function run(answers, args = ARGS, qaAnswers = null) {
  const queue = [...answers]
  const qaQueue = qaAnswers ? [...qaAnswers] : null
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ type: opts.agentType, prompt })
    let next
    if (opts.agentType === 'qa-verifier') {
      next = qaQueue ? qaQueue.shift() : queue[0]?.agentType === 'reviewer' ? qaReport(queue[0].result.sha) : null
    } else {
      next = queue.shift()
    }
    if (!next) throw new Error(`unexpected ${opts.agentType} call`)
    assert.equal(opts.agentType, next.agentType, `call ${calls.length}`)
    return structuredClone(next.result)
  }
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', BODY)
  const result = await fn(args, agent, () => {}, () => {})
  const order = calls.map((c) => c.type)
  const types = order.filter((t) => t !== 'qa-verifier')
  const qaCalls = calls.filter((c) => c.type === 'qa-verifier')
  return { result, calls: calls.filter((c) => c.type !== 'qa-verifier'), qaCalls, order, types, left: queue.length }
}

test('FAIL then PASS: QA before each review, one fix round, verdict PASS', async () => {
  const { result, calls, order } = await run([
    review('a'.repeat(40), 'FAIL', { blockers: [blocker(1)], shouldFix: ['s.ts:1 — s'] }),
    fix('b'.repeat(40)),
    review('b'.repeat(40), 'PASS', { shouldFix: ['s.ts:1 — s'], nits: ['n.ts:1 — n'] }),
  ])
  assert.deepEqual(order, ['qa-verifier', 'reviewer', 'fixer', 'qa-verifier', 'reviewer'])
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.readyForPr, true)
  assert.equal(result.fixRounds, 1)
  assert.equal(result.stopReason, 'pass')
  assert.match(calls[1].prompt, /src\/x\.ts:1 — defect 1/)
  assert.match(calls[2].prompt, new RegExp(`previous reviewed SHA ${'a'.repeat(40)}`))
  assert.deepEqual(result.shouldFix, ['s.ts:1 — s'], 'Should fix items are returned once')
  assert.deepEqual(result.nits, ['n.ts:1 — n'])
})

test(`FAIL every time: stops after ${MAX_FIX_ROUNDS} fix rounds, Blockers to the user`, async () => {
  const answers = [review('a1', 'FAIL', { blockers: [blocker(1)] })]
  for (let i = 1; i <= MAX_FIX_ROUNDS + 1; i++) {
    answers.push(fix(`f${i}`), review(`f${i}`, 'FAIL', { blockers: [blocker(i + 1)] }))
  }
  const { result, types } = await run(answers)
  assert.equal(types.filter((t) => t === 'fixer').length, MAX_FIX_ROUNDS, 'no third fixer call')
  assert.equal(types.length, 1 + 2 * MAX_FIX_ROUNDS)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.readyForPr, false)
  assert.equal(result.fixRounds, MAX_FIX_ROUNDS)
  assert.equal(result.sha, `f${MAX_FIX_ROUNDS}`)
  assert.deepEqual(result.blockers, [blocker(MAX_FIX_ROUNDS + 1)])
  assert.match(result.stopReason, new RegExp(`still FAIL after ${MAX_FIX_ROUNDS} fix rounds`))
})

test('PASS with Should fix items: no fixer call, items returned once', async () => {
  const { result, types } = await run([
    review('a1', 'PASS', { shouldFix: ['s.ts:1 — s', 's.ts:2 — t', 's.ts:1 — s'], nits: ['n.ts:1 — n'] }),
  ])
  assert.deepEqual(types, ['reviewer'])
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.readyForPr, true)
  assert.equal(result.fixRounds, 0)
  assert.deepEqual(result.shouldFix, ['s.ts:1 — s', 's.ts:2 — t'])
  assert.deepEqual(result.nits, ['n.ts:1 — n'])
})

test('a fixer that commits nothing stops the run', async () => {
  const { result, types, qaCalls, left } = await run([
    review('a1', 'FAIL', { blockers: [blocker(1)] }),
    fix('a1'),
    review('a1', 'PASS'),
  ])
  assert.deepEqual(types, ['reviewer', 'fixer'])
  assert.equal(qaCalls.length, 1, 'no QA of a commit that does not exist')
  assert.equal(left, 1, 'no follow-up review')
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.readyForPr, false)
  assert.match(result.stopReason, /committed nothing/)
  assert.deepEqual(result.blockers, [blocker(1)])
})

test('a fixer error stops the run with an unknown, unreviewed HEAD', async () => {
  const { result, types } = await run([review('a1', 'FAIL', { blockers: [blocker(1)] })])
  assert.deepEqual(types, ['reviewer', 'fixer'])
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.sha, 'unknown')
  assert.equal(result.readyForPr, false)
})

test('a reviewer error after a green verify.sh fails the run with no verdict', async () => {
  const { result } = await run([], ARGS, [qaReport('a1')])
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.verdictRecorded, false)
  assert.equal(result.readyForPr, false)
  assert.match(result.stopReason, /reviewer returned no result/)
})

test('a red verify.sh at HEAD stops the run before any review', async () => {
  const { result, order, left } = await run([review('a1', 'PASS')], ARGS, [qaReport('a1', 'red')])
  assert.deepEqual(order, ['qa-verifier'], 'the reviewer never starts on a red commit')
  assert.equal(left, 1)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.verdictRecorded, false)
  assert.equal(result.readyForPr, false)
  assert.equal(result.sha, 'a1')
  assert.match(result.stopReason, /verify\.sh is red at a1: server tests failed; no review/)
  assert.equal(result.qa.verify, 'red', 'the red report is returned')
})

test('a QA error stops the run before any review', async () => {
  const { result, order } = await run([review('a1', 'PASS')], ARGS, [])
  assert.deepEqual(order, ['qa-verifier'])
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.readyForPr, false)
  assert.equal(result.qa, null)
  assert.match(result.stopReason, /qa-verifier returned no result/)
})

test('a review of another commit than QA checked does not count', async () => {
  const { result, calls } = await run([review('b1', 'PASS')], ARGS, [qaReport('a1')])
  assert.match(calls[0].prompt, /First check that `git rev-parse HEAD` is a1/)
  assert.match(calls[0].prompt, /a PASS with --verified a1/)
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.readyForPr, false)
  assert.equal(result.finalReview, null)
  assert.match(result.stopReason, /HEAD moved between QA \(a1\) and the review \(b1\)/)
})

test('a HEAD change after a fix leaves the fix commit unreviewed', async () => {
  const { result } = await run(
    [review('a1', 'FAIL', { blockers: [blocker(1)] }), fix('b1'), review('c1', 'PASS')],
    ARGS,
    [qaReport('a1'), qaReport('b1')],
  )
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.sha, 'b1')
  assert.equal(result.readyForPr, false)
  assert.match(result.stopReason, /fix commit b1 has no review: .*HEAD moved/)
})

test('a red verify.sh after a fix leaves the fix commit unreviewed', async () => {
  const { result, order } = await run(
    [review('a1', 'FAIL', { blockers: [blocker(1)] }), fix('b1'), review('b1', 'PASS')],
    ARGS,
    [qaReport('a1'), qaReport('b1', 'red')],
  )
  assert.deepEqual(order, ['qa-verifier', 'reviewer', 'fixer', 'qa-verifier'])
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.sha, 'b1')
  assert.equal(result.readyForPr, false)
  assert.match(result.stopReason, /fix commit b1 has no review: .*red at b1/)
})

test('QA runs in every round; the final report and its missing criteria are returned', async () => {
  const { result, qaCalls, calls } = await run(
    [review('a1', 'FAIL', { blockers: [blocker(1)] }), fix('b1'), review('b1', 'PASS')],
    ARGS,
    [qaReport('a1'), qaReport('b1', 'green', { missing: 1 })],
  )
  assert.equal(qaCalls.length, 2, 'one QA per review')
  assert.match(qaCalls[1].prompt, /previous review covered a1/)
  assert.match(calls[0].prompt, /verify\.sh on a1: green\. Do not run it/)
  assert.equal(result.readyForPr, true)
  assert.equal(result.qa.sha, 'b1')
  assert.equal(result.qa.criteria[0].status, 'missing', 'missing criteria are returned, not fixed')
})

test('bad args are refused before any agent runs', async () => {
  for (const args of [{}, { key: 'x', worktree: '/w' }, { key: 11, worktree: 'relative' }, { ...ARGS, since: 'HEAD~1' }]) {
    await assert.rejects(run([], args), /review-loop/)
  }
})
