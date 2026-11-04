/** Local Codex/agent reasoning boundary. Structured proposals remain hypotheses until reviewed. */
import { z } from "zod";
import type { CandidateAction, Evidence, Observation, PageFamily, SemanticSource } from "../model/schema.js";
import type { FrontierCandidate } from "./frontier.js";
import { normalizeUrl } from "./url-rules.js";

export const AgentProposalSchema = z.object({
  pageFamilies: z.array(z.object({ id: z.string(), label: z.string(), pathPattern: z.string(), confidence: z.number().min(0).max(1) })),
  actions: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), mode: z.enum(["read", "preview", "live-write"]), confidence: z.number().min(0).max(1), evidenceIds: z.array(z.string()), pageFamilyIds: z.array(z.string()).default([]) })),
  semanticSummaries: z.array(z.object({ pageFamilyId: z.string(), heading: z.string(), content: z.string(), sourceObservationIds: z.array(z.string()) })),
  nextFrontier: z.array(z.object({ url: z.string().url(), reason: z.string(), novelty: z.number().min(0).max(1), uncoveredFunctionality: z.number().min(0).max(1), uncertaintyReduction: z.number().min(0).max(1), cost: z.number().min(0).max(1), accessRisk: z.number().min(0).max(1) })),
});

export type AgentProposal = z.infer<typeof AgentProposalSchema>;

export interface ReasoningAdapter { propose(input: { observations: Observation[]; pageFamilies: PageFamily[]; frontier: FrontierCandidate[] }): Promise<unknown>; }

/** Compact the evidence sent to a local agent so ranking stays finite and auditable. */
export function buildReasoningInput(observations: Observation[], pageFamilies: PageFamily[], frontier: FrontierCandidate[]) {
  return {
    observations: observations.map((observation) => ({
      id: observation.id,
      url: observation.url,
      status: observation.status,
      title: observation.title,
      text: observation.visibleText.slice(0, 4_000),
      controls: observation.controls.slice(0, 80).map((control) => ({ kind: control.kind, text: control.text, role: control.accessibleRole, name: control.accessibleName, label: control.label, selector: control.selector, href: control.href })),
      structureFingerprint: observation.structureFingerprint,
    })),
    pageFamilies: pageFamilies.map(({ id, label, pathPattern, confidence, status }) => ({ id, label, pathPattern, confidence, status })),
    frontier: frontier.map(({ url, reason, novelty, uncoveredFunctionality, uncertaintyReduction, cost, accessRisk }) => ({ url, reason, novelty, uncoveredFunctionality, uncertaintyReduction, cost, accessRisk })),
  };
}

/**
 * Explain the local agent's bounded task and output contract beside the JSON
 * evidence bundle. This keeps model choice local to Codex and makes clear that
 * its output is a proposal, not merchant approval or executable code.
 */
export function renderAgentPrompt(inputPath: string): string {
  return [
    "# Local site-understanding agent task",
    "",
    `Read the evidence bundle at \`${inputPath}\` and return one JSON object matching the proposal shape below.`,
    "Use only observation IDs, page-family IDs, control evidence IDs, and frontier URLs present in the input.",
    "Do not invent routes, selectors, business rules, completed effects, or evidence. Mark uncertain actions with low confidence and explain uncertainty in the description.",
    "Page-family entries may relabel an existing family only. Candidate actions remain proposals for merchant review; never mark them approved or executable.",
    "Rank only the supplied frontier URLs. Keep each score factor between 0 and 1 and explain the ranking in `reason`.",
    "Semantic summaries must cite one or more observed page IDs and distinguish directly observed facts from interpretation.",
    "Return JSON only, without Markdown fences or surrounding commentary.",
    "",
    "The proposal keys are `pageFamilies`, `actions`, `semanticSummaries`, and `nextFrontier`; see `src/site-understanding/agent-reasoning.ts` for the exact schema.",
    "",
  ].join("\n");
}

/** Validate agent output and downgrade all proposed actions to review-required. */
export async function getAgentProposal(adapter: ReasoningAdapter, input: { observations: Observation[]; pageFamilies: PageFamily[]; frontier: FrontierCandidate[] }): Promise<AgentProposal> {
  return AgentProposalSchema.parse(await adapter.propose(input));
}

/** Check proposal references against this run so agent-generated identifiers cannot invent evidence. */
export function validateProposalReferences(proposal: AgentProposal, observations: Observation[], pageFamilies: PageFamily[], frontier: FrontierCandidate[] = []): { proposal: AgentProposal; issues: string[] } {
  const evidenceIds = new Set(observations.flatMap((observation) => observation.controls.map((_, index) => `evidence-${observation.id}-${index + 1}`)));
  const familyIds = new Set(pageFamilies.map((family) => family.id));
  const knownFrontier = new Set(frontier.map((candidate) => normalizeCandidateUrl(candidate.url)));
  const frontierUrls = new Set<string>();
  const issues: string[] = [];
  // The proposal may choose ordering and scores, but its candidates must come
  // from URLs the browser observer actually discovered for this run.
  const nextFrontier = proposal.nextFrontier.filter((item) => {
    const normalized = normalizeCandidateUrl(item.url);
    if (!knownFrontier.has(normalized)) {
      issues.push(`Frontier proposal ${item.url}: URL was not present in the observed frontier.`);
      return false;
    }
    if (frontierUrls.has(normalized)) {
      issues.push(`Frontier proposal ${item.url}: duplicate candidate URL.`);
      return false;
    }
    frontierUrls.add(normalized);
    return true;
  });
  const actions = proposal.actions.map((action) => {
    const missingEvidence = action.evidenceIds.filter((id) => !evidenceIds.has(id));
    const missingFamilies = action.pageFamilyIds.filter((id) => !familyIds.has(id));
    if (missingEvidence.length || missingFamilies.length) {
      issues.push(`Action ${action.id}: unknown evidence [${missingEvidence.join(", ")}] or page families [${missingFamilies.join(", ")}].`);
      return { ...action, confidence: Math.min(action.confidence, 0.25), evidenceIds: action.evidenceIds.filter((id) => evidenceIds.has(id)) };
    }
    return action;
  });
  const semanticSummaries = proposal.semanticSummaries.flatMap((summary) => {
    const unknownFamilies = !familyIds.has(summary.pageFamilyId);
    const validSources = summary.sourceObservationIds.filter((id) => observations.some((observation) => observation.id === id && observation.status === "observed"));
    if (unknownFamilies || validSources.length !== summary.sourceObservationIds.length || validSources.length === 0) {
      issues.push(`Semantic summary ${summary.heading}: unknown page family or missing observed source.`);
      return [];
    }
    return [{ ...summary, sourceObservationIds: validSources }];
  });
  const proposedPageFamilies = proposal.pageFamilies.filter((item) => {
    if (familyIds.has(item.id)) return true;
    issues.push(`Page-family proposal ${item.id}: no matching observed family exists.`);
    return false;
  });
  return { proposal: { ...proposal, actions, semanticSummaries, pageFamilies: proposedPageFamilies, nextFrontier }, issues };
}

/** Normalize candidate URLs with the same tracking and fragment rules as discovery. */
function normalizeCandidateUrl(input: string): string {
  try {
    return normalizeUrl(input);
  } catch {
    return input;
  }
}

/** Convert a validated proposal into candidate actions without manufacturing target evidence. */
export function proposalActions(proposal: AgentProposal, pageFamilyIds: string[]): CandidateAction[] {
  const knownFamilies = new Set(pageFamilyIds);
  return proposal.actions.map((action) => {
    // A model can mention an identifier that was valid in an earlier run or
    // simply invent one. Keep the candidate visible for review, but remove the
    // invalid target instead of allowing it to break SiteModel validation.
    const scopedFamilies = (action.pageFamilyIds.length ? action.pageFamilyIds : pageFamilyIds)
      .filter((id) => knownFamilies.has(id));
    const hasUnknownFamily = (action.pageFamilyIds.length ? action.pageFamilyIds : pageFamilyIds)
      .some((id) => !knownFamilies.has(id));
    const hasEvidence = action.evidenceIds.length > 0;
    return {
      id: action.id,
      name: action.name,
      description: action.description,
      pageFamilyIds: scopedFamilies.length ? scopedFamilies : pageFamilyIds,
      mode: action.mode,
      inputSchema: {},
      inputBindings: [],
      targetEvidenceIds: action.evidenceIds,
      locators: [],
      preconditions: [],
      postconditions: [],
      risk: action.mode === "live-write" ? "high" : action.mode === "preview" ? "medium" : "low",
      confidence: hasUnknownFamily ? Math.min(action.confidence, 0.25) : action.confidence,
      status: hasUnknownFamily ? "unresolved" : hasEvidence ? "review-required" : "hypothesis",
    };
  });
}

/** Turn agent summaries into source-linked semantic records without inventing URLs. */
export function proposalSemantics(proposal: AgentProposal, observations: Observation[], evidence: Evidence[]): SemanticSource[] {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const evidenceByObservation = new Map<string, string[]>();
  for (const item of evidence) evidenceByObservation.set(item.observationId, [...(evidenceByObservation.get(item.observationId) ?? []), item.id]);
  return proposal.semanticSummaries.flatMap((summary, index) => {
    const sources = summary.sourceObservationIds.map((id) => byId.get(id)).filter((item): item is Observation => Boolean(item));
    const evidenceIds = [...new Set(sources.flatMap((source) => evidenceByObservation.get(source.id) ?? []))];
    return sources.length === 0 || evidenceIds.length === 0 ? [] : [{
      id: `agent-semantic-${index + 1}`,
      pageFamilyId: summary.pageFamilyId,
      sourceUrl: sources[0]!.url,
      heading: summary.heading,
      content: summary.content,
      kind: "summary" as const,
      evidenceIds,
    }];
  });
}
