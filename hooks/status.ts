/**
 * What `/jev` prints. This is the router's only guaranteed-visible surface:
 * a command's output row draws on every surface, where a footer label may
 * not, so anything you need to be sure of belongs here.
 */

import type { JevResult } from './jev.ts'
import { LOW_CONFIDENCE } from './label.ts'
import { decisionOf, type Decision, type Tier } from './policy.ts'
import type { ProviderResult } from './provider.ts'

/** One turn's outcome, kept for the status report. */
export type Attempt = {
  prompt: string
  ms: number
} & ({ decision: Decision } | { skipped: string })

export type Status = {
  enabled: boolean
  surface: string | null
  provider: ProviderResult
  timeoutMs: number
  offered: readonly Tier[]
  excluded: readonly Tier[]
  announce: boolean
  attempts: readonly Attempt[]
}

/**
 * One turn's outcome from Jev's answer, so the three ways a turn can fail to
 * route all land in one place and all get announced the same way.
 */
export function attemptOf(
  prompt: string,
  result: JevResult,
  offered: readonly Tier[],
): Attempt {
  if (!result.ok) return { prompt, ms: result.ms, skipped: result.reason }

  const decision = decisionOf(result.answers, offered)
  if (!decision) {
    return {
      prompt,
      ms: result.ms,
      skipped: 'Jev answered but named no tier we offered',
    }
  }
  return { prompt, ms: result.ms, decision }
}

/** The last few turns, newest first, so the report stays one screen. */
export const HISTORY_LIMIT = 5

function shorten(text: string, width = 44): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

function attemptLine(attempt: Attempt): string {
  const when = `${String(attempt.ms).padStart(4)}ms`
  if ('skipped' in attempt) {
    return `  ${when}  unrouted — ${attempt.skipped}`
  }
  const { tier, effort, confidence } = attempt.decision
  const doubt = confidence < LOW_CONFIDENCE ? ' (low confidence)' : ''
  return `  ${when}  ${tier}·${effort} ${confidence.toFixed(2)}${doubt}  ${shorten(attempt.prompt)}`
}

/**
 * The report, as plain lines. Written so the first three tell you whether
 * the thing is on at all, which is the question that brings people here.
 */
export function statusReport(status: Status): string {
  const lines: string[] = ['jev-router']

  lines.push(`  routing   ${status.enabled ? 'on' : 'off (/jev on)'}`)
  lines.push(`  surface   ${status.surface ?? 'unknown'}`)

  if (status.provider.ok) {
    const key =
      status.provider.name === 'typesafe' ? 'TYPESAFE_API_KEY' : 'AI_GATEWAY_API_KEY'
    lines.push(`  provider  ${status.provider.name} · ${key} is set`)
  } else {
    lines.push(`  provider  NO KEYS — nothing will route`)
  }

  lines.push(`  budget    ${status.timeoutMs}ms`)
  lines.push(`  tiers     ${status.offered.join(', ')}`)
  lines.push(
    `  announce  ${status.announce ? 'on, a line per turn' : 'off (/jev loud)'}`,
  )
  if (status.excluded.length > 0) {
    lines.push(`  excluded  ${status.excluded.join(', ')}`)
  }

  lines.push('')
  if (status.attempts.length === 0) {
    lines.push('  No turns yet. Send a prompt, then run /jev again.')
    return lines.join('\n')
  }

  lines.push('  Recent turns, newest first:')
  for (const attempt of status.attempts) lines.push(attemptLine(attempt))

  return lines.join('\n')
}

/** The reply to `/jev on`, `/jev off` and anything unrecognised. */
export function toggleReply(enabled: boolean): string {
  return enabled
    ? 'Jev routing on. The next turn picks its own model.'
    : 'Jev routing off. Turns run on the session model.'
}

/**
 * The line put at the top of each reply, as markdown.
 *
 * Markdown, because the line rides in the reply's own text and that is what
 * the transcript renders. A blockquote sets it off from prose with a rail
 * and dimmer text; the tier is inline code, which the theme colours. Neither
 * a render hook nor `$.ui.log` drew anything in the desktop app, so this is
 * the styling that is actually available.
 */
export function liveLine(attempt: Attempt): string {
  if ('skipped' in attempt) {
    return `> ⚠️ \`unrouted\` · ${attempt.skipped}`
  }

  const { tier, effort, confidence } = attempt.decision
  const doubt = confidence < LOW_CONFIDENCE ? '?' : ''
  const pct = Math.round(confidence * 100)
  return `> ✳️ \`${tier}\` · ${effort} · ${pct}%${doubt} · ${attempt.ms}ms`
}

/**
 * The rule drawn under the line, closing it off from the reply.
 *
 * It needs the blank line before it: `---` on the line after text is a setext
 * heading underline, which would turn the route into a heading instead.
 */
export const REPLY_SEPARATOR = '\n\n---\n\n'

/** The reply to `/jev quiet` and `/jev loud`. */
export function announceReply(announce: boolean): string {
  return announce
    ? 'Jev will announce each route in the transcript.'
    : 'Jev will route quietly. Run /jev to see what it has been doing.'
}
