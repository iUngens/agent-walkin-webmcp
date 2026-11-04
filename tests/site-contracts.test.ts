/** Held-out tests for URL families and bounded configuration, including unsafe expansion cases. */
import { describe, expect, it } from "vitest";
import { BudgetSchema, DEFAULT_BUDGETS, parseBudgetOverrides } from "../src/site-understanding/budgets.js";
import { matchesPageFamily, normalizeUrl } from "../src/site-understanding/url-rules.js";
import { CandidateActionSchema, SiteModelSchema } from "../src/model/schema.js";
import { evidenceFromObservations, locatorCandidatesForEvidence } from "../src/site-understanding/action-evidence.js";

const family = {
  id: "product-detail", label: "Product detail", pathPattern: "/products/:slug",
  origin: "https://shop.example",
  queryRules: { variant: "optional" as const, color: "ignored" as const },
  examples: ["https://shop.example/products/bike"], observationIds: ["obs-1"], confidence: 0.9, status: "reviewed" as const,
};

describe("versioned model contracts", () => {
  it("accepts a minimally complete model and rejects an unproven executable action", () => {
    const valid = {
      schemaVersion: "1.0",
      site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [], pageFamilies: [], transitions: [], actions: [], semanticSources: [], validations: [],
      exploration: { status: "blocked", stopReason: "Access denied", visitedCount: 0, estimatedCoverage: 0, unvisitedFrontier: [], authenticationDeferred: true },
    };
    expect(SiteModelSchema.safeParse(valid).success).toBe(true);
    expect(CandidateActionSchema.safeParse({
      id: "buy", name: "Buy", description: "Buy item", pageFamilyIds: ["p"], mode: "live-write",
      targetEvidenceIds: [], risk: "high", confidence: 0.8, status: "validated",
    }).success).toBe(false);
  });

  it("normalizes explicitly supplied origin URLs while rejecting credentials and non-web schemes", () => {
    const model = {
      schemaVersion: "1.0",
      site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example/catalog?ref=home", understandingOrigins: ["https://checkout.example/flow/start"], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [], pageFamilies: [], transitions: [], actions: [], semanticSources: [], validations: [],
      exploration: { status: "blocked", stopReason: "Access denied", visitedCount: 0, estimatedCoverage: 0, unvisitedFrontier: [], authenticationDeferred: true },
    };
    const parsed = SiteModelSchema.parse(model);
    expect(parsed.site.merchantOrigin).toBe("https://shop.example");
    expect(parsed.site.understandingOrigins).toEqual(["https://checkout.example"]);
    expect(SiteModelSchema.safeParse({ ...model, site: { ...model.site, understandingOrigins: ["https://user:pass@checkout.example"] } }).success).toBe(false);
    expect(SiteModelSchema.safeParse({ ...model, site: { ...model.site, understandingOrigins: ["ftp://checkout.example/file"] } }).success).toBe(false);
  });

  it("allows query relaxation for explicitly selected origins without granting runtime access", () => {
    const base = {
      schemaVersion: "1.0",
      site: {
        schemaVersion: "1.0",
        siteId: "shop",
        startUrl: "https://shop.example/",
        merchantOrigin: "https://shop.example",
        understandingOrigins: ["https://checkout.example/flow"],
        runtimeExternalOrigins: [],
        relaxedQueryOrigins: ["https://shop.example/catalog?ref=home", "https://checkout.example/checkout"],
        createdAt: "2026-01-01T00:00:00Z",
      },
      observations: [], evidence: [], pageFamilies: [], transitions: [], actions: [], semanticSources: [], validations: [],
      exploration: { status: "blocked", stopReason: "Access denied", visitedCount: 0, estimatedCoverage: 0, unvisitedFrontier: [], authenticationDeferred: true },
    };
    const parsed = SiteModelSchema.parse(base);
    expect(parsed.site.relaxedQueryOrigins).toEqual(["https://shop.example", "https://checkout.example"]);
    expect(SiteModelSchema.safeParse({
      ...base,
      site: { ...base.site, relaxedQueryOrigins: ["https://checkout.example"] },
    }).success).toBe(true);
    expect(SiteModelSchema.safeParse({
      ...base,
      site: { ...base.site, relaxedQueryOrigins: ["https://unknown.example"] },
    }).success).toBe(false);
    expect(SiteModelSchema.safeParse({
      ...base,
      site: { ...base.site, relaxedQueryOrigins: ["https://temporary.example"] },
    }).success).toBe(false);

    const runtimeApproved = SiteModelSchema.parse({
      ...base,
      site: {
        ...base.site,
        runtimeExternalOrigins: ["https://shipping.example"],
        relaxedQueryOrigins: ["https://shipping.example"],
      },
    });
    expect(runtimeApproved.site.relaxedQueryOrigins).toEqual(["https://shipping.example"]);
  });
});

describe("evidence-linked locators", () => {
  const observation = (selectorUnique: boolean) => ({
    id: "obs-1", url: "https://shop.example/", capturedAt: "2026-01-01T00:00:00Z", status: "observed" as const,
    title: "Shop", visibleText: "Add", structureFingerprint: "fp", controls: [{ kind: "button" as const, text: "Add", selector: "#add", uniqueInObservation: selectorUnique }],
  });

  it("creates locator candidates only when the observed selector is unique", () => {
    const uniqueEvidence = evidenceFromObservations([observation(true)]);
    const ambiguousEvidence = evidenceFromObservations([observation(false)]);
    expect(locatorCandidatesForEvidence(uniqueEvidence, ["evidence-obs-1-1"])).toHaveLength(1);
    expect(locatorCandidatesForEvidence(ambiguousEvidence, ["evidence-obs-1-1"])).toEqual([]);
  });

  it("requires declared action inputs to map one-to-one to matching observed controls", () => {
    const observed = observation(true);
    observed.controls.push({ kind: "input", text: "Search", selector: "#query", uniqueInObservation: true, inputType: "text" });
    const base = {
      id: "search", name: "Search", description: "Search the catalog", pageFamilyIds: ["catalog"], mode: "live-write" as const,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      inputBindings: [{ property: "query", selector: "#query", controlKind: "input" as const, inputType: "text", evidenceId: "evidence-obs-1-2", uniqueInObservation: true }],
      targetEvidenceIds: ["evidence-obs-1-2"], locators: [], preconditions: [], postconditions: [], risk: "medium" as const, confidence: 0.9, status: "review-required" as const,
    };
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", createdAt: "2026-01-01T00:00:00Z" },
      observations: [observed], evidence: evidenceFromObservations([observed]), pageFamilies: [], transitions: [], actions: [base], semanticSources: [], validations: [],
      exploration: { status: "partial" as const, stopReason: "budget", visitedCount: 1, estimatedCoverage: 0.5, unvisitedFrontier: [], authenticationDeferred: true },
    };
    expect(SiteModelSchema.safeParse(model).success).toBe(true);
    expect(SiteModelSchema.safeParse({ ...model, actions: [{ ...base, inputBindings: [{ ...base.inputBindings[0]!, controlKind: "select" as const }] }] }).success).toBe(false);
    expect(SiteModelSchema.safeParse({ ...model, actions: [{ ...base, inputBindings: [{ ...base.inputBindings[0]!, selector: "#guessed" }] }] }).success).toBe(false);
    expect(SiteModelSchema.safeParse({ ...model, actions: [{ ...base, inputBindings: [{ ...base.inputBindings[0]!, uniqueInObservation: false }] }] }).success).toBe(false);
  });
});

describe("URL family rules", () => {
  it("removes only known tracking parameters and fragments", () => {
    expect(normalizeUrl("https://shop.example/products/bike?variant=red&utm_source=x#details"))
      .toBe("https://shop.example/products/bike?variant=red");
    expect(normalizeUrl("https://shop.example/search?q=bike&filter=blue"))
      .toBe("https://shop.example/search?filter=blue&q=bike");
  });

  it("matches variable product values but preserves meaningful route and query dimensions", () => {
    expect(matchesPageFamily("https://shop.example/products/helmet?variant=red&color=blue", family)).toBe(true);
    expect(matchesPageFamily("https://shop.example/products/helmet?coupon=save", family)).toBe(false);
    expect(matchesPageFamily("https://shop.example/products/helmet/size-m", family)).toBe(false);
    expect(matchesPageFamily("https://cdn.example/products/helmet", family)).toBe(false);
  });

  it("relaxes unmodeled query keys only for explicitly selected exact origins", () => {
    const relaxedOrigins = ["https://shop.example"];
    expect(matchesPageFamily("https://shop.example/products/helmet?coupon=save", family, relaxedOrigins)).toBe(true);
    expect(matchesPageFamily("https://shop.example/products/helmet?coupon=save", family)).toBe(false);
    expect(matchesPageFamily("https://shop.example/products/helmet/size-m?coupon=save", family, relaxedOrigins)).toBe(false);
    expect(matchesPageFamily("https://other.example/products/helmet?coupon=save", family, relaxedOrigins)).toBe(false);
    expect(matchesPageFamily("https://shop.example/products/helmet?coupon=save", family, ["https://other.example"])).toBe(false);
    expect(matchesPageFamily("https://shop.example/products/helmet?coupon=save", { ...family, queryRules: { ...family.queryRules, variant: "required" } }, relaxedOrigins)).toBe(false);
  });
});

describe("finite exploration budgets", () => {
  it("uses safe defaults and accepts bounded overrides", () => {
    expect(parseBudgetOverrides({})).toEqual(DEFAULT_BUDGETS);
    expect(parseBudgetOverrides({ maxPages: "8", maxOrigins: 2 }).maxPages).toBe(8);
  });

  it("rejects invalid, non-integer, and excessive limits", () => {
    expect(BudgetSchema.safeParse({ ...DEFAULT_BUDGETS, maxPages: 0 }).success).toBe(false);
    expect(() => parseBudgetOverrides({ maxPages: "9999" })).toThrow(/maxPages/);
    expect(() => parseBudgetOverrides({ maxDurationSeconds: "NaN" })).toThrow(/finite number/);
    expect(parseBudgetOverrides({ maxOrigins: 500 }).maxOrigins).toBe(500);
    expect(() => parseBudgetOverrides({ maxOrigins: 501 })).toThrow(/maxOrigins/);
  });
});
