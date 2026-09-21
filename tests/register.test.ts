import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { register } from '../hooks/register.ts'

/**
 * Drives the real `register` with a fake engine: captures the hooks it
 * registers, then runs turn.start and turn.step the way the engine would.
 */
function load(env: Record<string, string> = { AI_GATEWAY_API_KEY: 'gw-key' }) {
  const hooks = new Map<string, Function>()
  const on = (name: string, a: unknown, b?: unknown) => {
    const key = typeof a === 'function' ? name : `${name}:${JSON.stringify(a)}`
    hooks.set(key, (typeof a === 'function' ? a : b) as Function)
    return { catch: () => {} }
  }
  register(on as never)

  const $ = {
    env: { get: async (k: string) => env[k] },
    clock: { sleep: () => new Promise<never>(() => {}) },
    http: {
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: {},
        text: JSON.stringify({
          answers: {
            tier: { type: 'choice', choice: 'opus', confidence: 0.91 },
            effort: { type: 'score', score: 2 },
          },
        }),
      }),
    },
    command: { register: async () => {} },
    session: { surface: async () => 'test' },
  }
  return { hooks, $ }
}

async function* modelSays(...texts: string[]) {
  yield { kind: 'engine', ref: 1 }
  for (const [i, text] of texts.entries()) yield { kind: 'text', index: 0, text, ref: i + 2 }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { stopReason: 'end_turn' }
}

const usage = (model: string, input_tokens = 1000) => ({
  model,
  input_tokens,
  output_tokens: 50,
  cache_read_input_tokens: 9000,
  cache_creation_input_tokens: 0,
})

async function* answeredBy(model: string, stopReason = 'end_turn', input_tokens = 1000) {
  yield { kind: 'text', index: 0, text: 'reply', ref: 1 }
  yield { kind: 'stop', stopReason, usage: usage(model, input_tokens), ref: 2 }
  return { stopReason }
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('register: the route in the reply', () => {
  test('the first text chunk of a routed turn opens with the route line', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'implement it', turnId: 't1' }, async (e: unknown) => e)

    let sent: { model?: string; effort?: string } = {}
    const step = hooks.get('turn.step')!(
      $,
      { turnId: 't1', index: 0, model: 'claude-fable-5-1' },
      (e: { model: string; effort: string }) => {
        sent = e
        return modelSays('Hello', ' there.')
      },
    )
    const chunks = await collect(step)
    const texts = chunks.filter(c => c.kind === 'text').map(c => c.text)

    assert.equal(sent.model, 'claude-opus-5')
    assert.equal(sent.effort, 'high')
    assert.equal(
      texts[0],
      '> ✳️ `opus` · high · 91% · 0ms\n\n---\n\nHello',
    )
    assert.equal(texts[1], ' there.')
    assert.equal(chunks[0]!.kind, 'engine', 'engine chunks pass through untouched')
  })

  test('the line is put in once per turn, not once per step', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't2' }, async (e: unknown) => e)
    const run = (index: number) =>
      collect(hooks.get('turn.step')!($, { turnId: 't2', index }, () => modelSays('reply')))

    const first = await run(0)
    const second = await run(1)
    assert.match(first.find(c => c.kind === 'text')!.text, /^> ✳️ `opus`/)
    assert.equal(second.find(c => c.kind === 'text')!.text, 'reply')
  })

  test('an unrouted turn still says so at the top of its reply', async () => {
    const { hooks, $ } = load({})
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't3' }, async (e: unknown) => e)
    const chunks = await collect(
      hooks.get('turn.step')!($, { turnId: 't3', index: 0, model: 'm' }, (e: { model: string }) => {
        assert.equal(e.model, 'm', 'no decision, so the model is left alone')
        return modelSays('reply')
      }),
    )
    assert.equal(
      chunks.find(c => c.kind === 'text')!.text,
      '> ⚠️ `unrouted` · no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY\n\n---\n\nreply',
    )
  })

  test('a step whose first chunks are not text waits for the text', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't4' }, async (e: unknown) => e)
    async function* thinkingFirst() {
      yield { kind: 'thinking', index: 0, text: 'hmm' }
      yield { kind: 'text', index: 1, text: 'answer' }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    }
    const chunks = await collect(hooks.get('turn.step')!($, { turnId: 't4', index: 0 }, () => thinkingFirst()))
    assert.equal(chunks[0]!.text, 'hmm', 'thinking is not where the line goes')
    assert.match(chunks[1]!.text, /^> ✳️ `opus`.*\n\n---\n\nanswer$/)
  })

  test('/jev quiet keeps routing but drops the line', async () => {
    const { hooks, $ } = load()
    const cmd = hooks.get('command.run:{"command":"jev"}')!
    await cmd($, { args: 'quiet' })
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't5' }, async (e: unknown) => e)
    let sent: { model?: string } = {}
    const chunks = await collect(
      hooks.get('turn.step')!($, { turnId: 't5', index: 0 }, (e: { model: string }) => {
        sent = e
        return modelSays('reply')
      }),
    )
    assert.equal(sent.model, 'claude-opus-5', 'still routed')
    assert.equal(chunks.find(c => c.kind === 'text')!.text, 'reply')
  })

  test('the stop chunk’s usage lands on the turn and /jev confirms what answered', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't6' }, async (e: unknown) => e)
    const chunks = await collect(hooks.get('turn.step')!($, { turnId: 't6', index: 0 }, () => answeredBy('claude-opus-5')))
    assert.equal(chunks.at(-1)!.kind, 'stop', 'the stop chunk still reaches the engine')

    const out = await hooks.get('command.run:{"command":"jev"}')!($, { args: '' })
    assert.match(out.text, /claude-opus-5 ✓/)
    assert.match(out.text, /cache 90%/)
  })

  test('a turn of two steps sums both requests', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't7' }, async (e: unknown) => e)
    await collect(hooks.get('turn.step')!($, { turnId: 't7', index: 0 }, () => answeredBy('claude-opus-5', 'tool_use', 1000)))
    await collect(hooks.get('turn.step')!($, { turnId: 't7', index: 1 }, () => answeredBy('claude-opus-5', 'end_turn', 3000)))
    const out = await hooks.get('command.run:{"command":"jev"}')!($, { args: '' })
    assert.match(out.text, /22k in/, out.text)
  })

  test('a different model answering than was asked for is flagged', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't8' }, async (e: unknown) => e)
    await collect(hooks.get('turn.step')!($, { turnId: 't8', index: 0 }, () => answeredBy('claude-haiku-4-5')))
    const out = await hooks.get('command.run:{"command":"jev"}')!($, { args: '' })
    assert.match(out.text, /claude-haiku-4-5 ≠ claude-opus-5/)
  })

  test('a stop chunk for a turn we never saw is left alone', async () => {
    const { hooks, $ } = load()
    const chunks = await collect(hooks.get('turn.step')!($, { turnId: 'ghost', index: 0 }, () => answeredBy('claude-opus-5')))
    assert.equal(chunks.length, 2)
  })

  test('the footer closes a finished turn, after the reply text', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't9' }, async (e: unknown) => e)
    const chunks = await collect(hooks.get('turn.step')!($, { turnId: 't9', index: 0 }, () => answeredBy('claude-opus-5')))

    const texts = chunks.filter(c => c.kind === 'text')
    const footer = texts.at(-1)!.text
    assert.match(footer, /```\n─+\njev {2}opus·high/)
    assert.match(footer, /api {2}claude-opus-5 ✓/)
    assert.equal(chunks.at(-1)!.kind, 'stop', 'the footer goes before the stop chunk')
    assert.equal(texts.at(-1)!.ref, undefined, 'a chunk we made carries no engine handle')
  })

  test('a step that only called a tool gets no footer, since the turn goes on', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't10' }, async (e: unknown) => e)
    const mid = await collect(hooks.get('turn.step')!($, { turnId: 't10', index: 0 }, () => answeredBy('claude-opus-5', 'tool_use')))
    assert.doesNotMatch(mid.filter(c => c.kind === 'text').map(c => c.text).join(''), /jev {2}opus/)

    const last = await collect(hooks.get('turn.step')!($, { turnId: 't10', index: 1 }, () => answeredBy('claude-opus-5', 'end_turn')))
    assert.match(last.filter(c => c.kind === 'text').at(-1)!.text, /jev {2}opus·high/)
  })

  test('the footer sums the whole turn, not just its last step', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't11' }, async (e: unknown) => e)
    await collect(hooks.get('turn.step')!($, { turnId: 't11', index: 0 }, () => answeredBy('claude-opus-5', 'tool_use', 1000)))
    const last = await collect(hooks.get('turn.step')!($, { turnId: 't11', index: 1 }, () => answeredBy('claude-opus-5', 'end_turn', 3000)))
    assert.match(last.filter(c => c.kind === 'text').at(-1)!.text, /22k in/)
  })

  test('/jev quiet drops the footer with the line', async () => {
    const { hooks, $ } = load()
    await hooks.get('command.run:{"command":"jev"}')!($, { args: 'quiet' })
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't12' }, async (e: unknown) => e)
    const chunks = await collect(hooks.get('turn.step')!($, { turnId: 't12', index: 0 }, () => answeredBy('claude-opus-5')))
    assert.equal(chunks.filter(c => c.kind === 'text').map(c => c.text).join(''), 'reply')
  })

  test('a turn whose response carried no usage ends without a footer', async () => {
    const { hooks, $ } = load()
    await hooks.get('turn.start')!($, { text: 'x', turnId: 't13' }, async (e: unknown) => e)
    const chunks = await collect(hooks.get('turn.step')!($, { turnId: 't13', index: 0 }, () => modelSays('reply')))
    assert.doesNotMatch(chunks.filter(c => c.kind === 'text').map(c => c.text).join(''), /jev {2}opus/)
  })
})
