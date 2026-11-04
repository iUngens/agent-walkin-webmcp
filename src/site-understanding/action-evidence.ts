/** Build evidence-backed action locators from controls captured by the observer. */
import { EvidenceSchema, type Evidence, type LocatorCandidate, type Observation } from "../model/schema.js";

/** Convert observed controls into stable evidence records without reading values. */
export function evidenceFromObservations(observations: Observation[]): Evidence[] {
  return observations.flatMap((observation) => observation.controls.flatMap((control, index) => {
    const summary = `${control.kind}${control.accessibleName ? `: ${control.accessibleName}` : control.text ? `: ${control.text}` : ""}`;
    return EvidenceSchema.parse({
      id: `evidence-${observation.id}-${index + 1}`,
      observationId: observation.id,
      url: observation.url,
      kind: control.kind === "form" ? "form" : control.kind === "link" || control.kind === "button" || control.kind === "input" || control.kind === "select" || control.kind === "textarea" ? "accessible-control" : "dom-context",
      summary,
      locator: { role: control.accessibleRole, name: control.accessibleName, label: control.label, selector: control.selector, uniqueInObservation: control.uniqueInObservation, attributes: { ...(control.inputType ? { type: control.inputType } : {}), ...(control.name ? { name: control.name } : {}) } },
    });
  }));
}

/** Select locator strategies only when the browser capture proved selector uniqueness. */
export function locatorCandidatesForEvidence(evidence: Evidence[], wantedEvidenceIds: string[]): LocatorCandidate[] {
  const wanted = new Set(wantedEvidenceIds);
  return evidence.filter((item) => wanted.has(item.id) && item.locator?.selector && item.locator.uniqueInObservation === true).map((item) => ({
    strategy: item.locator?.role && item.locator?.name ? "role-name" as const : item.locator?.label ? "label" as const : item.locator?.selector?.startsWith("#") ? "id" as const : "stable-attribute" as const,
    selector: item.locator!.selector!,
    ...(item.locator?.role ? { role: item.locator.role } : {}),
    ...(item.locator?.name ? { name: item.locator.name } : {}),
    evidenceId: item.id,
    // This records a capture-time fact. Runtime still checks that the selector
    // resolves on the current page and fails closed if the page has changed.
    uniqueInObservation: true,
  }));
}

/**
 * Attach evidence-backed locators to reviewed actions and leave ambiguous
 * actions unresolved. This is the gate between agent suggestions and runtime
 * executable tools.
 */
export function resolveActionEvidence<T extends { targetEvidenceIds: string[]; locators: LocatorCandidate[]; status: string }>(
  actions: T[], evidence: Evidence[],
): T[] {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  return actions.map((action) => {
    const locators = action.locators.length ? action.locators : locatorCandidatesForEvidence(evidence, action.targetEvidenceIds);
    const valid = action.targetEvidenceIds.length > 0
      && action.targetEvidenceIds.every((id) => evidenceById.has(id))
      && locators.length > 0
      && locators.every((locator) => action.targetEvidenceIds.includes(locator.evidenceId) && locator.uniqueInObservation);
    return { ...action, locators, status: action.status === "unresolved" || !valid ? "unresolved" : valid && ["approved", "validated"].includes(action.status) ? action.status : "review-required" };
  });
}
