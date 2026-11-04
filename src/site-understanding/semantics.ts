/** Source-linked compact semantic document generation for agent consumption. */
import type { CandidateAction, PageFamily, SemanticSource } from "../model/schema.js";

/**
 * Generate one Markdown document per page family.
 *
 * The headings are intentionally explicit because a merchant or a local agent
 * must be able to tell what came directly from the browser, what was inferred
 * by the reasoning step, and what describes a proposed tool. Every section
 * carries its source URL and evidence identifiers.
 */
export function generateSemanticDocuments(families: PageFamily[], sources: SemanticSource[], actions: CandidateAction[], sourceUrls = new Map<string, string>()): Map<string, string> {
  const documents = new Map<string, string>();
  for (const family of families) {
    const familySources = sources.filter((item) => item.pageFamilyId === family.id && item.content.trim().length > 0);
    const familyActions = actions.filter((item) => item.pageFamilyIds.includes(family.id) && item.status !== "hypothesis" && item.description.trim().length > 0);
    // A family header alone is not useful semantic material. Omitting it also
    // prevents the compiler from exposing a lookup tool that can only return metadata.
    if (familySources.length === 0 && familyActions.length === 0) continue;
    const lines = [`# ${family.label}`, "", `URL pattern: \`${family.pathPattern}\``, `Confidence: ${family.confidence.toFixed(2)}`, ""];
    for (const source of familySources) {
      const kindLabel = source.kind === "observed-fact" ? "Observed fact" : source.kind === "summary" ? "Agent summary" : "Action semantics";
      lines.push(`## ${kindLabel}: ${source.heading}`, "", source.content.trim(), `\nSource: ${source.sourceUrl} (evidence: ${source.evidenceIds.join(", ")})`, "");
    }
    for (const action of familyActions) {
      const sourceUrl = action.targetEvidenceIds.map((id) => sourceUrls.get(id)).find(Boolean);
      lines.push(`## Action semantics: ${action.name}`, "", action.description, `- Mode: ${action.mode}`, `- Preconditions: ${action.preconditions.join("; ") || "none recorded"}`, `- Expected result: ${action.postconditions.join("; ") || "not confirmed"}`, `- Evidence: ${action.targetEvidenceIds.join(", ")}`, `- Source: ${sourceUrl ?? "source URL unavailable; review required"}`, "");
    }
    documents.set(family.id, `${lines.join("\n").trim()}\n`);
  }
  return documents;
}
