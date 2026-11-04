/**
 * Captures rendered page evidence through Playwright. It records ordinary DOM,
 * accessible hints when exposed in markup, visible text, and controls; it never
 * reads WebMCP registrations or submits forms during passive observation.
 * Text limits count Unicode code points so persisted JSON cannot end with a
 * truncated half of a surrogate pair.
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { ObservationSchema, type Observation } from "../model/schema.js";

export interface ObserveOptions {
  /** Persist a screenshot alongside report artifacts when true. */
  screenshot?: boolean;
  /** Directory for screenshot files; only used when screenshot is enabled. */
  artifactDirectory?: string;
}

interface RenderedPageCapture {
  title: string;
  visibleText: string;
  controls: Array<{
    kind: string;
    text: string;
    accessibleRole?: string;
    accessibleName?: string;
    label?: string;
    selector?: string;
    uniqueInObservation?: boolean;
    href?: string;
    inputType?: string;
    name?: string;
    formAction?: string;
    passwordField: boolean;
  }>;
  structure: string;
  accessibleNodes: Array<{ role?: string; name?: string; selector?: string }>;
  loginLike: boolean;
  challengeReason?: string;
  links: string[];
}

/**
 * Page-side capture script kept as a literal so the Node/tsx compiler cannot
 * inject helper calls such as `__name` into the browser execution context.
 * It only inspects rendered markup and never reads WebMCP registrations.
 */
const RENDERED_PAGE_CAPTURE_SCRIPT = String.raw`(() => {
  function truncate(text, limit) {
    return Array.from(text).slice(0, limit).join("");
  }
  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }
  function text(element) {
    return truncate((element.textContent || "").replace(/\s+/g, " ").trim(), 500);
  }
  const controls = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,form"))
    .filter(visible)
    .map(function (element) {
      const tag = element.tagName.toLowerCase();
      const kind = tag === "a" ? "link" : tag === "button" ? "button" : tag === "form" ? "form" : tag;
      const input = element;
      const label = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
        ? ((element.labels && element.labels[0] ? element.labels[0].textContent : "") || "").trim() || undefined : undefined;
      const href = element instanceof HTMLAnchorElement && /^https?:$/.test(new URL(element.href).protocol) ? element.href : undefined;
      const formAction = element instanceof HTMLFormElement && /^https?:$/.test(new URL(element.action).protocol) ? element.action : undefined;
      const role = element.getAttribute("role") || (tag === "a" ? "link" : tag === "button" ? "button" : tag === "form" ? "form" : undefined);
      const stableAttribute = Array.from(element.attributes).find(function (attribute) { return /^(data-testid|data-test|name)$/.test(attribute.name); });
      const selector = element.id ? "#" + CSS.escape(element.id) : stableAttribute ? "[" + stableAttribute.name + "=\"" + CSS.escape(stableAttribute.value) + "\"]" : undefined;
      let uniqueInObservation = false;
      if (selector) {
        try { uniqueInObservation = document.querySelectorAll(selector).length === 1; } catch (_) { uniqueInObservation = false; }
      }
      return {
        kind,
        text: text(element),
        accessibleRole: role,
        accessibleName: element.getAttribute("aria-label") || label || (text(element) || undefined),
        label,
        selector,
        uniqueInObservation,
        href,
        inputType: tag === "input" ? input.type : undefined,
        name: "name" in element && typeof element.name === "string" ? element.name : undefined,
        formAction,
        passwordField: tag === "input" && input.type === "password"
      };
    });
  const visibleText = truncate(document.body && document.body.innerText || "", 20000);
  // Challenge detection must be based on recognizable challenge copy or
  // provider markers. A generic title alone can occur on ordinary pages.
  // A provider can render a nearly empty challenge shell with only a generic
  // title. Require a recognizable marker in that case so an ordinary page
  // whose marketing title happens to be "Just a moment..." remains usable.
  const challengeCopy = /enable javascript and cookies to continue|checking your browser|verify you are human|performing security verification/i.test(document.title + " " + visibleText);
  const challengeMarker = Boolean(document.querySelector("#challenge-error-text, [id^=cf-chl-], .cf-challenge, iframe[src*='challenge'], form[action*='challenge-platform'], meta[name='cf-ray'], [data-cf-chl], [data-ray]"));
  // Cloudflare's interstitial can expose only "Just a moment..." and an empty
  // body; its challenge token in the URL is the remaining reliable signal.
  const challengeUrl = /(?:^|[?&])__cf_chl(?:_|=)/i.test(location.search);
  const challengeReason = challengeCopy || challengeMarker || challengeUrl
    ? "Automated access challenge page; ordinary site content was not available." : undefined;
  const loginLike = controls.some(function (control) { return control.passwordField; })
    || /\b(sign in|log in|login|create account)\b/i.test(document.title + " " + truncate(visibleText, 1000));
  const structural = Array.from(document.body.querySelectorAll("header,nav,main,footer,h1,h2,form,button,a[href],input,select,textarea"))
    .slice(0, 500).map(function (element) { return element.tagName + ":" + (element.getAttribute("role") || "") + ":" + (element.getAttribute("aria-label") || ""); }).join("|");
  const accessibleNodes = Array.from(document.querySelectorAll("[role],button,a[href],input,select,textarea"))
    .filter(visible).slice(0, 500).map(function (element) { return {
      role: element.getAttribute("role") || (element.tagName.toLowerCase() === "button" ? "button" : element.tagName.toLowerCase() === "a" ? "link" : undefined),
      name: element.getAttribute("aria-label") || (truncate((element.textContent || "").replace(/\s+/g, " ").trim(), 200) || undefined),
      selector: element.id ? "#" + CSS.escape(element.id) : undefined
    }; });
  return {
    title: document.title,
    visibleText,
    controls,
    structure: structural,
    accessibleNodes,
    loginLike,
    challengeReason,
    links: Array.from(document.querySelectorAll("a[href]")).filter(visible).map(function (element) { return element.href; })
  };
})()`;

/**
 * Capture one already-navigated page. Password controls and likely login pages
 * are marked deferred-auth and their field values are never read or serialized.
 */
export async function capturePage(page: Page, options: ObserveOptions = {}): Promise<Observation> {
  const result = await page.evaluate(RENDERED_PAGE_CAPTURE_SCRIPT) as RenderedPageCapture;

  const id = `obs-${createHash("sha256").update(page.url()).update(result.structure).digest("hex").slice(0, 12)}`;
  let screenshotPath: string | undefined;
  if (options.screenshot && options.artifactDirectory) {
    const { mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(options.artifactDirectory, { recursive: true });
    screenshotPath = join(options.artifactDirectory, `${id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
  }

  return ObservationSchema.parse({
    id,
    url: page.url(),
    capturedAt: new Date().toISOString(),
    status: result.challengeReason ? "blocked" : result.loginLike ? "deferred-auth" : "observed",
    title: result.title,
    visibleText: result.loginLike || result.challengeReason ? "" : result.visibleText,
    domStructure: result.loginLike || result.challengeReason ? "" : result.structure,
    accessibleNodes: result.loginLike || result.challengeReason ? [] : result.accessibleNodes,
    structureFingerprint: createHash("sha256").update(result.structure).digest("hex"),
    controls: result.loginLike || result.challengeReason ? [] : result.controls,
    ...(result.challengeReason ? { blockedReason: result.challengeReason } : {}),
    ...(screenshotPath ? { screenshotPath } : {}),
  });
}

/** Candidate navigation links limited to the merchant origin and explicit temporary origins. */
export function sameOriginCandidates(observation: Observation, links: string[], allowedOrigins: string[]): string[] {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const baseOrigin = new URL(observation.url).origin;
  allowed.add(baseOrigin);
  const candidates = new Set<string>();
  for (const link of links) {
    try {
      const url = new URL(link, observation.url);
      if (allowed.has(url.origin) && ["http:", "https:"].includes(url.protocol)) candidates.add(url.toString());
    } catch {
      // Invalid hrefs are evidence noise, not a reason to fail the whole crawl.
    }
  }
  return [...candidates];
}
