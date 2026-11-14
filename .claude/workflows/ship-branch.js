export const meta = {
  name: 'ship-branch',
  description: 'Review a finished issue branch and fix its Blockers, at most two fix rounds; Should fix and Nit are returned, never fixed',
  whenToUse: 'Step 3 of /ship: the branch is committed and scripts/verify.sh is green. args: {key, worktree, since?}',
  phases: [
    { title: 'Review', detail: 'reviewer on HEAD (whole branch, or follow-up since `since`)' },
    { title: 'Fix', detail: 'fixer on the Blockers, then a follow-up review of its commits (max 2 rounds)' },
  ],
}

// Why this exists (issue #7): the number of review/fix rounds is decided here, in code, not by the session.
// It caps cost and stops review loops; it is not a security lock. A session that calls the reviewer by hand
// again is out of scope: the CLAUDE.md rule and the commit-bound verdict (scripts/review-status.sh, #3) still apply.
//
// args: { key: 7, worktree: '/abs/path/to/worktree', since?: '<sha>' }
//   since: a commit of this branch that an earlier run reviewed with PASS. The first review then covers only
//          since..HEAD (the one follow-up review after the user chose to fix Should fix or Nit items).
//
// Rounds: review HEAD; while the verdict is FAIL and fix round <= MAX_FIX_ROUNDS, the fixer fixes the Blockers
// and commits, then the reviewer reviews only <previous reviewed sha>..HEAD. After MAX_FIX_ROUNDS fix rounds with
// Blockers left, or a round in which the fixer commits nothing, the run stops and hands the Blockers to the user.
// Should fix and Nit never start a round: they are collected from every review and returned once.

const parseArgs = (raw) => {
  if (typeof raw !== 'string') {
    return raw || {}
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`ship-branch args must be {key, worktree, since?}; got a string that is not JSON: ${e.message}`)
  }
}
const input = parseArgs(args)
const key = String(input.key || '').replace(/^#/, '')
if (!/^\d+$/.test(key) || typeof input.worktree !== 'string' || !input.worktree.startsWith('/')) {
  throw new Error('ship-branch needs args {key: <issue number>, worktree: <absolute path>, since?: <sha>}')
}
const worktree = input.worktree
const since = input.since ? String(input.since) : null
if (since && !/^[0-9a-f]{7,40}$/i.test(since)) {
  throw new Error(`ship-branch: since must be a commit SHA, got "${since}"`)
}
const MAX_FIX_ROUNDS = 2

const BLOCKER = {
  type: 'object',
  properties: {
    location: { type: 'string', description: '<file>:<line>' },
    defect: { type: 'string' },
    scenario: { type: 'string', description: '<actor/input> → <what happens> (expected: <what should happen>)' },
  },
  required: ['location', 'defect', 'scenario'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    sha: { type: 'string', description: 'full SHA of the HEAD that was reviewed (git rev-parse HEAD)' },
    scope: { type: 'string', description: 'the Scope line of the report: "full — <why>" or "follow-up since <sha12> (<n> commits)"' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    verdictRecorded: { type: 'boolean', description: 'scripts/review-status.sh record exited 0' },
    blockers: { type: 'array', items: BLOCKER },
    earlierBlockers: {
      type: 'array',
      description: 'follow-up mode: each Blocker you were given, and whether the new commits fix it',
      items: {
        type: 'object',
        properties: { location: { type: 'string' }, fixed: { type: 'boolean' }, note: { type: 'string' } },
        required: ['location', 'fixed', 'note'],
      },
    },
    shouldFix: { type: 'array', items: { type: 'string' }, description: '"<file>:<line> — <what and why>"' },
    nits: { type: 'array', items: { type: 'string' }, description: '"<file>:<line> — <what>"' },
    markdown: { type: 'string', description: 'the full review report, ending with the VERDICT line' },
  },
  required: ['sha', 'scope', 'verdict', 'verdictRecorded', 'blockers', 'earlierBlockers', 'shouldFix', 'nits', 'markdown'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    sha: { type: 'string', description: 'full HEAD SHA after your commits; the starting SHA if you committed nothing' },
    fixed: { type: 'array', items: { type: 'string' }, description: '"<location> — <fix and its test>"' },
    notFixed: { type: 'array', items: { type: 'string' }, description: '"<location> — <why: not real, or needs a decision from the user>"' },
    verify: { type: 'string', description: 'scripts/verify.sh result: green, or the failing part' },
  },
  required: ['sha', 'fixed', 'notFixed', 'verify'],
}

const formatBlockers = (blockers) =>
  blockers.map((b, i) => `${i + 1}. ${b.location} — ${b.defect}\n   Scenario: ${b.scenario}`).join('\n')

// fromSha: the commit an earlier review of this run (or the user's `since`) covered; earlier: its Blockers
const review = (label, fromSha, earlier) => agent(
  `Review issue #${key} in worktree ${worktree}.\n` +
  (fromSha
    ? `Follow-up mode, previous reviewed SHA ${fromSha}: review only ${fromSha}..HEAD (your "Follow-up mode" section).\n` +
      (earlier.length
        ? `The previous review found these Blockers; say for each whether the new commits fix it:\n${formatBlockers(earlier)}\n`
        : 'The previous review of that commit passed; there are no earlier Blockers to check.\n')
    : 'Full review of the branch against origin/main.\n') +
  'Record your verdict on HEAD as your procedure says, then return the structured result (markdown = your full report).',
  { agentType: 'reviewer', schema: REVIEW_SCHEMA, phase: label === 'review' ? 'Review' : 'Fix', label },
)

const fix = (round, reviewed) => agent(
  `Fix round ${round} of ${MAX_FIX_ROUNDS} for issue #${key} in worktree ${worktree}. HEAD is ${reviewed.sha}.\n` +
  `The reviewer found these Blockers:\n${formatBlockers(reviewed.blockers)}\n\n` +
  'Follow your procedure: Blockers only, each with a test, scripts/verify.sh, one commit. Return the structured result.',
  { agentType: 'fixer', schema: FIX_SCHEMA, phase: 'Fix', label: `fixer r${round}` },
)

// A bare agent() can throw (budget ceiling, agent error); the run then stops with what it has
const attempt = async (what, run) => {
  try {
    return await run()
  } catch (e) {
    log(`${what} failed: ${e && e.message ? e.message : e}`)
    return null
  }
}

// Should fix and Nit from every review of the run, each once
const shouldFix = []
const nits = []
const collect = (r) => {
  for (const s of r.shouldFix) if (!shouldFix.includes(s)) shouldFix.push(s)
  for (const n of r.nits) if (!nits.includes(n)) nits.push(n)
}

phase('Review')
let current = await attempt('reviewer', () => review('review', since, []))
if (!current) {
  throw new Error('the reviewer returned no result: treat as FAIL (no verdict, no push)')
}
log(`review: ${current.verdict}, scope: ${current.scope}`)
collect(current)
const rounds = [{ round: 0, kind: 'review', sha: current.sha, scope: current.scope, verdict: current.verdict, blockers: current.blockers.length }]

let stopReason = current.verdict === 'PASS' ? 'pass' : null
let unreviewedHead = null
let fixRound = 1
phase('Fix')
while (current.verdict === 'FAIL' && fixRound <= MAX_FIX_ROUNDS) {
  const fixed = await attempt(`fixer r${fixRound}`, () => fix(fixRound, current))
  if (!fixed) {
    stopReason = `the fixer of round ${fixRound} returned no result and may have committed on top of ${current.sha}`
    unreviewedHead = 'unknown'
    break
  }
  rounds.push({ round: fixRound, kind: 'fix', sha: fixed.sha, fixed: fixed.fixed, notFixed: fixed.notFixed, verify: fixed.verify })
  if (fixed.sha === current.sha) {
    stopReason = `round ${fixRound}: the fixer committed nothing; the Blockers need the user`
    break
  }
  const next = await attempt(`reviewer r${fixRound}`, () => review(`follow-up r${fixRound}`, current.sha, current.blockers))
  if (!next) {
    stopReason = `the fix commit ${fixed.sha} has no review`
    unreviewedHead = fixed.sha
    break
  }
  if (next.sha !== fixed.sha) {
    log(`follow-up review saw HEAD ${next.sha}, the fixer reported ${fixed.sha}`)
  }
  log(`follow-up r${fixRound}: ${next.verdict}, scope: ${next.scope}`)
  collect(next)
  rounds.push({ round: fixRound, kind: 'review', sha: next.sha, scope: next.scope, verdict: next.verdict, blockers: next.blockers.length })
  current = next
  fixRound++
}
if (!stopReason) {
  stopReason = current.verdict === 'PASS'
    ? 'pass'
    : `still FAIL after ${MAX_FIX_ROUNDS} fix rounds; no third round: the Blockers go to the user`
}
log(`stop: ${stopReason}`)

const readyForPr = current.verdict === 'PASS' && current.verdictRecorded && !unreviewedHead
return {
  verdict: unreviewedHead ? 'FAIL' : current.verdict,
  sha: unreviewedHead || current.sha,
  verdictRecorded: current.verdictRecorded,
  readyForPr,
  stopReason,
  scope: current.scope,
  blockers: current.blockers,
  shouldFix,
  nits,
  fixRounds: rounds.filter((r) => r.kind === 'fix').length,
  rounds,
  finalReview: current.markdown,
}
