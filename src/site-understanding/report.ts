/** Human-readable and machine-readable review report for merchant approval. */
import type { SiteModel } from "../model/schema.js";

/** Render the evidence, uncertainty, coverage, and deferred boundaries for review outside the tool. */
export function renderSiteUnderstandingReport(model: SiteModel): string {
  const lines = [
    `# Site understanding: ${model.site.siteId}`,
    "",
    `- Merchant origin: ${model.site.merchantOrigin}`,
    `- Status: ${model.exploration.status}`,
    `- Coverage estimate: ${(model.exploration.estimatedCoverage * 100).toFixed(1)}% (observed pages: ${model.exploration.visitedCount})`,
    `- Stop reason: ${model.exploration.stopReason}`,
    `- Authentication: ${model.exploration.authenticationDeferred ? "deferred" : "unexpectedly enabled"}`,
    "",
    "## Page families",
  ];
  for (const family of model.pageFamilies) lines.push(`- **${family.label}** \`${family.pathPattern}\` (${family.status}, confidence ${family.confidence.toFixed(2)}); examples: ${family.examples.join(", ")}`);
  lines.push("", "## Candidate actions");
  for (const action of model.actions) lines.push(`- **${action.name}** (${action.mode}, ${action.status}, confidence ${action.confidence.toFixed(2)}): ${action.description}; evidence: ${action.targetEvidenceIds.join(", ") || "none"}`);
  lines.push("", "## Unvisited frontier");
  for (const item of model.exploration.unvisitedFrontier) lines.push(`- ${item.url}: ${item.reason}`);
  lines.push("", "## Origin access");
  const attemptedOrigins = [...new Set(model.observations.map((item) => new URL(item.url).origin))].sort();
  lines.push(`- Understanding-stage origins allowed: ${model.site.understandingOrigins.join(", ") || "none"}`);
  lines.push(`- Origins with recorded observations: ${attemptedOrigins.join(", ") || "none"}`);
  lines.push(`- Runtime external origins: ${model.site.runtimeExternalOrigins.join(", ") || "none"}`);
  lines.push(`- Origins accepting additional query keys: ${model.site.relaxedQueryOrigins?.join(", ") || "none"}`);
  lines.push("- Query-key relaxation preserves reviewed path and required-query rules; it does not grant runtime access.");
  lines.push("", "## Limitations");
  for (const observation of model.observations.filter((item) => item.status === "blocked" || item.status === "failed" || item.status === "deferred-auth")) lines.push(`- ${observation.url}: ${observation.status}${observation.blockedReason ? ` (${observation.blockedReason})` : ""}`);
  return `${lines.join("\n")}\n`;
}

/** Package review report that never calls unresolved actions publishable. */
export function renderPackageReview(model: SiteModel): string {
  const lines = [
    `# Package review: ${model.site.siteId}`,
    "",
    `- Merchant origin: ${model.site.merchantOrigin}`,
    `- Runtime external origins: ${model.site.runtimeExternalOrigins.join(", ") || "none"}`,
    "- Tool readiness requires approval, passing validation, evidence-backed targets, and unique observed locators.",
    "",
    "## Tools",
    "",
  ];
  const evidenceIds = new Set(model.evidence.map((item) => item.id));
  const passedValidationIds = new Set(model.validations.filter((item) => item.status === "passed").map((item) => item.toolId));
  for (const action of model.actions) {
    const ready = ["approved", "validated"].includes(action.status)
      && passedValidationIds.has(action.id)
      && action.targetEvidenceIds.length > 0
      && action.targetEvidenceIds.every((id) => evidenceIds.has(id))
      && (action.locators ?? []).length > 0
      && (action.locators ?? []).every((locator) => evidenceIds.has(locator.evidenceId) && locator.uniqueInObservation);
    const validation = model.validations.find((result) => result.toolId === action.id);
    const issues = [
      !["approved", "validated"].includes(action.status) ? `approval status is ${action.status}` : undefined,
      validation?.status !== "passed" ? `validation is ${validation?.status ?? "not-run"}` : undefined,
      action.targetEvidenceIds.some((id) => !evidenceIds.has(id)) ? "one or more evidence references are missing" : undefined,
      (action.locators ?? []).length === 0 ? "no target locators are recorded" : undefined,
      (action.locators ?? []).some((locator) => !evidenceIds.has(locator.evidenceId) || !locator.uniqueInObservation) ? "one or more locators lack unique observed evidence" : undefined,
    ].filter((issue): issue is string => Boolean(issue));
    lines.push(`### ${action.name}`, "", `- Readiness: ${ready ? "ready" : "held"}`, `- Mode: ${action.mode}`, `- Risk: ${action.risk}`, `- Description: ${action.description}`, `- Validation: ${validation?.status ?? "not-run"}${validation?.details ? ` (${validation.details})` : ""}`, `- Evidence: ${action.targetEvidenceIds.join(", ") || "none"}`, `- Unresolved limitations: ${issues.join("; ") || "none recorded"}`, "");
  }
  return `${lines.join("\n")}\n`;
}
