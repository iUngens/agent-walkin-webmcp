/** Observed page/state graph with structural deduplication and traceable transitions. */
import { normalizeUrl } from "./url-rules.js";
import type { Observation, Transition } from "../model/schema.js";
import type { PageFamily } from "../model/schema.js";

export interface GraphNode { key: string; observationIds: string[]; canonicalUrl: string; }

/**
 * Build a compact interaction signature from captured controls. The signature
 * keeps query values from merging states that expose different controls while
 * still allowing different product slugs with the same rendered structure to
 * share a graph node.
 */
function interactionShape(observation: Observation): string {
  return observation.controls
    .map((control) => [control.kind, control.accessibleRole ?? "", control.accessibleName ?? control.text, control.inputType ?? ""].join(":"))
    .sort()
    .join("|");
}

function pathSegments(input: string): string[] { return new URL(input).pathname.split("/").filter(Boolean); }

function likelyEntityValue(value: string): boolean { return value.length >= 12 || /\d/.test(value); }

/**
 * Match exact paths or paths differing only in entity-like segments. The graph
 * uses this conservative rule so arbitrary route names and single deep demo
 * paths are not generalized merely because their pages look alike.
 */
function sameRouteShape(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  if (leftUrl.origin !== rightUrl.origin) return false;
  const leftSegments = pathSegments(left);
  const rightSegments = pathSegments(right);
  if (leftSegments.length !== rightSegments.length) return false;
  return leftSegments.every((segment, index) => {
    const other = rightSegments[index]!;
    return segment === other || (likelyEntityValue(segment) && likelyEntityValue(other));
  });
}

/** Store observations by normalized URL and structure, keeping different UI states separate. */
export class ObservationGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly transitions: Transition[] = [];

  addObservation(observation: Observation): GraphNode {
    const parsed = new URL(normalizeUrl(observation.url));
    const queryKeys = [...parsed.searchParams.keys()].sort().join(",");
    const signature = `${parsed.origin}?${queryKeys}#${observation.structureFingerprint}:${interactionShape(observation)}`;
    const existing = [...this.nodes.values()].find((node) => {
      return node.key.startsWith(signature) && sameRouteShape(node.canonicalUrl, parsed.toString());
    });
    if (existing) {
      existing.observationIds.push(observation.id);
      return existing;
    }
    const key = `${signature}${parsed.pathname}`;
    const node = { key, observationIds: [observation.id], canonicalUrl: normalizeUrl(observation.url) };
    this.nodes.set(key, node);
    return node;
  }

  addTransition(transition: Transition): void { this.transitions.push(transition); }
}

/** Cluster observed nodes into conservative page families using route shape and structure. */
export function clusterPageFamilies(observations: Observation[], merchantOrigin: string, understandingOrigins: string[] = []): PageFamily[] {
  const structuralGroups = new Map<string, Observation[]>();
  const allowedOrigins = new Set([merchantOrigin, ...understandingOrigins].map((origin) => new URL(origin).origin));
  for (const observation of observations.filter((item) => item.status === "observed" && allowedOrigins.has(new URL(item.url).origin))) {
    const url = new URL(observation.url);
    const queryKeys = [...url.searchParams.keys()].sort();
    const segments = pathSegments(url.toString());
    const key = `${url.origin}|${segments.length}|${queryKeys.join(",")}|${observation.structureFingerprint}|${interactionShape(observation)}`;
    structuralGroups.set(key, [...(structuralGroups.get(key) ?? []), observation]);
  }
  const groups = new Map<string, Observation[]>();
  for (const members of structuralGroups.values()) {
    const paths = members.map((member) => pathSegments(member.url));
    const dynamicIndexes = new Set<number>();
    for (let index = 0; index < (paths[0]?.length ?? 0); index += 1) {
      const values = new Set(paths.map((parts) => parts[index]));
      // Generalize only when independent observations prove the segment varies;
      // a lone deep URL such as a demo route stays exact.
      if (values.size > 1 && [...values].every((value) => likelyEntityValue(value ?? ""))) dynamicIndexes.add(index);
    }
    for (const member of members) {
      const parts = pathSegments(member.url);
      const pattern = `/${parts.map((part, index) => dynamicIndexes.has(index) ? ":value" : part).join("/")}` || "/";
      const url = new URL(member.url);
      const queryKeys = [...url.searchParams.keys()].sort();
      const key = `${url.origin}${pattern}?${queryKeys.join(",")}#${member.structureFingerprint}:${interactionShape(member)}`;
      groups.set(key, [...(groups.get(key) ?? []), member]);
    }
  }
  return [...groups.entries()].map(([key, members], index) => {
    const [, fingerprint] = key.split("#");
    const representativeUrl = new URL(members[0]!.url);
    const origin = representativeUrl.origin;
    const pathPattern = key.slice(origin.length, key.indexOf("?"));
    const queryRules = Object.fromEntries([...representativeUrl.searchParams.keys()].sort().map((queryKey) => [queryKey, "optional" as const]));
    const id = `family-${index + 1}`;
    return {
      id,
      label: `Observed page family ${index + 1}`,
      origin,
      pathPattern: pathPattern || "/",
      queryRules,
      examples: members.map((member) => member.url),
      counterexamples: [],
      observationIds: members.map((member) => member.id),
      confidence: fingerprint ? Math.min(1, 0.65 + (members.length - 1) * 0.1) : 0.5,
      status: "proposed" as const,
    };
  });
}
