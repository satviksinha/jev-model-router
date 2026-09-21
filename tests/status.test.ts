import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  announceReply,
  attemptOf,
  liveLine,
  REPLY_SEPARATOR,
  statusReport,
  toggleReply,
  type Status,
  addUsage,
  cacheRatio,
  usageFooter,
  type Attempt,
  type Usage,
} from '../hooks/status.ts'
import type { ProviderResult } from '../hooks/provider.ts'

const decision = {
  tier: 'fable' as const,
  model: 'claude-fable-5-1',
  effort: 'xhigh' as const,
  confidence: 0.97,
}

const goodProvider: ProviderResult = {
  ok: true,
  name: 'gateway',
  endpoint: 'https://ai-gateway.vercel.sh/v1/evaluate',
  model: 'typesafe-ai/jev',
  apiKey: 'test-key',
}

const noKeyProvider: ProviderResult = {
  ok: false,
  reason: 'no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY',
}

const base: Status = {
  enabled: true,
  surface: 'desktop',
  provider: goodProvider,
  timeoutMs: 1500,
  offered: ['haiku', 'sonnet', 'opus', 'fable'],
  excluded: [],
  announce: true,
  attempts: [],
}

describe('status report', () => {
  test('the first lines answer "is this even on"', () => {
    const lines = statusReport(base).split('\n')
    assert.match(lines[1] ?? '', /routing\s+on/)
    assert.match(lines[2] ?? '', /surface\s+desktop/)
    assert.match(lines[3] ?? '', /gateway.*AI_GATEWAY_API_KEY is set/)
  })

  test('a missing key is stated loudly, not implied', () => {
    const text = statusReport({ ...base, provider: noKeyProvider })
    assert.match(text, /NO KEYS — nothing will route/)
  })

  test('routing off says how to turn it back on', () => {
    assert.match(statusReport({ ...base, enabled: false }), /off \(\/jev on\)/)
  })

  test('before any turn it says so rather than showing an empty table', () => {
    assert.match(statusReport(base), /No turns yet/)
  })

  test('a routed turn shows tier, effort, confidence and latency', () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: 'plan the migration', ms: 641, decision }],
    })
    assert.match(text, /641ms/)
    assert.match(text, /fable·xhigh 0\.97/)
    assert.match(text, /plan the migration/)
  })

  test('an unrouted turn shows why, which is the whole point', () => {
    const text = statusReport({
      ...base,
      attempts: [
        { prompt: 'x', ms: 12, skipped: 'gateway said HTTP 403 (customer_verification_required)' },
      ],
    })
    assert.match(text, /unrouted — gateway said HTTP 403/)
  })

  test('a low-confidence pick is called out in words, not a symbol', () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: 'x', ms: 400, decision: { ...decision, confidence: 0.3 } }],
    })
    assert.match(text, /low confidence/)
  })

  test('excluded tiers are listed only when there are some', () => {
    assert.doesNotMatch(statusReport(base), /excluded/)
    assert.match(
      statusReport({ ...base, excluded: ['fable'], offered: ['haiku', 'sonnet', 'opus'] }),
      /excluded\s+fable/,
    )
  })

  test('a long prompt is trimmed so the report stays one screen', () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: 'a'.repeat(200), ms: 1, decision }],
    })
    for (const line of text.split('\n')) assert.ok(line.length < 100, line)
  })

  test('toggling reports the state it moved to', () => {
    assert.match(toggleReply(true), /on\./)
    assert.match(toggleReply(false), /session model/)
  })
})

describe('live line', () => {
  test('a routed turn is announced with tier, effort, confidence and latency', () => {
    assert.equal(
      liveLine({ prompt: 'plan the migration', ms: 641, decision }),
      '> ✳️ `fable` · xhigh · 97% · 641ms',
    )
  })

  test('an unrouted turn announces why, rather than going silent', () => {
    assert.equal(
      liveLine({ prompt: 'x', ms: 12, skipped: 'no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY' }),
      '> ⚠️ `unrouted` · no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY',
    )
  })

  test('a shaky pick is marked so a bad route is visible as it happens', () => {
    assert.match(
      liveLine({ prompt: 'x', ms: 400, decision: { ...decision, confidence: 0.3 } }),
      /· 30%\? ·/,
    )
  })

  test('the line is a blockquote with the tier as inline code, since that is what the transcript can colour', () => {
    const line = liveLine({ prompt: 'x', ms: 641, decision })
    assert.ok(line.startsWith('> '), line)
    assert.match(line, /`fable`/)
  })

  test('the separator is a rule with a blank line before it, or --- would make the route a heading', () => {
    assert.equal(REPLY_SEPARATOR, '\n\n---\n\n')
  })

  test('the line stays short enough not to wrap', () => {
    const line = liveLine({ prompt: 'a'.repeat(300), ms: 641, decision })
    assert.ok(line.length < 60, line)
  })

  test('announcing can be turned off without turning routing off', () => {
    assert.match(announceReply(false), /quietly/)
    assert.match(announceReply(true), /announce/)
    assert.match(statusReport({ ...base, announce: false }), /announce\s+off/)
  })
})

describe('attemptOf', () => {
  const offered = ['haiku', 'sonnet', 'opus', 'fable'] as const
  const skippedOf = (a: ReturnType<typeof attemptOf>) =>
    'skipped' in a ? a.skipped : 'UNEXPECTEDLY ROUTED'

  test('a good answer becomes a routed attempt', () => {
    const attempt = attemptOf(
      'plan it',
      {
        ok: true,
        ms: 500,
        answers: { tier: { type: 'choice', choice: 'fable' } },
      },
      offered,
    )
    assert.equal('decision' in attempt && attempt.decision.tier, 'fable')
    assert.equal(attempt.ms, 500)
  })

  test('a failed call keeps its reason, so the line can say why', () => {
    assert.equal(
      skippedOf(attemptOf('x', { ok: false, ms: 9, reason: 'timed out after 1500ms' }, offered)),
      'timed out after 1500ms',
    )
  })

  test('an answer naming a tier we did not offer is its own reason', () => {
    assert.match(
      skippedOf(attemptOf('x', { ok: true, ms: 5, answers: { tier: {} } }, offered)),
      /named no tier we offered/,
    )
  })
})

describe('usage: what actually answered', () => {
  const routed = (): Attempt => ({ prompt: 'plan it', ms: 641, decision })
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: 'claude-fable-5-1',
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  })

  test('a stop chunk’s usage is kept on the turn', () => {
    const a = routed()
    addUsage(a, usage())
    assert.equal(a.usage?.model, 'claude-fable-5-1')
    assert.equal(a.usage?.cache_read_input_tokens, 117_000)
  })

  test('a turn of several steps sums its counts and keeps the last model', () => {
    const a = routed()
    addUsage(a, usage({ input_tokens: 1000, output_tokens: 100 }))
    addUsage(a, usage({ input_tokens: 2000, output_tokens: 200, model: 'claude-fable-5-1-later' }))
    assert.equal(a.usage?.input_tokens, 3000)
    assert.equal(a.usage?.output_tokens, 300)
    assert.equal(a.usage?.model, 'claude-fable-5-1-later')
  })

  test('the cache ratio is what was read over everything the request carried', () => {
    assert.equal(cacheRatio(usage()), 0.9)
    assert.equal(cacheRatio(usage({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })), 0)
  })

  test('the report confirms the model the API says answered', () => {
    const a = routed()
    addUsage(a, usage())
    const text = statusReport({ ...base, attempts: [a] })
    assert.match(text, /claude-fable-5-1 ✓/)
    assert.match(text, /cache 90%/)
    assert.match(text, /130k in/)
  })

  test('a dated id still counts as the model that was asked for', () => {
    const a = routed()
    addUsage(a, usage({ model: 'claude-fable-5-1-20260901' }))
    assert.match(statusReport({ ...base, attempts: [a] }), /claude-fable-5-1-20260901 ✓/)
  })

  test('a different model answering is flagged, which is the whole point', () => {
    const a = routed()
    addUsage(a, usage({ model: 'claude-opus-5' }))
    const text = statusReport({ ...base, attempts: [a] })
    assert.match(text, /claude-opus-5 ≠ claude-fable-5-1/)
    assert.doesNotMatch(text, /✓/)
  })

  test('an unrouted turn still shows what answered, with nothing to check against', () => {
    const a: Attempt = { prompt: 'x', ms: 0, skipped: 'timed out' }
    addUsage(a, usage({ model: 'claude-opus-5' }))
    const text = statusReport({ ...base, attempts: [a] })
    assert.match(text, /claude-opus-5/)
    assert.doesNotMatch(text, /[✓≠]/)
  })

  test('a turn with no usage yet gets one line, not a blank second one', () => {
    const lines = statusReport({ ...base, attempts: [routed()] }).split('\n')
    assert.equal(lines.filter(l => l.includes('answered')).length, 0)
  })

  test('the usage line stays within one screen', () => {
    const a = routed()
    addUsage(a, usage({ model: 'claude-fable-5-1-20260901-preview', cache_read_input_tokens: 1_900_000 }))
    for (const line of statusReport({ ...base, attempts: [a] }).split('\n')) assert.ok(line.length < 100, line)
  })
})

describe('usage footer', () => {
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: 'claude-fable-5-1',
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  })
  const withUsage = (a: Attempt, u = usage()) => {
    addUsage(a, u)
    return a
  }
  const routed = (): Attempt => ({ prompt: 'plan it', ms: 641, decision })

  test('a turn with no usage has no footer', () => {
    assert.equal(usageFooter(routed()), null)
  })

  test('it is a fenced block, or markdown eats the indent and joins the lines', () => {
    const lines = usageFooter(withUsage(routed()))!.split('\n')
    assert.equal(lines[0], '```')
    assert.equal(lines.at(-1), '```')
    assert.match(lines[1]!, /^─+$/)
  })

  test('the jev line is what was asked for', () => {
    const footer = usageFooter(withUsage(routed()))!
    assert.match(footer, /jev {2}fable·xhigh · 97% · 641ms/)
  })

  test('the api line is what answered, with the cost', () => {
    const footer = usageFooter(withUsage(routed()))!
    assert.match(footer, /api {2}claude-fable-5-1 ✓ · cache 90% · 130k in · 1k out/)
  })

  test('a mismatch names both, which is the one case worth looking at', () => {
    const footer = usageFooter(withUsage(routed(), usage({ model: 'claude-opus-5' })))!
    assert.match(footer, /api {2}claude-opus-5 ≠ claude-fable-5-1/)
  })

  test('a dated id is still the model that was asked for', () => {
    const footer = usageFooter(withUsage(routed(), usage({ model: 'claude-fable-5-1-20260901' })))!
    assert.match(footer, /claude-fable-5-1-20260901 ✓/)
  })

  test('an unrouted turn reports what answered, with nothing to compare', () => {
    const a: Attempt = { prompt: 'x', ms: 0, skipped: 'timed out after 1500ms' }
    const footer = usageFooter(withUsage(a, usage({ model: 'claude-opus-5' })))!
    assert.match(footer, /jev {2}unrouted — timed out after 1500ms/)
    assert.match(footer, /api {2}claude-opus-5 · cache 90%/)
    assert.doesNotMatch(footer, /[✓≠]/)
  })

  test('the rule spans the widest line, and nothing wraps', () => {
    const footer = usageFooter(withUsage(routed(), usage({ cache_read_input_tokens: 1_900_000 })))!
    const lines = footer.split('\n')
    const rule = lines[1]!
    const widest = Math.max(...lines.slice(2, -1).map(l => [...l].length))
    assert.equal([...rule].length, widest)
    for (const line of lines) assert.ok([...line].length < 100, line)
  })
})
