/** Small helpers kept separate so CLI and future agent adapters can share trace formatting. */
import type { FrontierDecision } from "./frontier.js";

export function explainFrontierDecision(decision: FrontierDecision): string {
  return `Selected ${decision.url} (score ${decision.score.toFixed(3)}): ${decision.reason}; novelty=${decision.novelty}, functionality=${decision.uncoveredFunctionality}, uncertainty=${decision.uncertaintyReduction}, cost=${decision.cost}, risk=${decision.accessRisk}.`;
}
