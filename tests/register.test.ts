import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { register } from "../hooks/register.ts";

/**
 * Drives the real `register` with a fake engine: captures the hooks it
 * registers, then runs turn.start and turn.step the way the engine would.
 */
function load(env: Record<string, string> = { AI_GATEWAY_API_KEY: "gw-key" }) {
  let listCalls = 0;
  const hooks = new Map<string, Function>();
  const on = (name: string, a: unknown, b?: unknown) => {
    const key = typeof a === "function" ? name : `${name}:${JSON.stringify(a)}`;
    hooks.set(key, (typeof a === "function" ? a : b) as Function);
    return { catch: () => {} };
  };
  register(on as never);

  let tier = "opus";
  let confidence = 0.91;
  let score = 2;
  let ok = true;

  const $ = {
    env: { get: async (k: string) => env[k] },
    clock: { sleep: () => new Promise<never>(() => {}) },
    http: {
      fetch: async () => {
        const good = ok;
        ok = true;
        return {
          ok: good,
          status: good ? 200 : 500,
          headers: {},
          text: JSON.stringify({
            answers: {
              tier: { type: "choice", choice: tier, confidence },
              effort: { type: "score", score },
            },
          }),
        };
      },
    },
    command: { register: async () => {} },
    session: { surface: async () => "test" },
    agent: {
      list: async () => {
        listCalls++;
        return [
          {
            id: "agent-1",
            type: "general-purpose",
            description: "Review library-sync cluster",
            status: "running",
          },
        ];
      },
    },
  };
  return {
    hooks,
    $,
    listCalls: () => listCalls,
    /** What Jev answers from the next turn on. */
    setTier: (name: string, c = 0.91, s = 2) => {
      tier = name;
      confidence = c;
      score = s;
    },
    /** Makes only the next Jev call fail, so that one turn goes unrouted. */
    fail: () => {
      ok = false;
    },
  };
}

async function* modelSays(...texts: string[]) {
  yield { kind: "engine", ref: 1 };
  for (const [i, text] of texts.entries())
    yield { kind: "text", index: 0, text, ref: i + 2 };
  yield { kind: "stop", stopReason: "end_turn", usage: null };
  return { stopReason: "end_turn" };
}

const usage = (model: string, input_tokens = 1000) => ({
  model,
  input_tokens,
  output_tokens: 50,
  cache_read_input_tokens: 9000,
  cache_creation_input_tokens: 0,
});

async function* answeredBy(
  model: string,
  stopReason = "end_turn",
  input_tokens = 1000,
) {
  yield { kind: "text", index: 0, text: "reply", ref: 1 };
  yield { kind: "stop", stopReason, usage: usage(model, input_tokens), ref: 2 };
  return { stopReason };
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("register: the route in the reply", () => {
  test("the first text chunk of a routed turn opens with the route line", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "implement it", turnId: "t1" },
      async (e: unknown) => e,
    );

    let sent: { model?: string; effort?: string } = {};
    const step = hooks.get("turn.step")!(
      $,
      { turnId: "t1", index: 0, model: "claude-fable-5-1" },
      (e: { model: string; effort: string }) => {
        sent = e;
        return modelSays("Hello", " there.");
      },
    );
    const chunks = await collect(step);
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);

    assert.equal(sent.model, "claude-opus-5-5");
    assert.equal(sent.effort, "high");
    // The latency is wall-clock, so it is matched loosely.
    assert.match(
      texts[0]!,
      /^> ✳️ `opus` · high · 91% · \d+ms\n\n---\n\nHello$/,
    );
    assert.equal(texts[1], " there.");
    assert.equal(
      chunks[0]!.kind,
      "engine",
      "engine chunks pass through untouched",
    );
  });

  test("the line is put in once per turn, not once per step", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t2" },
      async (e: unknown) => e,
    );
    const run = (index: number) =>
      collect(
        hooks.get("turn.step")!($, { turnId: "t2", index }, () =>
          modelSays("reply"),
        ),
      );

    const first = await run(0);
    const second = await run(1);
    assert.match(first.find((c) => c.kind === "text")!.text, /^> ✳️ `opus`/);
    assert.equal(second.find((c) => c.kind === "text")!.text, "reply");
  });

  test("an unrouted turn still says so at the top of its reply", async () => {
    const { hooks, $ } = load({});
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t3" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "t3", index: 0, model: "m" },
        (e: { model: string }) => {
          assert.equal(e.model, "m", "no decision, so the model is left alone");
          return modelSays("reply");
        },
      ),
    );
    assert.equal(
      chunks.find((c) => c.kind === "text")!.text,
      "> ⚠️ `unrouted` · no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY\n\n---\n\nreply",
    );
  });

  test("a step whose first chunks are not text waits for the text", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t4" },
      async (e: unknown) => e,
    );
    async function* thinkingFirst() {
      yield { kind: "thinking", index: 0, text: "hmm" };
      yield { kind: "text", index: 1, text: "answer" };
      yield { kind: "stop", stopReason: "end_turn", usage: null };
    }
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t4", index: 0 }, () =>
        thinkingFirst(),
      ),
    );
    assert.equal(chunks[0]!.text, "hmm", "thinking is not where the line goes");
    assert.match(chunks[1]!.text, /^> ✳️ `opus`.*\n\n---\n\nanswer$/);
  });

  test("/jev quiet keeps routing but drops the line", async () => {
    const { hooks, $ } = load();
    const cmd = hooks.get('command.run:{"command":"jev"}')!;
    await cmd($, { args: "quiet" });
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t5" },
      async (e: unknown) => e,
    );
    let sent: { model?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "t5", index: 0 },
        (e: { model: string }) => {
          sent = e;
          return modelSays("reply");
        },
      ),
    );
    assert.equal(sent.model, "claude-opus-5-5", "still routed");
    assert.equal(chunks.find((c) => c.kind === "text")!.text, "reply");
  });

  test("the stop chunk’s usage lands on the turn and /jev confirms what answered", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t6" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t6", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(
      chunks.at(-1)!.kind,
      "stop",
      "the stop chunk still reaches the engine",
    );

    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /claude-opus-5-5 ✓/);
    assert.match(out.text, /cache 90%/);
  });

  test("a turn of two steps sums both requests", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t7" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t7", index: 0 }, () =>
        answeredBy("claude-opus-5-5", "tool_use", 1000),
      ),
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t7", index: 1 }, () =>
        answeredBy("claude-opus-5-5", "end_turn", 3000),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /22k in/, out.text);
  });

  test("a different model answering than was asked for is flagged", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t8" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t8", index: 0 }, () =>
        answeredBy("claude-haiku-4-5"),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /claude-haiku-4-5 ≠ claude-opus-5/);
  });

  test("a stop chunk for a turn we never saw is left alone", async () => {
    const { hooks, $ } = load();
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "ghost", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(chunks.length, 2);
  });

  test("the footer closes a finished turn, after the reply text", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t9" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t9", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );

    const texts = chunks.filter((c) => c.kind === "text");
    const footer = texts.at(-1)!.text;
    assert.match(footer, /```\n─+\njev {2}opus·high/);
    assert.match(footer, /api {2}claude-opus-5-5 ✓/);
    assert.equal(
      chunks.at(-1)!.kind,
      "stop",
      "the footer goes before the stop chunk",
    );
    assert.equal(
      texts.at(-1)!.ref,
      undefined,
      "a chunk we made carries no engine handle",
    );

    // Load-bearing: the engine drops a chunk yielded at an index it already
    // streamed. One past the last text block opens a block of its own.
    const reply = texts.find((c) => c.ref !== undefined)!;
    assert.equal(texts.at(-1)!.index, reply.index + 1);
  });

  test("a step that only called a tool gets no footer, since the turn goes on", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t10" },
      async (e: unknown) => e,
    );
    const mid = await collect(
      hooks.get("turn.step")!($, { turnId: "t10", index: 0 }, () =>
        answeredBy("claude-opus-5-5", "tool_use"),
      ),
    );
    assert.doesNotMatch(
      mid
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      /jev {2}opus/,
    );

    const last = await collect(
      hooks.get("turn.step")!($, { turnId: "t10", index: 1 }, () =>
        answeredBy("claude-opus-5-5", "end_turn"),
      ),
    );
    assert.match(
      last.filter((c) => c.kind === "text").at(-1)!.text,
      /jev {2}opus·high/,
    );
  });

  test("the footer sums the whole turn, not just its last step", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t11" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "t11", index: 0 }, () =>
        answeredBy("claude-opus-5-5", "tool_use", 1000),
      ),
    );
    const last = await collect(
      hooks.get("turn.step")!($, { turnId: "t11", index: 1 }, () =>
        answeredBy("claude-opus-5-5", "end_turn", 3000),
      ),
    );
    assert.match(last.filter((c) => c.kind === "text").at(-1)!.text, /22k in/);
  });

  test("/jev quiet drops the footer with the line", async () => {
    const { hooks, $ } = load();
    await hooks.get('command.run:{"command":"jev"}')!($, { args: "quiet" });
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t12" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t12", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(
      chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      "reply",
    );
  });

  test("a turn whose response carried no usage ends without a footer", async () => {
    const { hooks, $ } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "t13" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "t13", index: 0 }, () =>
        modelSays("reply"),
      ),
    );
    assert.doesNotMatch(
      chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      /jev {2}opus/,
    );
  });

  test("a turn started by a task notification is tagged notify, in the line and the footer", async () => {
    const { hooks, $ } = load();
    const notice =
      '<task-notification><task-id>abc</task-id><summary>Agent "reviewer" completed</summary></task-notification>';
    await hooks.get("turn.start")!(
      $,
      { text: notice, turnId: "n1" },
      async (e: unknown) => e,
    );
    const chunks = await collect(
      hooks.get("turn.step")!($, { turnId: "n1", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    const texts = chunks.filter((c) => c.kind === "text").map((c) => c.text);
    assert.match(texts[0]!, /^> ✳️ `opus` · high · 91% · notify · 0ms/);
    assert.match(texts.at(-1)!, /jev {2}opus·high · 91% · notify · 0ms/);
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /\[notify\] Agent "reviewer" completed/);
  });

  test("a subagent’s step, which no turn.start announced, is recorded unrouted with what ran it", async () => {
    const { hooks, $, listCalls } = load();
    let sent: { model?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        {
          turnId: "sub1",
          index: 0,
          agentId: "agent-1",
          model: "claude-opus-5-5",
        },
        (e: { model: string }) => {
          sent = e;
          return answeredBy("claude-opus-5-5");
        },
      ),
    );
    assert.equal(sent.model, "claude-opus-5-5", "left on the session model");
    assert.equal(
      chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
      "reply",
      "nothing added to a tool result the parent will read",
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(
      out.text,
      /unrouted — \[agent:general-purpose\] Review library-sync cluster/,
    );
    assert.match(out.text, /answered claude-opus-5/);
    assert.equal(listCalls(), 1);
  });

  test("a subagent’s later steps add to the same record, and read the list once", async () => {
    const { hooks, $, listCalls } = load();
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "sub2", index: 0, agentId: "agent-1" },
        () => answeredBy("claude-opus-5-5", "tool_use", 1000),
      ),
    );
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "sub2", index: 1, agentId: "agent-1" },
        () => answeredBy("claude-opus-5-5", "end_turn", 3000),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.equal(out.text.match(/unrouted — \[agent/g)?.length, 1);
    assert.match(out.text, /22k in/);
    assert.equal(listCalls(), 1);
  });

  test("an agent the list does not know yet is still recorded, by its id", async () => {
    const { hooks, $ } = load();
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: "sub3", index: 0, agentId: "agent-unknown-xyz" },
        () => answeredBy("claude-opus-5-5"),
      ),
    );
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /unrouted — \[agent\] agent-unknown-xyz/);
  });

  test("a main-loop step never touches the agent list", async () => {
    const { hooks, $, listCalls } = load();
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: "s4" },
      async (e: unknown) => e,
    );
    await collect(
      hooks.get("turn.step")!($, { turnId: "s4", index: 0 }, () =>
        answeredBy("claude-opus-5-5"),
      ),
    );
    assert.equal(listCalls(), 0);
  });
});

describe("register: stickiness", () => {
  /**
   * A session whose env asks for stickiness, started: the env is read in
   * session.start, which the engine always fires and a test must too.
   */
  const sticky = async (over: Record<string, string> = {}) => {
    const kit = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      ...over,
    });
    await kit.hooks.get("session.start")!(kit.$, {}, async (e: unknown) => e);
    return kit;
  };

  /** Runs one turn end to end and says which model the request named. */
  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string; effort?: string } = {};
    const chunks = await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string }) => {
          sent = e;
          return answeredBy("claude-opus-5-5");
        },
      ),
    );
    return {
      sent,
      text: chunks
        .filter((c) => c.kind === "text")
        .map((c) => c.text)
        .join(""),
    };
  }

  test("with the flag off, a shaky switch still moves the model", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "a1");
    setTier("haiku", 0.4);
    const second = await turn(hooks, $, "a2");
    assert.equal(second.sent.model, "claude-haiku-4-5");
    assert.doesNotMatch(second.text, /held/);
  });

  test("with the flag on, a shaky switch is held on the last tier", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "b1");
    setTier("haiku", 0.4);
    const second = await turn(hooks, $, "b2");
    assert.equal(
      second.sent.model,
      "claude-opus-5-5",
      "held on the first turn’s tier",
    );
    assert.match(second.text, /held:haiku/);
  });

  test("a confident switch still goes through with the flag on", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "c1");
    setTier("haiku", 0.9);
    const second = await turn(hooks, $, "c2");
    assert.equal(second.sent.model, "claude-haiku-4-5");
  });

  test("the bar is read from the environment", async () => {
    const { hooks, $, setTier } = await sticky({
      JEV_ROUTER_STICKY_CONFIDENCE: "0.3",
    });
    await turn(hooks, $, "d1");
    setTier("haiku", 0.4);
    assert.equal(
      (await turn(hooks, $, "d2")).sent.model,
      "claude-haiku-4-5",
      "0.4 clears a 0.3 bar",
    );
  });

  test("effort moves on a held turn, since it keeps the same model", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "e1");
    setTier("haiku", 0.4, 0);
    const second = await turn(hooks, $, "e2");
    assert.equal(second.sent.model, "claude-opus-5-5");
    assert.equal(second.sent.effort, "low");
  });

  test("a held turn becomes the tier the next turn holds to", async () => {
    const { hooks, $, setTier } = await sticky();
    await turn(hooks, $, "f1");
    setTier("haiku", 0.4);
    await turn(hooks, $, "f2");
    const third = await turn(hooks, $, "f3");
    assert.equal(
      third.sent.model,
      "claude-opus-5-5",
      "still the tier that is actually running",
    );
  });

  test("an unrouted turn does not become something to hold to", async () => {
    const { hooks, $, setTier, fail } = await sticky();
    await turn(hooks, $, "g1");
    fail();
    await turn(hooks, $, "g2");
    setTier("haiku", 0.4);
    const third = await turn(hooks, $, "g3");
    assert.equal(
      third.sent.model,
      "claude-opus-5-5",
      "the last turn that actually ran",
    );
  });

  test("/jev says whether stickiness is on and what the bar is", async () => {
    const { hooks, $ } = await sticky({ JEV_ROUTER_STICKY_CONFIDENCE: "0.6" });
    const out = await hooks.get('command.run:{"command":"jev"}')!($, {
      args: "",
    });
    assert.match(out.text, /sticky\s+on, switch needs 60%/);
  });
});

describe("register: the sticky subcommand", () => {
  const run = (hooks: Map<string, Function>, $: unknown, args: string) =>
    hooks.get('command.run:{"command":"jev"}')!($, { args });

  async function turn(hooks: Map<string, Function>, $: unknown, id: string) {
    await hooks.get("turn.start")!(
      $,
      { text: "x", turnId: id },
      async (e: unknown) => e,
    );
    let sent: { model?: string } = {};
    await collect(
      hooks.get("turn.step")!(
        $,
        { turnId: id, index: 0 },
        (e: { model: string }) => {
          sent = e;
          return answeredBy("claude-opus-5-5");
        },
      ),
    );
    return sent;
  }

  test("/jev sticky turns it on for the session, with no env var set", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "h1");
    await run(hooks, $, "sticky");
    setTier("haiku", 0.4);
    assert.equal((await turn(hooks, $, "h2")).model, "claude-opus-5-5", "held");
  });

  test("/jev --sticky is the same command, since that is what people type", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "i1");
    await run(hooks, $, "--sticky");
    setTier("haiku", 0.4);
    assert.equal((await turn(hooks, $, "i2")).model, "claude-opus-5-5");
  });

  test("/jev sticky off turns it back off", async () => {
    const { hooks, $, setTier } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
    });
    await turn(hooks, $, "j1");
    await run(hooks, $, "sticky off");
    setTier("haiku", 0.4);
    assert.equal(
      (await turn(hooks, $, "j2")).model,
      "claude-haiku-4-5",
      "switched",
    );
  });

  test("/jev sticky 0.3 sets the bar for the session", async () => {
    const { hooks, $, setTier } = load();
    await turn(hooks, $, "k1");
    const out = await run(hooks, $, "sticky 0.3");
    assert.match(out.text, /30%/);
    setTier("haiku", 0.4);
    assert.equal(
      (await turn(hooks, $, "k2")).model,
      "claude-haiku-4-5",
      "0.4 clears a 0.3 bar",
    );
  });

  test("the env var is the session’s starting value, and the command overrides it", async () => {
    const { hooks, $ } = load({
      AI_GATEWAY_API_KEY: "gw-key",
      JEV_ROUTER_STICKY: "1",
      JEV_ROUTER_STICKY_CONFIDENCE: "0.9",
    });
    await hooks.get("session.start")!($, {}, async (e: unknown) => e);
    assert.match(
      (await run(hooks, $, "")).text,
      /sticky\s+on, switch needs 90%/,
    );
    await run(hooks, $, "sticky 0.5");
    assert.match(
      (await run(hooks, $, "")).text,
      /sticky\s+on, switch needs 50%/,
    );
  });

  test("a bar that makes no sense changes nothing and says so", async () => {
    const { hooks, $ } = load();
    await run(hooks, $, "sticky 0.5");
    const out = await run(hooks, $, "sticky 7000");
    assert.match(out.text, /between/);
    assert.match((await run(hooks, $, "")).text, /switch needs 50%/);
  });
});
