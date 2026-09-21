import type { On } from 'claude-code'

import { askJev, timeoutOf } from './jev.ts'
import { labelOf, withLabel } from './label.ts'
import { excludedTiers, offeredTiers, type Decision } from './policy.ts'
import { providerOf } from './provider.ts'
import {
  addUsage,
  announceReply,
  attemptOf,
  HISTORY_LIMIT,
  liveLine,
  FOOTER_SEPARATOR,
  REPLY_SEPARATOR,
  statusReport,
  toggleReply,
  usageFooter,
  type Attempt,
} from './status.ts'

/** Turns kept in the decision cache before the oldest are dropped. */
const CACHE_LIMIT = 32

/**
 * Stop reasons that mean the turn continues: the engine will step again, so
 * the footer would land in the middle of a reply. Every other reason ends it.
 */
const MID_TURN: ReadonlySet<string> = new Set(['tool_use', 'pause_turn'])

/**
 * Registers the router: one Jev call per turn, applied to every model request
 * that turn makes, and announced as it happens.
 *
 * The decision is made once in `turn.start`, where the person's text is, and
 * read back in `turn.step`, which fires again after each tool result. Asking
 * per step would pay Jev's latency several times over and could land two
 * steps of one turn on different models.
 *
 * Every turn's outcome is kept, routed or not, because "did this do anything"
 * is unanswerable otherwise: a router that fails open looks exactly like one
 * that is not loaded.
 *
 * @param on the engine's registrar
 */
export function register(on: On) {
  const decisions = new Map<string, Decision>()
  /** turnId → the line to put in front of the reply, until it has been. */
  const pending = new Map<string, string>()
  const attempts: Attempt[] = []
  /**
   * turnId → its attempt, so each step's `stop` chunk can add what the API
   * reported to the right turn. The same objects as in `attempts`.
   */
  const byTurn = new Map<string, Attempt>()
  let latest: Decision | null = null
  let enabled = true
  let announce = true
  let surface: string | null = null

  const trim = (map: Map<string, unknown>) => {
    while (map.size > CACHE_LIMIT) {
      const oldest = map.keys().next()
      if (oldest.done) break
      map.delete(oldest.value)
    }
  }

  const record = (attempt: Attempt) => {
    attempts.unshift(attempt)
    attempts.length = Math.min(attempts.length, HISTORY_LIMIT)
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev',
      description: 'Jev routing: status, or `on` / `off`.',
    })
    surface = await $.session.surface()
    return next(e)
  })

  on('command.run', { command: 'jev' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      if (!enabled) latest = null
      return { text: toggleReply(enabled) }
    }

    if (arg === 'quiet' || arg === 'loud') {
      announce = arg === 'loud'
      return { text: announceReply(announce) }
    }

    const excluded = excludedTiers(await $.env.get('JEV_ROUTER_EXCLUDE'))
    const provider = providerOf({
      TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
      AI_GATEWAY_API_KEY: await $.env.get('AI_GATEWAY_API_KEY'),
      JEV_ROUTER_PROVIDER: await $.env.get('JEV_ROUTER_PROVIDER'),
      TYPESAFE_BASE_URL: await $.env.get('TYPESAFE_BASE_URL'),
    })
    return {
      text: statusReport({
        enabled,
        surface: surface ?? (await $.session.surface()),
        provider,
        timeoutMs: timeoutOf(await $.env.get('JEV_ROUTER_TIMEOUT_MS')),
        offered: offeredTiers(excluded),
        excluded: [...excluded],
        announce,
        attempts,
      }),
    }
  })

  on('turn.start', async ($, e, next) => {
    if (!enabled) return next(e)

    const offered = offeredTiers(
      excludedTiers(await $.env.get('JEV_ROUTER_EXCLUDE')),
    )

    const provider = providerOf({
      TYPESAFE_API_KEY: await $.env.get('TYPESAFE_API_KEY'),
      AI_GATEWAY_API_KEY: await $.env.get('AI_GATEWAY_API_KEY'),
      JEV_ROUTER_PROVIDER: await $.env.get('JEV_ROUTER_PROVIDER'),
      TYPESAFE_BASE_URL: await $.env.get('TYPESAFE_BASE_URL'),
    })

    const result = await askJev({
      fetch: (url, init) => $.http.fetch(url, init),
      sleep: ms => $.clock.sleep(ms),
      provider,
      state: e.text,
      offered,
      timeoutMs: timeoutOf(await $.env.get('JEV_ROUTER_TIMEOUT_MS')),
    })

    // One place where the turn's outcome is settled, so the report and the
    // announcement can never disagree about what happened.
    const attempt = attemptOf(e.text, result, offered)
    record(attempt)
    byTurn.set(e.turnId, attempt)
    trim(byTurn)

    // The line goes into the reply's own text, in turn.step below. Render
    // hooks and $.ui.log both drew nothing in the desktop app; the model's
    // text is the one channel that reaches every surface.
    if (announce) {
      pending.set(e.turnId, liveLine(attempt))
      trim(pending)
    }

    if ('decision' in attempt) {
      decisions.set(e.turnId, attempt.decision)
      trim(decisions)
      latest = attempt.decision
    }

    return next(e)
  })

  // turn.step streams, so it is an async generator. The model rewrite goes
  // down in `e`; the label comes back up in the first text chunk of the turn,
  // and the `stop` chunk's usage, which names the model the API says answered,
  // is kept on the turn. That is the check on the rewrite: the route line is
  // what was asked for, /jev shows what was got.
  //
  // Text chunks concatenate per block, so prefixing the first one puts the
  // line at the top of the reply. This is the recorded text too, so the model
  // sees its past replies open with the line; that is the price of a marker
  // that reaches a surface which draws neither render sites nor ui.log.
  on('turn.step', async function* ($, e, next) {
    const decision = decisions.get(e.turnId)
    const step = decision
      ? next({ ...e, model: decision.model, effort: decision.effort })
      : next(e)

    // The block the footer joins, so it lands at the end of the reply's text
    // rather than opening a block of its own.
    let lastTextIndex = 0

    for await (const chunk of step) {
      const label = pending.get(e.turnId)
      if (chunk.kind === 'text') {
        lastTextIndex = chunk.index
        if (label !== undefined) {
          pending.delete(e.turnId)
          yield { ...chunk, text: `${label}${REPLY_SEPARATOR}${chunk.text}` }
          continue
        }
      }

      if (chunk.kind === 'stop') {
        const attempt = byTurn.get(e.turnId)
        if (attempt && chunk.usage) addUsage(attempt, chunk.usage)

        // The index must be one past the last text block, and this is
        // load-bearing. A chunk yielded at an index the engine already
        // streamed is dropped on the floor, silently: probed live, a chunk
        // at `lastTextIndex` never reached the transcript, one at
        // `lastTextIndex + 1` did. It opens a block of its own, which is
        // what a footer wants anyway — the reply above it stays untouched.
        //
        // No `ref`, because the engine's handle belongs to a chunk the
        // engine streamed; one a hook built has none and is taken at its
        // word. It goes before the stop chunk, the last thing the engine
        // expects to see.
        if (attempt && announce && !MID_TURN.has(chunk.stopReason ?? '')) {
          const footer = usageFooter(attempt)
          if (footer !== null) {
            yield {
              kind: 'text' as const,
              index: lastTextIndex + 1,
              text: `${FOOTER_SEPARATOR}${footer}`,
            }
          }
        }
      }

      yield chunk
    }
  })

  // The footer, where a surface draws one. The announcement above is what
  // carries on surfaces that draw no footer, which is most of them.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const modes = withLabel(e.props.modes, labelOf(latest, enabled))
    return next({ ...e, props: { ...e.props, modes } })
  })
}
