/**
 * Deterministic frontier ranking and budget accounting for representative site
 * exploration. AI may supply explanations, but this controller enforces limits.
 */
import type { ExplorationBudget } from "./budgets.js";

export interface FrontierCandidate {
  url: string;
  reason: string;
  novelty: number;
  uncoveredFunctionality: number;
  uncertaintyReduction: number;
  cost: number;
  accessRisk: number;
}

export interface FrontierDecision extends FrontierCandidate { score: number; }

export interface ExplorationState {
  pagesVisited: number;
  interactionsUsed: number;
  startedAt: number;
  originsVisited: Set<string>;
}

export type StopReason = "page-budget" | "interaction-budget" | "time-budget" | "origin-budget" | "frontier-exhausted" | "below-value-threshold";

/** Score a candidate using fixed weights so a run is reproducible and explainable. */
export function rankFrontier(candidates: FrontierCandidate[]): FrontierDecision[] {
  return candidates.map((candidate) => ({
    ...candidate,
    score: (candidate.novelty * 0.3) + (candidate.uncoveredFunctionality * 0.3)
      + (candidate.uncertaintyReduction * 0.25) - (candidate.cost * 0.1) - (candidate.accessRisk * 0.05),
  })).sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
}

/** Decide whether another observation is permitted and return a reason when it is not. */
export function getStopReason(state: ExplorationState, budget: ExplorationBudget, now = Date.now(), nextOrigin?: string, needsInteraction = false): StopReason | undefined {
  if (state.pagesVisited >= budget.maxPages) return "page-budget";
  if (needsInteraction && state.interactionsUsed >= budget.maxInteractions) return "interaction-budget";
  if (now - state.startedAt >= budget.maxDurationSeconds * 1_000) return "time-budget";
  if (nextOrigin && !state.originsVisited.has(nextOrigin) && state.originsVisited.size >= budget.maxOrigins) return "origin-budget";
  return undefined;
}

/** Return the next ranked candidate that satisfies the current origin and budget policy. */
export function selectNextFrontier(candidates: FrontierCandidate[], state: ExplorationState, budget: ExplorationBudget, threshold = 0): { decision?: FrontierDecision; stopReason?: StopReason } {
  const ranked = rankFrontier(candidates);
  let originBlocked = false;
  for (const decision of ranked) {
    const origin = new URL(decision.url).origin;
    const stop = getStopReason(state, budget, Date.now(), origin);
    if (stop && stop !== "origin-budget") return { stopReason: stop };
    if (stop === "origin-budget") {
      originBlocked = true;
      continue;
    }
    if (decision.score >= threshold) return { decision };
  }
  return { stopReason: originBlocked ? "origin-budget" : ranked.length ? "below-value-threshold" : "frontier-exhausted" };
}
