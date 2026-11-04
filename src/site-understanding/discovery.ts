/** Candidate URL discovery from rendered links/forms and optional robots/sitemap hints. */
import { sameOriginCandidates } from "./browser-observer.js";
import { normalizeUrl } from "./url-rules.js";
import type { Observation } from "../model/schema.js";

export interface DiscoveryResult { candidates: string[]; excluded: Array<{ url: string; reason: string }>; }

const AUTH_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|register|signup|sign-up|account|password|reset-password)(?:\/|$)/i;

/**
 * Keep discovery deliberately conservative: only HTTP(S) links on the merchant
 * origin or an explicit understanding-stage allowlist become candidates.
 */
export function discoverCandidates(observation: Observation, renderedLinks: string[], merchantOrigin: string, temporaryOrigins: string[] = [], hints: string[] = []): DiscoveryResult {
  if (observation.status !== "observed") {
    return {
      candidates: [],
      excluded: [...renderedLinks, ...hints].map((url) => ({ url, reason: `source observation is ${observation.status}; it cannot seed further exploration` })),
    };
  }
  const allowed = [merchantOrigin, ...temporaryOrigins];
  const formTargets = observation.controls.flatMap((control) => control.formAction ? [control.formAction] : []);
  const candidates = sameOriginCandidates(observation, [...renderedLinks, ...formTargets, ...hints], allowed)
    .map(normalizeUrl)
    .filter((url) => !isSitemapDocument(url))
    .filter((url) => !AUTH_PATH.test(new URL(url).pathname));
  const all = [...new Set([...renderedLinks, ...formTargets, ...hints])];
  const candidateSet = new Set(candidates);
  const excluded = all.filter((url) => {
    try { return !candidateSet.has(normalizeUrl(new URL(url, observation.url).toString())); }
    catch { return true; }
  }).map((url) => ({ url, reason: AUTH_PATH.test(safePath(url, observation.url))
    ? "authentication workflow is deferred"
    : isNonHttpLink(url, observation.url)
      ? "non-HTTP(S) link retained as evidence but excluded from navigation"
      : "origin is outside the understanding-stage allowlist" }));
  return { candidates: [...new Set(candidates)], excluded };
}

/** Sitemap files nominate URLs; they are not rendered pages to spend budget on. */
function isSitemapDocument(input: string): boolean {
  try {
    const pathname = new URL(input).pathname.toLowerCase();
    return pathname.endsWith(".xml") && pathname.includes("sitemap");
  } catch {
    return false;
  }
}

function safePath(input: string, base: string): string {
  try { return new URL(input, base).pathname; } catch { return input; }
}

/** Identify custom-scheme links without rejecting the page that contains them. */
function isNonHttpLink(input: string, base: string): boolean {
  try { return !["http:", "https:"].includes(new URL(input, base).protocol); }
  catch { return true; }
}

/**
 * Fetch bounded robots.txt and sitemap hints for a site. Hints nominate URLs;
 * they do not expand the caller's origin allowlist and every URL still passes
 * through `discoverCandidates` before it can enter an exploration frontier.
 */
export async function fetchSitemapHints(origin: string, options: { timeoutMs?: number; maxSitemaps?: number; maxUrls?: number } = {}): Promise<string[]> {
  const siteOrigin = new URL(origin).origin;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5_000, 100), 15_000);
  const maxSitemaps = Math.min(Math.max(options.maxSitemaps ?? 4, 0), 10);
  const maxUrls = Math.min(Math.max(options.maxUrls ?? 200, 0), 2_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sitemapUrls = new Set<string>([new URL("/sitemap.xml", siteOrigin).toString()]);
  try {
    const robots = await fetch(new URL("/robots.txt", siteOrigin), { signal: controller.signal, redirect: "manual" });
    if (robots.ok) {
      const body = (await robots.text()).slice(0, 256_000);
      for (const match of body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) {
        try { sitemapUrls.add(new URL(match[1]!).toString()); } catch { /* Ignore malformed hints. */ }
      }
    }
  } catch {
    // Sitemap hints are optional. Network errors are recorded by the crawl, not fatal here.
  }
  const result = new Set<string>();
  try {
    for (const sitemapUrl of [...sitemapUrls].slice(0, maxSitemaps)) {
      let parsed: URL;
      try { parsed = new URL(sitemapUrl); } catch { continue; }
      if (parsed.origin !== siteOrigin || !["http:", "https:"].includes(parsed.protocol)) continue;
      try {
        const response = await fetch(parsed, { signal: controller.signal, redirect: "manual" });
        if (!response.ok) continue;
        const xml = (await response.text()).slice(0, 2_000_000);
        for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gim)) {
          const rawUrl = match[1]!.trim().replaceAll("&amp;", "&");
          try {
            const url = new URL(rawUrl, sitemapUrl);
            if (url.origin === siteOrigin && ["http:", "https:"].includes(url.protocol)) result.add(normalizeUrl(url.toString()));
          } catch { /* Ignore malformed location entries. */ }
          if (result.size >= maxUrls) return [...result];
        }
      } catch {
        // A failing hint source must not prevent rendered-page exploration.
      }
    }
    return [...result];
  } finally {
    clearTimeout(timer);
  }
}
