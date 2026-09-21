import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_STICKY_CONFIDENCE,
  decisionOf,
  effortOf,
  excludedTiers,
  MODEL_OF,
  offeredTiers,
  stickyDecision,
  stickyOf,
  thresholdOf,
  TIERS,
  type Decision,
  type Effort,
} from "../hooks/policy.ts";

const choice = (name: string, confidence = 0.9) => ({
  tier: { type: "choice", choice: name, confidence },
  effort: { type: "score", score: 2 },
});

describe("policy", () => {
  test("a tier Jev picked becomes that tier’s model id", () => {
    const d = decisionOf(choice("fable"));
    assert.equal(d?.tier, "fable");
    assert.equal(d?.model, "claude-fable-5-1");
  });

  test("every tier maps to a model id the engine knows", () => {
    for (const tier of TIERS) {
      assert.match(MODEL_OF[tier], /^claude-(haiku|sonnet|opus|fable)-/);
    }
  });

  test("a score rounds to the nearest effort level", () => {
    assert.equal(effortOf(0), "low");
    assert.equal(effortOf(2.4), "high");
    assert.equal(effortOf(2.6), "xhigh");
    assert.equal(effortOf(4), "max");
  });

  test("a score outside the ladder clamps instead of throwing", () => {
    assert.equal(effortOf(-3), "low");
    assert.equal(effortOf(99), "max");
  });

  test("a missing or unusable score falls back to medium", () => {
    assert.equal(effortOf(undefined), "medium");
    assert.equal(effortOf(Number.NaN), "medium");
    assert.equal(effortOf("high"), "medium");
  });

  test("a tier that was not offered is refused", () => {
    const offered = offeredTiers(excludedTiers("fable"));
    assert.equal(decisionOf(choice("fable"), offered), null);
    assert.equal(decisionOf(choice("opus"), offered)?.tier, "opus");
  });

  test("excluding every tier falls back to the full ladder", () => {
    const offered = offeredTiers(excludedTiers("haiku,sonnet,opus,fable"));
    assert.deepEqual(offered, [...TIERS]);
  });

  test("an unknown name in the exclude list is ignored", () => {
    assert.deepEqual([...excludedTiers("fable, nonsense")], ["fable"]);
    assert.deepEqual([...excludedTiers(undefined)], []);
  });

  test("malformed answers give no decision rather than a wrong one", () => {
    assert.equal(decisionOf(null), null);
    assert.equal(decisionOf({}), null);
    assert.equal(decisionOf({ tier: { type: "score", score: 1 } }), null);
    assert.equal(decisionOf({ tier: { type: "choice" } }), null);
    assert.equal(
      decisionOf({ tier: { type: "choice", choice: "gpt-5" } }),
      null,
    );
  });

  test("a missing confidence reads as no confidence, not as certainty", () => {
    const d = decisionOf({ tier: { type: "choice", choice: "opus" } });
    assert.equal(d?.confidence, 0);
  });
});

describe("sticky routing", () => {
  const at = (
    tier: string,
    effort: Effort = "high",
    confidence = 0.9,
  ): Decision => ({
    tier: tier as Decision["tier"],
    model: MODEL_OF[tier as Decision["tier"]],
    effort,
    confidence,
  });

  test("off by default, so a session routes as it always has", () => {
    assert.equal(stickyOf(undefined), false);
    assert.equal(stickyOf(""), false);
    assert.equal(stickyOf("0"), false);
    assert.equal(stickyOf("false"), false);
  });

  test("the flag is set the ways people actually set flags", () => {
    for (const on of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      assert.equal(stickyOf(on), true, on);
    }
  });

  test("the bar has a default and takes one from the environment", () => {
    assert.equal(thresholdOf(undefined), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("0.6"), 0.6);
    assert.equal(thresholdOf("60"), 0.6, "a percentage is read as one");
  });

  test("an unusable bar falls back rather than pinning every turn", () => {
    assert.equal(thresholdOf("nonsense"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("-1"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("0"), DEFAULT_STICKY_CONFIDENCE);
    assert.equal(thresholdOf("101"), DEFAULT_STICKY_CONFIDENCE);
  });

  test("the first turn of a session has nothing to hold to", () => {
    const d = stickyDecision(at("haiku", "low", 0.2), null, 0.75);
    assert.equal(d.tier, "haiku");
    assert.equal(d.held, undefined);
  });

  test("a shaky switch is held on the previous tier", () => {
    const d = stickyDecision(at("haiku", "low", 0.6), at("fable"), 0.75);
    assert.equal(d.tier, "fable");
    assert.equal(d.model, MODEL_OF.fable);
    assert.equal(
      d.held,
      "haiku",
      "what Jev wanted is kept, for the route line",
    );
  });

  test("a confident switch goes through", () => {
    const d = stickyDecision(at("haiku", "low", 0.8), at("fable"), 0.75);
    assert.equal(d.tier, "haiku");
    assert.equal(d.held, undefined);
  });

  test("confidence exactly at the bar switches, so the bar is a minimum", () => {
    assert.equal(
      stickyDecision(at("haiku", "low", 0.75), at("fable"), 0.75).tier,
      "haiku",
    );
  });

  test("effort still moves on a held turn, since it costs no cache", () => {
    const d = stickyDecision(at("haiku", "low", 0.6), at("fable", "max"), 0.75);
    assert.equal(d.tier, "fable");
    assert.equal(d.effort, "low", "the new effort, on the old model");
  });

  test("the confidence kept is Jev’s own, not the one it cleared", () => {
    assert.equal(
      stickyDecision(at("haiku", "low", 0.6), at("fable"), 0.75).confidence,
      0.6,
    );
  });

  test("staying on the same tier is never a hold, however shaky", () => {
    const d = stickyDecision(at("fable", "low", 0.1), at("fable", "max"), 0.75);
    assert.equal(d.tier, "fable");
    assert.equal(d.effort, "low");
    assert.equal(d.held, undefined);
  });
});
