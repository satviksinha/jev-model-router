# jev-router

Picks the model for each turn with [Jev](https://docs.typesafe.ai), TypeSafe's
decision model. Supports both TypeSafe's direct API and the Vercel AI Gateway.

You type a prompt. Before the turn runs, Jev is asked two questions at once:
which tier should answer this, and how hard should it think. Every model
request in that turn then goes to the model Jev named, and a line above the
reply says which one.

```
Context    you type a prompt
              ↓
turn.start    ask Jev  →  tier: fable   effort: 3
              ↓
turn.step     next({ ...e, model: 'claude-fable-5-1', effort: 'xhigh' })
              first text chunk ← 'jev → fable·xhigh  0.97 · 641ms\n\n' + text
              ↓
/jev          the full history, with reasons for anything unrouted
```

## The ladder

| Tier | For | Model |
| --- | --- | --- |
| `haiku` | Trivial. A lookup, a rename, a yes or no. | `claude-haiku-4-5` |
| `sonnet` | Straightforward and minor, no real decision to make. | `claude-sonnet-5` |
| `opus` | Plain implementation carrying some complexity. | `claude-opus-5` |
| `fable` | Planning, brainstorming, architecture, systematic debugging. | `claude-fable-5-1` |

The policy lives in `TIER_CRITERIA` in `hooks/policy.ts`. Those strings are
what Jev is told each tier is for, so editing them is how you change the
router's behaviour. Nothing else needs to change.

## Setup

### Provider: TypeSafe direct or Vercel AI Gateway

Get either a TypeSafe API key or an AI Gateway key and put it in the `env` block
of `~/.claude/settings.json`. The router prefers TypeSafe direct when both keys
are set:

```json
{
  "env": {
    "TYPESAFE_API_KEY": "...",
    "AI_GATEWAY_API_KEY": "...",
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

**For TypeSafe direct:** Get a key from your [TypeSafe account](https://console.typesafe.ai/keys).

**For the Vercel AI Gateway:** Get a key from your [Vercel dashboard](https://vercel.com/dashboard) and note
that the gateway **needs a card on the account**, not just a key. A valid key
on an account with no payment method gets:

```
HTTP 403  customer_verification_required
"AI Gateway requires a valid credit card on file to service requests."
```

A personal-scope gateway key needs a card before it serves anything, even on free
credits. A team-scope key reportedly does not.

**Forcing a provider:** If both keys are set and you want to use the gateway,
set `JEV_ROUTER_PROVIDER=gateway`. Similarly, `JEV_ROUTER_PROVIDER=typesafe`
forces TypeSafe direct.

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is not optional. Without it the mod loads
and silently does nothing, with no warning.

Because the router fails open, setup issues show up as the mod doing nothing
at all rather than as an error. Run `npm run check-jev` when nothing seems to
route to see which provider is configured and whether it's serving.

Then run Claude Code with the mod:

```
claude --plugin-dir ~/Desktop/jev-router
```

To keep it on permanently, move the folder to `~/.claude/skills/jev-router/`,
where it loads on its own next session.

## Knowing whether it is working

Three signals, in order of how much you can trust them.

**`/jev`** prints the full state. A command's output row draws on every
surface, so this always works:

```
jev-router
  routing   on
  surface   desktop
  provider  typesafe · TYPESAFE_API_KEY is set
  budget    1500ms
  tiers     haiku, sonnet, opus, fable

  Recent turns, newest first:
   641ms  fable·xhigh 0.97  help me plan the architecture
   402ms  haiku·medium 0.75  rename the variable foo to bar
    12ms  unrouted — gateway said HTTP 403 (customer_verification_required)
```

An unrouted turn says why. That matters because the router fails open, so a
dead provider and a missing plugin look identical from the outside.

**The first line of every reply.** The route is written into the reply's
own text, as the first text chunk streams through `turn.step`:

```markdown
> ✳️ `opus` · high · 98% · 555ms

---

Here is the implementation...
```

Markdown, because the line rides in the reply's text and that is what the
transcript renders, so it is the only styling available. The blockquote sets
it off from prose with a rail and dimmer text; the tier is inline code,
which the theme colours. The blank line before `---` is load-bearing: a
rule on the line directly after text is a setext heading underline, and the
route would render as a heading.

An unrouted turn opens with `> ⚠️ \`unrouted\` · reason`. A `?` after the
percentage means Jev was under 50% sure. `/jev quiet` drops the line without
turning routing off; `/jev loud` brings it back.

The line is part of the recorded message, so the model sees its own past
replies open with it. That is the cost of a marker that reaches the desktop
app: two cleaner mechanisms were tried first and neither drew there. An
`AssistantMessage` render rewrite was correct against the generated types
and drew nothing; `$.ui.log`, documented as a dim transcript row, also drew
nothing. That tab reports `$.session.surface()` as `unknown` and appears to
be an SDK host that drops both. Reply text and command output are the two
channels that reach it.

**The footer**, via `SessionMode`. Terminal only in practice, so treat its
absence as meaning nothing.

The app's own model indicator will never change. It shows the *session*
model, which this mod does not touch — the rewrite happens per request, in
`turn.step`.

## Commands and switches

- `/jev` prints the status above. `/jev on` and `/jev off` set routing
  explicitly rather than toggling blind.
- `/jev quiet` and `/jev loud` control the line at the top of each reply.
  Quiet still routes and still records, so `/jev` shows what you missed.
- `JEV_ROUTER_PROVIDER=typesafe|gateway` forces a specific provider. If both
  keys are set, the default is TypeSafe direct; use this to force the gateway.
- `TYPESAFE_BASE_URL=https://api.example.com` overrides the TypeSafe endpoint
  base (defaults to `https://api.typesafe.ai`). Useful for custom deployments.
- `JEV_ROUTER_EXCLUDE=fable,haiku` drops those tiers from the question
  entirely, so Jev is never offered them. Excluding all four is ignored.
- `JEV_ROUTER_TIMEOUT_MS=2500` changes how long a turn waits for Jev before
  giving up and running unrouted. The default is 1500ms. Ten live calls on
  2026-09-20 ran 402ms to 839ms, so an earlier 800ms default was failing open
  on the slowest of them.

## Checking and tuning

```
npm run check-jev        # is the configured provider serving?
npm run try-prompts      # what tier does Jev give a spread of prompts?
npm run try-prompts -- "your prompt"
```

`check-jev` detects which provider is configured and runs the appropriate
diagnostic. For the gateway it checks credits; for TypeSafe direct it makes a
live call. `try-prompts` is the tuning loop: edit `TIER_CRITERIA`, run it, and
see whether the picks moved the way you wanted. Neither script ever prints the key.

Measured on 2026-09-20 against the shipped criteria:

```
  ms  tier    effort  conf  prompt
 839  haiku   low     1.00  what is 2+2
 508  haiku   xhigh   0.86  what does this function return
 402  haiku   medium  0.75  rename the variable foo to bar in utils.ts
 482  sonnet  medium  0.66  add a --verbose flag to the CLI
 426  opus    high    0.66  write a test for the pagination helper
 555  opus    high    0.98  implement cursor pagination for the reports endpoint
 483  opus    xhigh   0.97  refactor the auth module to use the new session interface
 641  fable   xhigh   0.97  the e2e suite passes alone but fails with the others
 734  fable   xhigh   1.00  help me plan the architecture for multi-tenant billing
 479  fable   xhigh   1.00  should we use event sourcing here or is that overkill
```

Note row two. Tier and effort are separate questions, so they can disagree:
an out-of-context question reads as trivial to route but hard to answer. The
engine silently downgrades an effort the chosen model does not support, so
this is harmless, but it is why a `haiku·xhigh` label is possible.

## When it does nothing

The router fails open at every step, and a turn it cannot decide runs exactly
as it would without the mod:

- no `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, no request is made at all
- the provider takes longer than the timeout (1500ms by default)
- the provider refuses the key, errors, or returns a body we cannot read
- Jev names a tier that was not offered

The only cost of a failure is the latency spent waiting, capped at the timeout.

Low confidence is not a failure. The pick is used and the line marks it, so
`jev → opus·high?` means Jev was under 50% sure of the tier.

An unrouted turn announces itself too, with the reason:

```
jev → unrouted (gateway said HTTP 403 (customer_verification_required))
```

## Layout

```
hooks/register.ts   the five hooks, the per-turn cache, the turn history
hooks/jev.ts        the request shape, timeout, named failures
hooks/provider.ts   which backend (TypeSafe direct or gateway) to use
hooks/policy.ts     the tiers, the criteria, answers → model and effort
hooks/label.ts      decision → footer string
hooks/status.ts     the per-turn line and what /jev prints
tests/              node:test suites; register.test.ts drives the real hooks
                    with a fake engine and asserts the stream transform
scripts/            check-jev and try-prompts, for setup and tuning
```

`jev.ts` takes `fetch` and `sleep` as arguments rather than importing them, so
the tests run with no engine and no network. `provider.ts` is pure: it takes
environment variables and returns which provider to use, with all credentials
and endpoints already resolved.

## Working on it

```
node --test 'tests/*.test.ts'
claude plugin validate .
```

`plugin validate` is worth running on every change. It does static analysis and
prints every event the module hooks, everything it calls on `$`, and every
environment variable it reads or writes, without executing anything. It also
catches shape errors that are easy to get wrong, such as `turn.step` needing to
be an `async function*` because it streams.

There is no `claude plugin test` in Claude Code 2.1.275, so the engine-level
test kit described in the upstream `mods/README.md` is not available yet.

## Backends

Both backends speak the same `choice` and `score` question types and the same
`answers` response shape, so the request/response handling is identical.

**TypeSafe direct** endpoint: `POST https://api.typesafe.ai/v1/systemone`.
Bearer auth, body is `{ model: "jev-latest", state, questions }`. Probabilities
and confidences come back rounded to four decimal places. Supports all three
question types: `choice`, `score`, and `noul`.

**Vercel AI Gateway** endpoint: `POST https://ai-gateway.vercel.sh/v1/evaluate`.
Bearer auth, body is `{ model, state, questions }` (the gateway ignores the
model field). Probabilities and confidences come back rounded to two decimal
places. Only supports `choice` and `score` — the gateway rejects `noul` outright.
