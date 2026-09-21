/**
 * Shows the tier and effort Jev picks for a spread of prompts, using the real
 * policy from hooks/policy.ts. This is the tuning loop: edit TIER_CRITERIA,
 * run this, see whether the picks moved the way you wanted.
 *
 *   npm run try-prompts
 *   npm run try-prompts -- "your own prompt here"
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { askJev } from '../hooks/jev.ts'
import { decisionOf, TIERS } from '../hooks/policy.ts'
import { providerOf } from '../hooks/provider.ts'

const settings = JSON.parse(
  readFileSync(`${homedir()}/.claude/settings.json`, 'utf8'),
)
const env = settings?.env ?? {}

const provider = providerOf({
  TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
  AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY,
  JEV_ROUTER_PROVIDER: env.JEV_ROUTER_PROVIDER,
  TYPESAFE_BASE_URL: env.TYPESAFE_BASE_URL,
})

if (!provider.ok) {
  console.error(`Provider error: ${provider.reason}`)
  process.exit(1)
}

const DEFAULTS = [
  'what is 2+2',
  'what does this function return',
  'rename the variable foo to bar in utils.ts',
  'add a --verbose flag to the CLI',
  'write a test for the pagination helper',
  'implement cursor pagination for the reports endpoint',
  'refactor the auth module to use the new session interface',
  'the e2e suite passes alone but fails when run with the others, work out why',
  'help me plan the architecture for multi-tenant billing',
  'should we use event sourcing here or is that overkill',
]

const prompts = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS
const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log('  ms  tier    effort  conf  prompt')
console.log('  ──  ──────  ──────  ────  ──────')

for (const prompt of prompts) {
  const started = Date.now()
  const result = await askJev({
    fetch: async (url, init) => {
      const r = await fetch(url, init)
      return { ok: r.ok, status: r.status, text: await r.text() }
    },
    sleep,
    provider,
    state: prompt,
    offered: TIERS,
    timeoutMs: 10_000,
  })
  const ms = Date.now() - started
  const answers = result.ok ? result.answers : null
  const d = decisionOf(answers, TIERS)

  const short = prompt.length > 62 ? `${prompt.slice(0, 59)}...` : prompt
  if (!d) {
    console.log(`${String(ms).padStart(4)}  FAILED OPEN                 ${short}`)
    continue
  }
  console.log(
    `${String(ms).padStart(4)}  ${d.tier.padEnd(6)}  ${d.effort.padEnd(6)}  ` +
      `${d.confidence.toFixed(2)}  ${short}`,
  )
}
