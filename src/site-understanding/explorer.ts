/** Bounded observation loop. Browser and agent adapters are injected so policy remains testable. */
import type { Observation } from "../model/schema.js";
import type { ExplorationBudget } from "./budgets.js";
import { getStopReason, rankFrontier, type ExplorationState, type FrontierCandidate, type FrontierDecision } from "./frontier.js";
import { normalizeUrl } from "./url-rules.js";

export interface ObservationCandidate extends FrontierCandidate { origin: string; score?: number; }
export interface ExplorerAdapter {
  observe(candidate: ObservationCandidate): Promise<Observation>;
  discover?(observation: Observation): Promise<ObservationCandidate[]> | ObservationCandidate[];
  rank?(observations: Observation[], candidates: ObservationCandidate[]): Promise<ObservationCandidate[]>;
  /** Optional interaction hook; the controller still enforces the interaction budget. */
  interact?(observation: Observation, remainingInteractions: number): Promise<number>;
}
export interface ExplorerResult {
  observations: Observation[];
  selected: Array<{ url: string; reason: string; score: number; factors: Omit<FrontierCandidate, "url" | "reason"> }>;
  unvisited: Array<{ url: string; reason: string }>;
  stopReason: string;
}

/** Bound one browser observation by the remaining run time and release its timer. */
async function observeWithinBudget(adapter: ExplorerAdapter, candidate: ObservationCandidate, remainingMs: number): Promise<Observation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.observe(candidate),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Observation exceeded the remaining time budget.")), Math.max(1, remainingMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Explore representative candidates until a finite policy limit or value threshold is reached. */
export async function explore(adapter: ExplorerAdapter, candidates: ObservationCandidate[], budget: ExplorationBudget, startedAt = Date.now(), threshold = 0): Promise<ExplorerResult> {
  const state: ExplorationState = { pagesVisited: 0, interactionsUsed: 0, startedAt, originsVisited: new Set() };
  // URL normalization collapses tracking variants before they compete for a
  // page slot; keep the first reason so reports remain tied to their source.
  const initialByUrl = new Map<string, ObservationCandidate>();
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    if (!initialByUrl.has(url)) initialByUrl.set(url, { ...candidate, url, origin: new URL(url).origin });
  }
  const remaining = [...initialByUrl.values()];
  const visited = new Set<string>();
  const observations: Observation[] = [];
  const selected: ExplorerResult["selected"] = [];
  let stopReason = "frontier-exhausted";
  while (remaining.length) {
    const ranked = await getRankedFrontier(adapter, observations, remaining);
    let originBlocked = false;
    let next: FrontierDecision | undefined;
    for (const candidate of ranked) {
      if ((candidate.score ?? 0) < threshold) continue;
      const normalizedUrl = normalizeUrl(candidate.url);
      if (visited.has(normalizedUrl)) continue;
      const candidateOrigin = new URL(normalizedUrl).origin;
      const stop = getStopReason(state, budget, Date.now(), candidateOrigin);
      if (stop && stop !== "origin-budget") { stopReason = stop; break; }
      if (stop === "origin-budget") { originBlocked = true; continue; }
      next = candidate;
      break;
    }
    if (!next) {
      if (stopReason !== "frontier-exhausted") break;
      stopReason = originBlocked ? "origin-budget" : ranked.length ? "below-value-threshold" : "frontier-exhausted";
      break;
    }
    const origin = new URL(next.url).origin;
    const candidateIndex = remaining.findIndex((item) => normalizeUrl(item.url) === normalizeUrl(next!.url));
    const candidate = remaining.splice(candidateIndex, 1)[0]!;
    visited.add(normalizeUrl(candidate.url));
    selected.push({
      url: candidate.url,
      reason: next.reason,
      score: next.score ?? 0,
      factors: {
        novelty: next.novelty,
        uncoveredFunctionality: next.uncoveredFunctionality,
        uncertaintyReduction: next.uncertaintyReduction,
        cost: next.cost,
        accessRisk: next.accessRisk,
      },
    });
    // Count an origin when navigation is attempted, including a blocked response.
    state.originsVisited.add(origin);
    try {
      const remainingMs = budget.maxDurationSeconds * 1_000 - (Date.now() - startedAt);
      const observation = await observeWithinBudget(adapter, candidate, remainingMs);
      observations.push(observation);
      state.pagesVisited += 1;
      if (adapter.discover && observation.status === "observed") {
        for (const discovered of await adapter.discover(observation)) {
          const normalized = normalizeUrl(discovered.url);
          if (!visited.has(normalized) && !remaining.some((item) => normalizeUrl(item.url) === normalized)) remaining.push({ ...discovered, url: normalized, origin: new URL(normalized).origin });
        }
      }
      if (adapter.interact && state.interactionsUsed < budget.maxInteractions) {
        const used = await adapter.interact(observation, budget.maxInteractions - state.interactionsUsed);
        state.interactionsUsed += Math.max(0, Math.min(used, budget.maxInteractions - state.interactionsUsed));
      }
    } catch (error) {
      observations.push({ id: `failed-${state.pagesVisited + 1}`, url: candidate.url, capturedAt: new Date().toISOString(), status: "failed", title: "", visibleText: "", domStructure: "", accessibleNodes: [], structureFingerprint: "failed", controls: [], blockedReason: error instanceof Error ? error.message : String(error) });
      state.pagesVisited += 1;
      if (/remaining time budget/.test(error instanceof Error ? error.message : String(error))) {
        stopReason = "time-budget";
        break;
      }
    }
  }
  if (!remaining.some((candidate) => !visited.has(normalizeUrl(candidate.url))) && stopReason === "frontier-exhausted") stopReason = "frontier-exhausted";
  return { observations, selected, unvisited: remaining.filter((candidate) => !visited.has(normalizeUrl(candidate.url))).map((candidate) => ({ url: candidate.url, reason: candidate.reason })), stopReason };
}

/**
 * Ask the optional local agent to reorder known candidates, then validate the
 * result against the deterministic frontier. The agent may not invent URLs,
 * drop candidates from coverage accounting, or provide invalid score factors.
 */
async function getRankedFrontier(adapter: ExplorerAdapter, observations: Observation[], remaining: ObservationCandidate[]): Promise<FrontierDecision[]> {
  if (!adapter.rank) return rankFrontier(remaining);

  const proposed = await adapter.rank(observations, remaining);
  const known = new Map(remaining.map((candidate) => [normalizeUrl(candidate.url), candidate]));
  const seen = new Set<string>();
  const ranked: FrontierDecision[] = [];
  for (const item of proposed) {
    let url: string;
    try { url = normalizeUrl(item.url); } catch { continue; }
    const original = known.get(url);
    if (!original || seen.has(url)) continue;
    const factors = [item.novelty, item.uncoveredFunctionality, item.uncertaintyReduction, item.cost, item.accessRisk];
    if (!factors.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) continue;
    const decision = rankFrontier([{ ...original, ...item, url }])[0]!;
    ranked.push(decision);
    seen.add(url);
  }

  // A malformed or partial agent response must never make candidates disappear
  // from exploration; append omitted candidates using the reproducible policy.
  for (const decision of rankFrontier(remaining)) {
    if (!seen.has(normalizeUrl(decision.url))) ranked.push(decision);
  }
  return ranked;
}
