/** URL normalization and reviewed page-family matching; no inferred URL dimension is discarded. */
import type { PageFamily } from "../model/schema.js";

/** Parameters commonly added for analytics; business and search parameters are preserved. */
export const TRACKING_PARAMETERS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid",
]);

/**
 * Canonicalize a URL for deduplication by removing fragments and known tracking keys.
 * Unknown query keys remain because they may select products, filters, or site state.
 */
export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

/**
 * Match a URL against an explicit family rule. `:segment` matches one path segment;
 * `*` matches the remainder. Query rules can require presence, permit, or ignore a key.
 */
export function matchesPageFamily(input: string, family: PageFamily, relaxedQueryOrigins: string[] = []): boolean {
  const candidate = new URL(normalizeUrl(input));
  if (candidate.origin !== new URL(family.origin).origin) return false;

  const patternParts = family.pathPattern.split("/").filter(Boolean);
  const pathParts = candidate.pathname.split("/").filter(Boolean);
  let pathMatches = true;
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    if (expected === "*") break;
    const actual = pathParts[index];
    if (actual === undefined || (expected?.startsWith(":") !== true && expected !== actual)) {
      pathMatches = false;
      break;
    }
  }
  if (!pathMatches || (patternParts.at(-1) !== "*" && pathParts.length !== patternParts.length)) return false;

  for (const [key, rule] of Object.entries(family.queryRules)) {
    if (rule === "required" && !candidate.searchParams.has(key)) return false;
    if (rule === "ignored") candidate.searchParams.delete(key);
  }
  const mayRelaxQuery = relaxedQueryOrigins.some((origin) => new URL(origin).origin === candidate.origin);
  if (!mayRelaxQuery) {
    const constrainedKeys = new Set(Object.keys(family.queryRules).filter((key) => family.queryRules[key] !== "ignored"));
    for (const key of candidate.searchParams.keys()) if (!constrainedKeys.has(key)) return false;
  }
  return true;
}
