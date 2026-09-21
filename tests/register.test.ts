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
})
