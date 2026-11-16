// Tests for .claude/workflows/ship-branch.js with stub agent()/phase()/log() and canned verdicts.
//
//   node --test scripts/tests/ship-branch.test.mjs     (scripts/test-tooling.sh runs it)
//
// The workflow is not a module: it uses the globals args/agent/phase/log and a top-level `return`. So the
// harness reads its source, turns `export const meta` into `const meta` and runs the body as an async function.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const MAX_FIX_ROUNDS = 2 // the contract (CLAUDE.md, issue #7): never a third fix round
const SOURCE = readFileSync(new URL('../../.claude/workflows/ship-branch.js', import.meta.url), 'utf8')
const BODY = SOURCE.replace(/^export const meta\b/m, 'const meta')
assert.notEqual(BODY, SOURCE, 'ship-branch.js no longer starts with `export const meta`')
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

// The real parallel(): a barrier that never rejects; a thunk that throws resolves to null.
const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))

// Runs the workflow. reviewer/fixer calls take the next canned answer in `answers`, which must be for the same
// agent type; qa-verifier calls take the next one in `qaAnswers`. A call with no canned answer left throws, as a
// real agent error would (for QA: no report, the run goes on).
async function run(answers, args = ARGS, qaAnswers = []) {
  const queue = [...answers]
  const qaQueue = [...qaAnswers]
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ type: opts.agentType, prompt })
    const next = opts.agentType === 'qa-verifier' ? qaQueue.shift() : queue.shift()
    if (!next) throw new Error(`unexpected ${opts.agentType} call`)
    assert.equal(opts.agentType, next.agentType, `call ${calls.length}`)
    return structuredClone(next.result)
  }
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', BODY)
  const result = await fn(args, agent, () => {}, () => {}, parallel)
  const types = calls.map((c) => c.type).filter((t) => t !== 'qa-verifier')
  const qaCalls = calls.filter((c) => c.type === 'qa-verifier')
  return { result, calls: calls.filter((c) => c.type !== 'qa-verifier'), qaCalls, types, left: queue.length }
}

test('FAIL then PASS: one fix round, verdict PASS', async () => {
  const { result, calls, types } = await run([
    review('a'.repeat(40), 'FAIL', { blockers: [blocker(1)], shouldFix: ['s.ts:1 — s'] }),
    fix('b'.repeat(40)),
    review('b'.repeat(40), 'PASS', { shouldFix: ['s.ts:1 — s'], nits: ['n.ts:1 — n'] }),
  ])
  assert.deepEqual(types, ['reviewer', 'fixer', 'reviewer'])
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
  const { result, types, left } = await run([
    review('a1', 'FAIL', { blockers: [blocker(1)] }),
    fix('a1'),
    review('a1', 'PASS'),
  ])
  assert.deepEqual(types, ['reviewer', 'fixer'])
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

test('a reviewer error fails the run', async () => {
  await assert.rejects(run([]), /treat as FAIL/)
})

test('QA runs beside every review and its final report is returned', async () => {
  const { result, qaCalls } = await run(
    [review('a1', 'FAIL', { blockers: [blocker(1)] }), fix('b1'), review('b1', 'PASS')],
    ARGS,
    [qaReport('a1', 'red'), qaReport('b1', 'green', { missing: 1 })],
  )
  assert.equal(qaCalls.length, 2, 'one QA per review')
  assert.match(qaCalls[1].prompt, /previous review covered a1/)
  assert.equal(result.readyForPr, true)
  assert.equal(result.qa.sha, 'b1')
  assert.equal(result.qa.criteria[0].status, 'missing', 'missing criteria are returned, not fixed')
})

test('a red verify.sh at the final HEAD keeps a PASS from being ready for the PR', async () => {
  const { result, types } = await run([review('a1', 'PASS')], ARGS, [qaReport('a1', 'red')])
  assert.deepEqual(types, ['reviewer'], 'QA never starts a fix round')
  assert.equal(result.verdict, 'PASS', 'QA never changes the verdict')
  assert.equal(result.readyForPr, false)
  assert.match(result.stopReason, /verify\.sh is red at a1: server tests failed/)
})

test('a QA error leaves qa null and the review result as it is', async () => {
  const { result } = await run([review('a1', 'PASS')])
  assert.equal(result.qa, null)
  assert.equal(result.readyForPr, true)
})

test('a QA report of another commit is not the final one', async () => {
  const { result } = await run([review('a1', 'PASS')], ARGS, [qaReport('zz', 'red')])
  assert.equal(result.qa, null)
  assert.equal(result.readyForPr, true)
})

test('bad args are refused before any agent runs', async () => {
  for (const args of [{}, { key: 'x', worktree: '/w' }, { key: 11, worktree: 'relative' }, { ...ARGS, since: 'HEAD~1' }]) {
    await assert.rejects(run([], args), /ship-branch/)
  }
})
