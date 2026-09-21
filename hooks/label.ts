/**
 * The footer label. `SessionMode` draws the strings it is handed, so this
 * file's only job is to turn a decision into one of them.
 */

import type { Decision } from "./policy.ts";

/** Below this, the pick is marked so a bad route is visible rather than silent. */
export const LOW_CONFIDENCE = 0.5;

/**
 * The label for the footer, or null to add nothing.
 *
 * Null rather than a placeholder before the first turn: a footer that says
 * nothing reads better than one that says the router has not run yet.
 */
export function labelOf(
  decision: Decision | null,
  enabled: boolean,
): string | null {
  if (!enabled) return "jev off";
  if (!decision) return null;

  const doubt = decision.confidence < LOW_CONFIDENCE ? "?" : "";
  return `jev → ${decision.tier}·${decision.effort}${doubt}`;
}

/** The modes array `SessionMode` should draw, with our label on the end. */
export function withLabel(
  modes: readonly string[],
  label: string | null,
): readonly string[] {
  if (label === null) return modes;
  if (modes.includes(label)) return modes;
  return [...modes, label];
}
