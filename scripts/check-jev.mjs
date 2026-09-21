/**
 * Checks whether Jev (either TypeSafe direct or Vercel AI Gateway) will serve requests.
 *
 * Determines which provider is configured and runs the appropriate diagnostic.
 * For the gateway, checks credits. For TypeSafe direct, makes a live call.
 *
 * Run it after changing anything on the TypeSafe or Vercel side:
 *
 *   npm run check-jev
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const settings = JSON.parse(
  readFileSync(`${homedir()}/.claude/settings.json`, 'utf8'),
)

const env = settings?.env ?? {}
const tsKey = env.TYPESAFE_API_KEY
const gwKey = env.AI_GATEWAY_API_KEY
const forced = (env.JEV_ROUTER_PROVIDER ?? '').toLowerCase()

// Determine which provider is active
let provider = null
let activeKey = null

if (forced === 'typesafe') {
  if (!tsKey) {
    console.error('JEV_ROUTER_PROVIDER=typesafe but TYPESAFE_API_KEY is not set.')
    process.exit(1)
  }
  provider = 'typesafe'
  activeKey = tsKey
} else if (forced === 'gateway') {
  if (!gwKey) {
    console.error('JEV_ROUTER_PROVIDER=gateway but AI_GATEWAY_API_KEY is not set.')
    process.exit(1)
  }
  provider = 'gateway'
  activeKey = gwKey
} else {
  // Default precedence
  if (tsKey) {
    provider = 'typesafe'
    activeKey = tsKey
  } else if (gwKey) {
    provider = 'gateway'
    activeKey = gwKey
  } else {
    console.error('No TYPESAFE_API_KEY or AI_GATEWAY_API_KEY in ~/.claude/settings.json.')
    process.exit(1)
  }
}

const fingerprint = createHash('sha256')
  .update(activeKey)
  .digest('hex')
  .slice(0, 12)
console.log(`provider       ${provider}`)
console.log(`key            ${activeKey.length} chars, sha256[:12]=${fingerprint}`)

if (provider === 'gateway') {
  // Gateway: check credits first
  const auth = { authorization: `Bearer ${activeKey}` }

  const credits = await fetch('https://ai-gateway.vercel.sh/v1/credits', {
    headers: auth,
  })
  const balance = credits.ok ? await credits.json() : null

  if (!credits.ok) {
    console.log(`credits        HTTP ${credits.status} — the key itself is not being accepted`)
    process.exit(1)
  }

  console.log(`credits        balance ${balance.balance}, used ${balance.total_used}`)

  // Gateway: make an evaluate call
  const probe = await fetch('https://ai-gateway.vercel.sh/v1/evaluate', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'typesafe-ai/jev',
      state: 'what is 2+2',
      questions: {
        tier: {
          type: 'choice',
          instructions: 'Which tier should answer this?',
          criteria: { haiku: 'trivial', opus: 'implementation' },
        },
      },
    }),
  })

  const text = (await probe.text()).replaceAll(activeKey, '<REDACTED>')

  if (probe.ok) {
    const answer = JSON.parse(text)
    console.log(`evaluate       HTTP 200 — Jev answered "${answer.answers?.tier?.choice}"`)
    console.log('\nThe gateway is serving. jev-router will route.')
    process.exit(0)
  }

  console.log(`evaluate       HTTP ${probe.status}`)
  console.log(text.slice(0, 400))

  if (Number(balance.balance) === 0) {
    console.log(
      '\nBalance is 0, so this account has never been granted credits. ' +
        'Whatever card was added went to a different Vercel scope than the one ' +
        'this key belongs to. Add it to this scope, or make a new key under the ' +
        'scope that has the card.',
    )
  }
  process.exit(1)
} else {
  // TypeSafe direct: make a systemone call
  const auth = { authorization: `Bearer ${activeKey}` }
  const base = (env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/$/, '')

  const probe = await fetch(`${base}/v1/systemone`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: 'what is 2+2',
      questions: {
        tier: {
          type: 'choice',
          instructions: 'Which tier should answer this?',
          criteria: { haiku: 'trivial', opus: 'implementation' },
        },
      },
    }),
  })

  const text = (await probe.text()).replaceAll(activeKey, '<REDACTED>')

  if (probe.ok) {
    const answer = JSON.parse(text)
    console.log(`systemone      HTTP 200 — Jev answered "${answer.answers?.tier?.choice}"`)
    console.log('\nTypeSafe direct is serving. jev-router will route.')
    process.exit(0)
  }

  console.log(`systemone      HTTP ${probe.status}`)
  console.log(text.slice(0, 400))
  process.exit(1)
}
