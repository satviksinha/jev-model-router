import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  announceReply,
  attemptOf,
  stickyCommand,
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
} from "../hooks/status.ts";
import { DEFAULT_STICKY_CONFIDENCE } from "../hooks/policy.ts";
import type { ProviderResult } from "../hooks/provider.ts";

const decision = {
  tier: "fable" as const,
  model: "claude-fable-5-1",
  effort: "xhigh" as const,
  confidence: 0.97,
};

const goodProvider: ProviderResult = {
  ok: true,
  name: "gateway",
  endpoint: "https://ai-gateway.vercel.sh/v1/evaluate",
  model: "typesafe-ai/jev",
  apiKey: "test-key",
};

const noKeyProvider: ProviderResult = {
  ok: false,
  reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
};

const base: Status = {
  enabled: true,
  surface: "desktop",
  provider: goodProvider,
  timeoutMs: 1500,
  sticky: null,
  offered: ["haiku", "sonnet", "opus", "fable"],
  excluded: [],
  announce: true,
  attempts: [],
};

describe("status report", () => {
  test('the first lines answer "is this even on"', () => {
    const lines = statusReport(base).split("\n");
    assert.match(lines[1] ?? "", /routing\s+on/);
    assert.match(lines[2] ?? "", /surface\s+desktop/);
    assert.match(lines[3] ?? "", /gateway.*AI_GATEWAY_API_KEY is set/);
  });

  test("a missing key is stated loudly, not implied", () => {
    const text = statusReport({ ...base, provider: noKeyProvider });
    assert.match(text, /NO KEYS — nothing will route/);
  });

  test("routing off says how to turn it back on", () => {
    assert.match(statusReport({ ...base, enabled: false }), /off \(\/jev on\)/);
  });

  test("before any turn it says so rather than showing an empty table", () => {
    assert.match(statusReport(base), /No turns yet/);
  });

  test("a routed turn shows tier, effort, confidence and latency", () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: "plan the migration", ms: 641, decision }],
    });
    assert.match(text, /641ms/);
    assert.match(text, /fable·xhigh 0\.97/);
    assert.match(text, /plan the migration/);
  });

  test("an unrouted turn shows why, which is the whole point", () => {
    const text = statusReport({
      ...base,
      attempts: [
        {
          prompt: "x",
          ms: 12,
          skipped: "gateway said HTTP 403 (customer_verification_required)",
        },
      ],
    });
    assert.match(text, /unrouted — gateway said HTTP 403/);
  });

  test("a low-confidence pick is called out in words, not a symbol", () => {
    const text = statusReport({
      ...base,
      attempts: [
        { prompt: "x", ms: 400, decision: { ...decision, confidence: 0.3 } },
      ],
    });
    assert.match(text, /low confidence/);
  });

  test("excluded tiers are listed only when there are some", () => {
    assert.doesNotMatch(statusReport(base), /excluded/);
    assert.match(
      statusReport({
        ...base,
        excluded: ["fable"],
        offered: ["haiku", "sonnet", "opus"],
      }),
      /excluded\s+fable/,
    );
  });

  test("a long prompt is trimmed so the report stays one screen", () => {
    const text = statusReport({
      ...base,
      attempts: [{ prompt: "a".repeat(200), ms: 1, decision }],
    });
    for (const line of text.split("\n")) assert.ok(line.length < 100, line);
  });

  test("toggling reports the state it moved to", () => {
    assert.match(toggleReply(true), /on\./);
    assert.match(toggleReply(false), /session model/);
  });
});

describe("live line", () => {
  test("a routed turn is announced with tier, effort, confidence and latency", () => {
    assert.equal(
      liveLine({ prompt: "plan the migration", ms: 641, decision }),
      "> ✳️ `fable` · xhigh · 97% · 641ms",
    );
  });

  test("an unrouted turn announces why, rather than going silent", () => {
    assert.equal(
      liveLine({
        prompt: "x",
        ms: 12,
        skipped: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
      }),
      "> ⚠️ `unrouted` · no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY",
    );
  });

  test("a shaky pick is marked so a bad route is visible as it happens", () => {
    assert.match(
      liveLine({
        prompt: "x",
        ms: 400,
        decision: { ...decision, confidence: 0.3 },
      }),
      /· 30%\? ·/,
    );
  });

  test("the line is a blockquote with the tier as inline code, since that is what the transcript can colour", () => {
    const line = liveLine({ prompt: "x", ms: 641, decision });
    assert.ok(line.startsWith("> "), line);
    assert.match(line, /`fable`/);
  });

  test("the separator is a rule with a blank line before it, or --- would make the route a heading", () => {
    assert.equal(REPLY_SEPARATOR, "\n\n---\n\n");
  });

  test("the line stays short enough not to wrap", () => {
    const line = liveLine({ prompt: "a".repeat(300), ms: 641, decision });
    assert.ok(line.length < 60, line);
  });

  test("announcing can be turned off without turning routing off", () => {
    assert.match(announceReply(false), /quietly/);
    assert.match(announceReply(true), /announce/);
    assert.match(statusReport({ ...base, announce: false }), /announce\s+off/);
  });
});

describe("attemptOf", () => {
  const offered = ["haiku", "sonnet", "opus", "fable"] as const;
  const skippedOf = (a: ReturnType<typeof attemptOf>) =>
    "skipped" in a ? a.skipped : "UNEXPECTEDLY ROUTED";

  test("a good answer becomes a routed attempt", () => {
    const attempt = attemptOf(
      "plan it",
      {
        ok: true,
        ms: 500,
        answers: { tier: { type: "choice", choice: "fable" } },
      },
      offered,
    );
    assert.equal("decision" in attempt && attempt.decision.tier, "fable");
    assert.equal(attempt.ms, 500);
  });

  test("a failed call keeps its reason, so the line can say why", () => {
    assert.equal(
      skippedOf(
        attemptOf(
          "x",
          { ok: false, ms: 9, reason: "timed out after 1500ms" },
          offered,
        ),
      ),
      "timed out after 1500ms",
    );
  });

  test("an answer naming a tier we did not offer is its own reason", () => {
    assert.match(
      skippedOf(
        attemptOf("x", { ok: true, ms: 5, answers: { tier: {} } }, offered),
      ),
      /named no tier we offered/,
    );
  });
});

describe("usage: what actually answered", () => {
  const routed = (): Attempt => ({ prompt: "plan it", ms: 641, decision });
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: "claude-fable-5-1",
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  });

  test("a stop chunk’s usage is kept on the turn", () => {
    const a = routed();
    addUsage(a, usage());
    assert.equal(a.usage?.model, "claude-fable-5-1");
    assert.equal(a.usage?.cache_read_input_tokens, 117_000);
  });

  test("a turn of several steps sums its counts and keeps the last model", () => {
    const a = routed();
    addUsage(a, usage({ input_tokens: 1000, output_tokens: 100 }));
    addUsage(
      a,
      usage({
        input_tokens: 2000,
        output_tokens: 200,
        model: "claude-fable-5-1-later",
      }),
    );
    assert.equal(a.usage?.input_tokens, 3000);
    assert.equal(a.usage?.output_tokens, 300);
    assert.equal(a.usage?.model, "claude-fable-5-1-later");
  });

  test("the cache ratio is what was read over everything the request carried", () => {
    assert.equal(cacheRatio(usage()), 0.9);
    assert.equal(
      cacheRatio(
        usage({
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ),
      0,
    );
  });

  test("the report confirms the model the API says answered", () => {
    const a = routed();
    addUsage(a, usage());
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-fable-5-1 ✓/);
    assert.match(text, /cache 90%/);
    assert.match(text, /130k in/);
  });

  test("a dated id still counts as the model that was asked for", () => {
    const a = routed();
    addUsage(a, usage({ model: "claude-fable-5-1-20260901" }));
    assert.match(
      statusReport({ ...base, attempts: [a] }),
      /claude-fable-5-1-20260901 ✓/,
    );
  });

  test("a different model answering is flagged, which is the whole point", () => {
    const a = routed();
    addUsage(a, usage({ model: "claude-opus-5-5" }));
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-opus-5-5 ≠ claude-fable-5-1/);
    assert.doesNotMatch(text, /✓/);
  });

  test("an unrouted turn still shows what answered, with nothing to check against", () => {
    const a: Attempt = { prompt: "x", ms: 0, skipped: "timed out" };
    addUsage(a, usage({ model: "claude-opus-5-5" }));
    const text = statusReport({ ...base, attempts: [a] });
    assert.match(text, /claude-opus-5-5);
    assert.doesNotMatch(text, /[✓≠]/);
  });

  test("a turn with no usage yet gets one line, not a blank second one", () => {
    const lines = statusReport({ ...base, attempts: [routed()] }).split("\n");
    assert.equal(lines.filter((l) => l.includes("answered")).length, 0);
  });

  test("the usage line stays within one screen", () => {
    const a = routed();
    addUsage(
      a,
      usage({
        model: "claude-fable-5-1-20260901-preview",
        cache_read_input_tokens: 1_900_000,
      }),
    );
    for (const line of statusReport({ ...base, attempts: [a] }).split("\n"))
      assert.ok(line.length < 100, line);
  });
});

describe("usage footer", () => {
  const usage = (over: Partial<Usage> = {}): Usage => ({
    model: "claude-fable-5-1",
    input_tokens: 3_000,
    output_tokens: 900,
    cache_read_input_tokens: 117_000,
    cache_creation_input_tokens: 10_000,
    ...over,
  });
  const withUsage = (a: Attempt, u = usage()) => {
    addUsage(a, u);
    return a;
  };
  const routed = (): Attempt => ({ prompt: "plan it", ms: 641, decision });

  test("a turn with no usage has no footer", () => {
    assert.equal(usageFooter(routed()), null);
  });

  test("it is a fenced block, or markdown eats the indent and joins the lines", () => {
    const lines = usageFooter(withUsage(routed()))!.split("\n");
    assert.equal(lines[0], "```");
    assert.equal(lines.at(-1), "```");
    assert.match(lines[1]!, /^─+$/);
  });

  test("the jev line is what was asked for", () => {
    const footer = usageFooter(withUsage(routed()))!;
    assert.match(footer, /jev {2}fable·xhigh · 97% · 641ms/);
  });

  test("the api line is what answered, with the cost", () => {
    const footer = usageFooter(withUsage(routed()))!;
    assert.match(
      footer,
      /api {2}claude-fable-5-1 ✓ · cache 90% · 130k in · 1k out/,
    );
  });

  test("a mismatch names both, which is the one case worth looking at", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ model: "claude-opus-5-5" })),
    )!;
    assert.match(footer, /api {2}claude-opus-5-5≠ claude-fable-5-1/);
  });

  test("a dated id is still the model that was asked for", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ model: "claude-fable-5-1-20260901" })),
    )!;
    assert.match(footer, /claude-fable-5-1-20260901 ✓/);
  });

  test("an unrouted turn reports what answered, with nothing to compare", () => {
    const a: Attempt = {
      prompt: "x",
      ms: 0,
      skipped: "timed out after 1500ms",
    };
    const footer = usageFooter(
      withUsage(a, usage({ model: "claude-opus-5-5" })),
    )!;
    assert.match(footer, /jev {2}unrouted — timed out after 1500ms/);
    assert.match(footer, /api {2}claude-opus-5-5· cache 90%/);
    assert.doesNotMatch(footer, /[✓≠]/);
  });

  test("the rule spans the widest line, and nothing wraps", () => {
    const footer = usageFooter(
      withUsage(routed(), usage({ cache_read_input_tokens: 1_900_000 })),
    )!;
    const lines = footer.split("\n");
    const rule = lines[1]!;
    const widest = Math.max(...lines.slice(2, -1).map((l) => [...l].length));
    assert.equal([...rule].length, widest);
    for (const line of lines) assert.ok([...line].length < 100, line);
  });
});

describe("turns that are not a typed prompt", () => {
  const notice = `<task-notification>
<task-id>a8fb449ee56c09</task-id>
<status>completed</status>
<summary>Agent "Review library-sync cluster" completed</summary>
</task-notification>`;

  test("a task notification is recognised and its summary kept as the prompt", () => {
    const a = attemptOf(notice, { ok: true, ms: 653, answers: {} as never }, [
      "fable",
    ]);
    assert.equal(a.kind, "notify");
    assert.equal(a.prompt, 'Agent "Review library-sync cluster" completed');
  });

  test("a notification without a summary falls back to its id", () => {
    const a = attemptOf(
      "<task-notification><task-id>abc123</task-id></task-notification>",
      { ok: false, ms: 0, reason: "x" },
      ["fable"],
    );
    assert.equal(a.kind, "notify");
    assert.equal(a.prompt, "task abc123");
  });

  test("a typed prompt has no kind", () => {
    assert.equal(
      attemptOf("plan it", { ok: false, ms: 0, reason: "x" }, ["fable"]).kind,
      undefined,
    );
  });

  const notify: Attempt = {
    prompt: 'Agent "Review library-sync cluster" completed',
    ms: 653,
    decision,
    kind: "notify",
  };

  test("the live line marks a notification turn, so a wake-up is not read as a reply to the person", () => {
    assert.equal(
      liveLine(notify),
      "> ✳️ `fable` · xhigh · 97% · notify · 653ms",
    );
  });

  test("the history tags it and shows the summary, not the envelope", () => {
    assert.match(
      statusReport({ ...base, attempts: [notify] }),
      /fable·xhigh 0\.97 {2}\[notify\] Agent "Review library-sync cluster" complet/,
    );
  });

  test("the footer’s jev row carries the tag", () => {
    addUsage(notify, {
      model: "claude-fable-5-1",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    });
    assert.match(
      usageFooter(notify)!,
      /jev {2}fable·xhigh · 97% · notify · 653ms/,
    );
  });

  test("a subagent’s steps are listed as unrouted, under the agent’s name", () => {
    const sub: Attempt = {
      prompt: "Review library-sync cluster",
      ms: 0,
      skipped: "subagent runs on the session model",
      kind: "agent",
      agent: { type: "Explore", label: "Review library-sync cluster" },
    };
    addUsage(sub, {
      model: "claude-opus-5-5,
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const text = statusReport({ ...base, attempts: [sub] });
    assert.match(
      text,
      /unrouted — \[agent:Explore\] Review library-sync cluster/,
    );
    assert.match(text, /answered claude-opus-5-5{2}cache 0%/);
  });
});

describe("a held turn", () => {
  const held: Attempt = {
    prompt: "rename the variable",
    ms: 512,
    decision: {
      tier: "fable",
      model: "claude-fable-5-1",
      effort: "low",
      confidence: 0.61,
      held: "haiku",
    },
  };

  test("the line says what Jev wanted and did not get", () => {
    assert.equal(
      liveLine(held),
      "> ✳️ `fable` · low · 61% · held:haiku · 512ms",
    );
  });

  test("the history says so too, so a run of holds is visible", () => {
    assert.match(
      statusReport({ ...base, attempts: [held] }),
      /fable·low 0\.61 held:haiku {2}rename/,
    );
  });

  test("the footer carries it", () => {
    addUsage(held, {
      model: "claude-fable-5-1",
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 0,
    });
    assert.match(
      usageFooter(held)!,
      /jev {2}fable·low · 61% · held:haiku · 512ms/,
    );
  });

  test("a held turn is not marked low-confidence twice over", () => {
    const line = liveLine(held);
    assert.doesNotMatch(line, /\?/);
  });

  test("the status report says whether stickiness is on", () => {
    assert.match(statusReport(base), /sticky\s+off/);
    assert.match(
      statusReport({ ...base, sticky: 0.75 }),
      /sticky\s+on, switch needs 75%/,
    );
  });
});

describe("the sticky subcommand", () => {
  test("bare turns it on at the default bar", () => {
    const r = stickyCommand("", null);
    assert.equal(r.sticky, DEFAULT_STICKY_CONFIDENCE);
    assert.match(r.text, /75%/);
  });

  test("bare keeps a bar already set rather than resetting it", () => {
    assert.equal(stickyCommand("", 0.6).sticky, 0.6);
    assert.equal(stickyCommand("on", 0.6).sticky, 0.6);
  });

  test("off turns it off", () => {
    const r = stickyCommand("off", 0.6);
    assert.equal(r.sticky, null);
    assert.match(r.text, /freely/);
  });

  test("a number sets the bar and turns it on", () => {
    assert.equal(stickyCommand("0.6", null).sticky, 0.6);
    assert.equal(
      stickyCommand("60", null).sticky,
      0.6,
      "a percentage is read as one",
    );
    assert.equal(
      stickyCommand("60%", null).sticky,
      0.6,
      "and so is one with a sign",
    );
  });

  test("a bar outside the range is refused, and nothing changes", () => {
    for (const bad of ["0", "1", "100", "-2", "nonsense"]) {
      const r = stickyCommand(bad, 0.6);
      assert.equal(r.sticky, 0.6, bad);
      assert.match(r.text, /between/, bad);
    }
  });

  test("the reply says how to undo it, since the state is invisible otherwise", () => {
    assert.match(stickyCommand("", null).text, /\/jev sticky off/);
    assert.match(stickyCommand("off", 0.6).text, /\/jev sticky/);
  });
});
