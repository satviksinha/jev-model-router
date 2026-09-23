/**
 * The routing policy: which tiers exist, what Jev is told each one is for,
 * and how Jev's answers become a model and an effort level.
 *
 * Nothing here touches the engine or the network, so it runs under plain
 * `node` in tests.
 */

export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Decision = {
  tier: Tier;
  model: string;
  effort: Effort;
  /** Jev's confidence in the tier, 0 to 1. The gateway rounds to 2 places. */
  confidence: number;
  /**
   * The tier Jev named, when stickiness kept the turn on the previous one
   * instead. Absent on a turn that went where Jev pointed. Kept so the route
   * line can say a hold happened; a hold nobody can see is indistinguishable
   * from a router that is not running.
   */
  held?: Tier;
};

export const TIERS: readonly Tier[] = ["haiku", "sonnet", "opus", "fable"];

export const EFFORTS: readonly Effort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Model ids as the engine names them. */
export const MODEL_OF: Record<Tier, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

/**
 * What Jev is told each tier is for. This is the policy: edit these lines to
 * change how the router behaves, and nothing else.
 */
export const TIER_CRITERIA: Record<Tier, string> = {
  haiku:
    "Trivial. A lookup, a rename, a yes or no question, reading one short file, " +
    "restating something already on screen.",
  sonnet:
    "Straightforward and minor. A small edit whose shape is already obvious from " +
    "the request, with no real decision to make.",
  opus:
    "Plain implementation carrying some complexity. Writing or changing real code, " +
    "possibly across a few files, where the approach is known but the work is not " +
    "mechanical.",
  fable:
    "High complexity needing higher-order reasoning. Planning, brainstorming, " +
    "architecture, systematic debugging, weighing trade-offs, research. Anything " +
    "where working out the approach is itself the hard part.",
};

/** Ordered low to high; the index Jev scores is the effort level. */
export const EFFORT_CRITERIA: readonly string[] = [
  "No thinking needed. The answer is immediate.",
  "A little thinking. One or two steps.",
  "Real thinking. Several steps, or a choice worth weighing.",
  "Hard thinking. Many interacting parts, or a subtle failure to chase down.",
  "As hard as it gets. Open-ended, ambiguous, or the cost of being wrong is high.",
];

/** Tiers dropped from the question entirely, lowercase, from the env var. */
export function excludedTiers(raw: string | undefined): Set<Tier> {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(
    names.filter((n): n is Tier => (TIERS as string[]).includes(n)),
  );
}

/** The tiers offered to Jev, in ladder order, never empty. */
export function offeredTiers(excluded: Set<Tier>): Tier[] {
  const kept = TIERS.filter((t) => !excluded.has(t));
  return kept.length > 0 ? [...kept] : [...TIERS];
}

type ChoiceAnswer = { type: "choice"; choice?: unknown; confidence?: unknown };
type ScoreAnswer = { type: "score"; score?: unknown; confidence?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Jev's score across EFFORT_CRITERIA to the nearest effort level. */
export function effortOf(score: unknown): Effort {
  if (typeof score !== "number" || !Number.isFinite(score)) return "medium";
  const i = Math.min(Math.max(Math.round(score), 0), EFFORTS.length - 1);
  return EFFORTS[i] ?? "medium";
}

/**
 * Turns the `answers` object of a Jev response into a decision.
 *
 * Returns null whenever the answer is missing, malformed, or names a tier
 * that was not offered: the caller then leaves the turn alone.
 */
export function decisionOf(
  answers: unknown,
  offered: readonly Tier[] = TIERS,
): Decision | null {
  if (!isRecord(answers)) return null;

  const tier = answers.tier as ChoiceAnswer | undefined;
  if (!isRecord(tier) || tier.type !== "choice") return null;

  const choice = tier.choice;
  if (typeof choice !== "string") return null;
  if (!offered.includes(choice as Tier)) return null;

  const effort = answers.effort as ScoreAnswer | undefined;
  const confidence =
    typeof tier.confidence === "number" && Number.isFinite(tier.confidence)
      ? tier.confidence
      : 0;

  return {
    tier: choice as Tier,
    model: MODEL_OF[choice as Tier],
    effort: effortOf(isRecord(effort) ? effort.score : undefined),
    confidence,
  };
}

/**
 * The confidence a switch must clear before the model moves, when stickiness
 * is on.
 *
 * The prompt cache is per model: a session cached under one tier is cold for
 * the next, so the turn that switches pays full input tokens. A router that
 * flips on a 51% hunch can pick the cheaper model every time and still cost
 * more. 0.75 is the starting point, not a measured optimum; retune it with
 * `npm run try-prompts`.
 */
export const DEFAULT_STICKY_CONFIDENCE = 0.75;

/** Whether stickiness is on. Off unless the env var says otherwise. */
export function stickyOf(raw: string | undefined): boolean {
  const flag = (raw ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

/**
 * The bar from the environment, or the default when it is unusable.
 *
 * A value above 1 is read as a percentage, since `JEV_ROUTER_STICKY_CONFIDENCE=80`
 * is the likelier intent than a bar no turn can ever clear. 0 and 1 are both
 * refused: one would hold every switch forever, the other would hold none,
 * and each is better said by leaving the flag off.
 */
export function thresholdOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STICKY_CONFIDENCE;
  const ratio = parsed > 1 ? parsed / 100 : parsed;
  if (ratio <= 0 || ratio >= 1) return DEFAULT_STICKY_CONFIDENCE;
  return ratio;
}

/**
 * Holds a shaky switch on the tier the last turn used.
 *
 * Only the model is held. The effort Jev asked for is applied either way,
 * because effort does not change the model and so costs no cache: a held
 * turn still gets to think harder or less hard than the one before it.
 *
 * `previous` is the tier the last routed turn ran on, or null on the first
 * turn of a session, which has nothing to hold to.
 */
export function stickyDecision(
  fresh: Decision,
  previous: Decision | null,
  threshold: number,
): Decision {
  if (previous === null) return fresh;
  if (fresh.tier === previous.tier) return fresh;
  if (fresh.confidence >= threshold) return fresh;
  return {
    tier: previous.tier,
    model: previous.model,
    effort: fresh.effort,
    confidence: fresh.confidence,
    held: fresh.tier,
  };
}
