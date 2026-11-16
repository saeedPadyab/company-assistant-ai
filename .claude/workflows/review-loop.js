export const meta = {
  name: 'review-loop',
  description: 'Verify and review a finished issue branch and fix its Blockers, at most two fix rounds; Should fix and Nit are returned, never fixed',
  whenToUse: 'Step 2 of /review-branch: the branch is committed. args: {key, worktree, since?}',
  phases: [
    { title: 'Review', detail: 'qa-verifier runs verify.sh on HEAD; on green, the reviewer reviews it (whole branch, or follow-up since `since`)' },
    { title: 'Fix', detail: 'fixer on the Blockers, then QA and a follow-up review of its commits (max 2 rounds)' },
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
// Each round (issue #36): the qa-verifier first runs scripts/verify.sh on HEAD and maps the acceptance criteria
// to tests; this is the one verify.sh run per reviewed commit. Only when it reports green on that commit does the
// reviewer start, so the reviewer never spends a review on a red commit and the two never share the database.
// A red verify.sh, or a QA run that returns nothing, stops the run with no review: no verdict is recorded, so the
// push stays blocked. The reviewer first checks that HEAD is still the commit QA checked and records nothing if it
// moved; a review of another commit stops the run as well. The QA criteria never change the verdict and never start a fix round.
//
// Rounds: QA and review of HEAD; while the verdict is FAIL and fix round <= MAX_FIX_ROUNDS, the fixer fixes the
// Blockers and commits, then QA and the reviewer check only <previous reviewed sha>..HEAD. After MAX_FIX_ROUNDS fix
// rounds with Blockers left, or a round in which the fixer commits nothing, the run stops and hands the Blockers to
// the user. Should fix and Nit never start a round: they are collected from every review and returned once.

const parseArgs = (raw) => {
  if (typeof raw !== 'string') {
    return raw || {}
  }
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`review-loop args must be {key, worktree, since?}; got a string that is not JSON: ${e.message}`)
  }
}
const input = parseArgs(args)
const key = String(input.key || '').replace(/^#/, '')
if (!/^\d+$/.test(key) || typeof input.worktree !== 'string' || !input.worktree.startsWith('/')) {
  throw new Error('review-loop needs args {key: <issue number>, worktree: <absolute path>, since?: <sha>}')
}
const worktree = input.worktree
const since = input.since ? String(input.since) : null
if (since && !/^[0-9a-f]{7,40}$/i.test(since)) {
  throw new Error(`review-loop: since must be a commit SHA, got "${since}"`)
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

const QA_SCHEMA = {
  type: 'object',
  properties: {
    sha: { type: 'string', description: 'full SHA of the HEAD that was checked' },
    verify: { type: 'string', enum: ['green', 'red'], description: 'scripts/verify.sh result at that SHA' },
    verifyDetail: { type: 'string', description: 'red: the failing part; green: what it ran' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          status: { type: 'string', enum: ['covered', 'manual', 'missing', 'unchanged'] },
          evidence: { type: 'string' },
        },
        required: ['criterion', 'status', 'evidence'],
      },
    },
    findings: { type: 'array', items: { type: 'string' } },
    markdown: { type: 'string', description: 'the full QA report' },
  },
  required: ['sha', 'verify', 'verifyDetail', 'criteria', 'findings', 'markdown'],
}

const formatBlockers = (blockers) =>
  blockers.map((b, i) => `${i + 1}. ${b.location} — ${b.defect}\n   Scenario: ${b.scenario}`).join('\n')

// fromSha: the commit an earlier review of this run (or the user's `since`) covered; earlier: its Blockers
const review = (label, fromSha, earlier, qaSha) => agent(
  `Review issue #${key} in worktree ${worktree}.\n` +
  `The qa-verifier already ran scripts/verify.sh on ${qaSha}: green. Do not run it.\n` +
  `First check that \`git rev-parse HEAD\` is ${qaSha}. If it is not, HEAD moved after the check: do not review and ` +
  'do not record a verdict; return verdict FAIL, verdictRecorded false, your HEAD as sha and one Blocker that says so.\n' +
  (fromSha
    ? `Follow-up mode, previous reviewed SHA ${fromSha}: review only ${fromSha}..HEAD (your "Follow-up mode" section).\n` +
      (earlier.length
        ? `The previous review found these Blockers; say for each whether the new commits fix it:\n${formatBlockers(earlier)}\n`
        : 'No earlier Blockers were given: the caller says an earlier review passed that commit. Check that it did ' +
          '(your "Follow-up mode" step 1) and fall back to full mode if it did not.\n')
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

const qa = (label, fromSha) => attempt(`qa-verifier ${label}`, () => agent(
  `Check the verification of issue #${key} in worktree ${worktree}.\n` +
  (fromSha ? `A previous review covered ${fromSha}: mark criteria the commits after it do not touch as unchanged.\n` : '') +
  'Follow your procedure (scripts/verify.sh once, then each acceptance criterion) and return the structured result.',
  { agentType: 'qa-verifier', schema: QA_SCHEMA, phase: label === 'review' ? 'Review' : 'Fix', label: `qa ${label}` },
))

// One round: QA first, the reviewer only on a green verify.sh. Returns { qa, review, stop }; stop says why there
// is no review. attempt() never throws, so an agent error ends up in stop.
const qaThenReview = async (label, fromSha, earlier) => {
  const q = await qa(label, fromSha)
  if (!q) {
    return { qa: null, review: null, stop: `${label}: the qa-verifier returned no result; no review without a green verify.sh` }
  }
  log(`qa ${label}: verify.sh ${q.verify} at ${q.sha}, ${q.criteria.filter((c) => c.status === 'missing').length} criteria missing`)
  if (q.verify !== 'green') {
    return { qa: q, review: null, stop: `${label}: scripts/verify.sh is red at ${q.sha}: ${q.verifyDetail}; no review` }
  }
  const r = await attempt(label === 'review' ? 'reviewer' : `reviewer ${label}`, () => review(label, fromSha, earlier, q.sha))
  if (!r) {
    return { qa: q, review: null, stop: `${label}: the reviewer returned no result` }
  }
  if (r.sha !== q.sha) {
    // A verdict on a commit that QA did not verify must not count, whatever the reviewer returned
    return { qa: q, review: null, stop: `${label}: HEAD moved between QA (${q.sha}) and the review (${r.sha}); run /review-branch again` }
  }
  return { qa: q, review: r, stop: null }
}

// Should fix and Nit from every review of the run, each once
const shouldFix = []
const nits = []
const collect = (r) => {
  for (const s of r.shouldFix) if (!shouldFix.includes(s)) shouldFix.push(s)
  for (const n of r.nits) if (!nits.includes(n)) nits.push(n)
}

phase('Review')
const first = await qaThenReview('review', since, [])
if (!first.review) {
  // No review happened, so no verdict was recorded and the push stays blocked
  log(`stop: ${first.stop}`)
  return {
    verdict: 'FAIL',
    sha: first.qa ? first.qa.sha : 'unknown',
    verdictRecorded: false,
    readyForPr: false,
    stopReason: first.stop,
    scope: null,
    blockers: [],
    shouldFix: [],
    nits: [],
    fixRounds: 0,
    rounds: [],
    finalReview: null,
    qa: first.qa,
  }
}
let current = first.review
let lastQa = first.qa
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
  const next = await qaThenReview(`follow-up r${fixRound}`, current.sha, current.blockers)
  lastQa = next.qa
  if (!next.review) {
    stopReason = `the fix commit ${fixed.sha} has no review: ${next.stop}`
    unreviewedHead = fixed.sha
    break
  }
  if (next.review.sha !== fixed.sha) {
    log(`follow-up review saw HEAD ${next.review.sha}, the fixer reported ${fixed.sha}`)
  }
  current = next.review
  log(`follow-up r${fixRound}: ${current.verdict}, scope: ${current.scope}`)
  collect(current)
  rounds.push({ round: fixRound, kind: 'review', sha: current.sha, scope: current.scope, verdict: current.verdict, blockers: current.blockers.length })
  fixRound++
}
if (!stopReason) {
  stopReason = current.verdict === 'PASS'
    ? 'pass'
    : `still FAIL after ${MAX_FIX_ROUNDS} fix rounds; no third round: the Blockers go to the user`
}
// QA of the final HEAD only: a report from another commit says nothing about the one that was reviewed last
const qaFinal = lastQa && !unreviewedHead && lastQa.sha === current.sha ? lastQa : null
const verifiedGreen = Boolean(qaFinal && qaFinal.verify === 'green')
if (stopReason === 'pass' && !verifiedGreen) {
  stopReason = `PASS, but no green verify.sh report for ${current.sha}`
}
log(`stop: ${stopReason}`)

const readyForPr = current.verdict === 'PASS' && current.verdictRecorded && !unreviewedHead && verifiedGreen
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
  qa: qaFinal ?? lastQa,
}
