/** Frontier, discovery, and report tests protect the bounded exploration contract. */
import { describe, expect, it } from "vitest";
import { parseBudgetOverrides } from "../src/site-understanding/budgets.js";
import { explore } from "../src/site-understanding/explorer.js";
import { rankFrontier, selectNextFrontier } from "../src/site-understanding/frontier.js";
import { renderSiteUnderstandingReport } from "../src/site-understanding/report.js";
import type { SiteModel } from "../src/model/schema.js";
import { discoverCandidates } from "../src/site-understanding/discovery.js";
import { ObservationGraph, clusterPageFamilies } from "../src/site-understanding/graph.js";
import { resolveActionEvidence } from "../src/site-understanding/action-evidence.js";
import { AgentProposalSchema, validateProposalReferences } from "../src/site-understanding/agent-reasoning.js";
import { CandidateActionSchema } from "../src/model/schema.js";

describe("bounded frontier", () => {
  it("selects high-information candidates and stops at page budget", async () => {
    const ranked = rankFrontier([
      { url: "https://shop.example/a", reason: "common", novelty: 0.2, uncoveredFunctionality: 0.1, uncertaintyReduction: 0.1, cost: 0.1, accessRisk: 0 },
      { url: "https://shop.example/b", reason: "new action", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0.1, accessRisk: 0 },
    ]);
    expect(ranked[0]?.url).toBe("https://shop.example/b");
    const result = await explore({ observe: async (candidate) => ({ id: candidate.url, url: candidate.url, capturedAt: new Date().toISOString(), status: "observed", title: "", visibleText: "", structureFingerprint: candidate.url, controls: [] }) }, ranked.map((item) => ({ ...item, origin: new URL(item.url).origin })), parseBudgetOverrides({ maxPages: 1 }));
    expect(result.observations).toHaveLength(1);
    expect(result.stopReason).toBe("page-budget");
    expect(result.unvisited).toHaveLength(1);
  });

  it("still observes pages when interaction budget is zero", async () => {
    const result = await explore({ observe: async (candidate) => ({ id: candidate.url, url: candidate.url, capturedAt: new Date().toISOString(), status: "observed", title: "", visibleText: "", structureFingerprint: candidate.url, controls: [] }) }, [
      { url: "https://shop.example/", origin: "https://shop.example", reason: "start", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0 },
    ], parseBudgetOverrides({ maxInteractions: 0 }));
    expect(result.observations).toHaveLength(1);
  });

  it("continues with an allowed origin when a higher-ranked new origin exceeds the origin budget", async () => {
    const result = await explore({ observe: async (candidate) => ({ id: candidate.url, url: candidate.url, capturedAt: new Date().toISOString(), status: "observed", title: "", visibleText: "", structureFingerprint: candidate.url, controls: [] }) }, [
      { url: "https://shop.example/", origin: "https://shop.example", reason: "start", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0 },
      { url: "https://external.example/", origin: "https://external.example", reason: "external", novelty: 0.95, uncoveredFunctionality: 0.95, uncertaintyReduction: 0.95, cost: 0, accessRisk: 0 },
      { url: "https://shop.example/catalog", origin: "https://shop.example", reason: "same origin", novelty: 0.5, uncoveredFunctionality: 0.5, uncertaintyReduction: 0.5, cost: 0, accessRisk: 0 },
    ], parseBudgetOverrides({ maxOrigins: 1 }));
    expect(result.observations.map((item) => item.url)).toEqual(["https://shop.example/", "https://shop.example/catalog"]);
    expect(result.stopReason).toBe("origin-budget");
    expect(result.unvisited).toEqual([{ url: "https://external.example/", reason: "external" }]);
  });

  it("counts a blocked navigation attempt against the origin budget", async () => {
    const result = await explore({ observe: async (candidate) => ({ id: candidate.url, url: candidate.url, capturedAt: new Date().toISOString(), status: "blocked", title: "", visibleText: "", structureFingerprint: "blocked", controls: [], blockedReason: "challenge" }) }, [
      { url: "https://shop.example/", origin: "https://shop.example", reason: "start", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0 },
      { url: "https://payments.example/", origin: "https://payments.example", reason: "external", novelty: 0.9, uncoveredFunctionality: 0.9, uncertaintyReduction: 0.9, cost: 0, accessRisk: 0 },
    ], parseBudgetOverrides({ maxOrigins: 1 }));
    expect(result.observations).toHaveLength(1);
    expect(result.stopReason).toBe("origin-budget");
    expect(result.unvisited.map((item) => item.url)).toContain("https://payments.example/");
  });

  it("records browser navigation exceptions as failed rather than access-blocked", async () => {
    const result = await explore({ observe: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } }, [
      { url: "https://shop.example/", origin: "https://shop.example", reason: "start", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0 },
    ], parseBudgetOverrides({ maxPages: 1 }));

    expect(result.observations[0]?.status).toBe("failed");
    expect(result.observations[0]?.blockedReason).toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("keeps agent ranking inside the known frontier and preserves omitted candidates", async () => {
    const observed: string[] = [];
    const candidates = [
      { url: "https://shop.example/a", origin: "https://shop.example", reason: "candidate a", novelty: 0.2, uncoveredFunctionality: 0.2, uncertaintyReduction: 0.2, cost: 0.1, accessRisk: 0 },
      { url: "https://shop.example/b", origin: "https://shop.example", reason: "candidate b", novelty: 0.8, uncoveredFunctionality: 0.8, uncertaintyReduction: 0.8, cost: 0.1, accessRisk: 0 },
    ];
    const result = await explore({
      observe: async (candidate) => {
        observed.push(candidate.url);
        return { id: candidate.url, url: candidate.url, capturedAt: new Date().toISOString(), status: "observed", title: "", visibleText: "", structureFingerprint: "x", controls: [] };
      },
      rank: async () => [
        { ...candidates[1]!, score: 0.9 },
        { ...candidates[1]!, score: 0.8 },
        { url: "https://invented.example/", reason: "invented", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0, score: 1 },
      ],
    }, candidates, parseBudgetOverrides({ maxPages: 2 }));
    expect(observed).toEqual(["https://shop.example/b", "https://shop.example/a"]);
    expect(result.selected[0]?.factors.novelty).toBe(0.8);
    expect(result.selected[0]?.reason).toBe("candidate b");
  });

  it("reports interaction exhaustion without exceeding the configured count", async () => {
    let interactions = 0;
    const candidates = ["/a", "/b"].map((path) => ({
      url: `https://shop.example${path}`, origin: "https://shop.example", reason: path,
      novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0,
    }));
    const result = await explore({
      observe: async (candidate) => ({ id: candidate.url, url: candidate.url, capturedAt: new Date().toISOString(), status: "observed", title: "", visibleText: "", structureFingerprint: "x", controls: [] }),
      interact: async () => { interactions += 1; return 1; },
    }, candidates, parseBudgetOverrides({ maxPages: 2, maxInteractions: 1 }));
    expect(interactions).toBe(1);
    expect(result.observations).toHaveLength(2);
  });

  it("deduplicates normalized URL candidates and records observation timeouts as failures", async () => {
    let calls = 0;
    const result = await explore({
      observe: async () => {
        calls += 1;
        return await new Promise((resolve) => setTimeout(() => resolve({ id: "late", url: "https://shop.example/", capturedAt: new Date().toISOString(), status: "observed", title: "", visibleText: "", structureFingerprint: "x", controls: [] }), 30));
      },
    }, [
      { url: "https://shop.example/?utm_source=nav", origin: "https://shop.example", reason: "first", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0 },
      { url: "https://shop.example/", origin: "https://shop.example", reason: "duplicate", novelty: 0.8, uncoveredFunctionality: 0.8, uncertaintyReduction: 0.8, cost: 0, accessRisk: 0 },
    ], parseBudgetOverrides({ maxDurationSeconds: 1 }), Date.now() - 990);
    expect(calls).toBe(1);
    expect(result.observations[0]?.status).toBe("failed");
    expect(result.observations[0]?.blockedReason).toContain("remaining time budget");
    expect(result.stopReason).toBe("time-budget");
  });

  it("frontier selection skips disallowed origins instead of hiding eligible candidates", () => {
    const state = { pagesVisited: 0, interactionsUsed: 0, startedAt: Date.now(), originsVisited: new Set(["https://shop.example"]) };
    const decision = selectNextFrontier([
      { url: "https://payments.example/", reason: "external", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0 },
      { url: "https://shop.example/catalog", reason: "same origin", novelty: 0.5, uncoveredFunctionality: 0.5, uncertaintyReduction: 0.5, cost: 0, accessRisk: 0 },
    ], state, parseBudgetOverrides({ maxOrigins: 1 }));
    expect(decision.decision?.url).toBe("https://shop.example/catalog");
  });

  it("discovers form targets, normalizes candidates, and excludes unapproved origins", () => {
    const observation = { id: "obs", url: "https://shop.example/search", capturedAt: "2026-01-01T00:00:00Z", status: "observed" as const, title: "", visibleText: "", structureFingerprint: "x", controls: [{ kind: "form" as const, text: "", formAction: "https://shop.example/search?utm_source=menu" }] };
    const result = discoverCandidates(observation, ["/products?color=red&utm_source=menu", "https://external.example/checkout"], "https://shop.example");
    expect(result.candidates).toContain("https://shop.example/products?color=red");
    expect(result.candidates).toContain("https://shop.example/search");
    expect(result.excluded).toHaveLength(1);
  });

  it("records explicitly permitted external origins as understanding candidates", () => {
    const observation = { id: "obs", url: "https://shop.example/", capturedAt: "2026-01-01T00:00:00Z", status: "observed" as const, title: "", visibleText: "", structureFingerprint: "x", controls: [] };
    const result = discoverCandidates(observation, ["https://checkout.example/cart"], "https://shop.example", ["https://checkout.example"]);
    expect(result.candidates).toEqual(["https://checkout.example/cart"]);
    expect(result.excluded).toEqual([]);
  });

  it("keeps login, password recovery, and registration flows out of the frontier", () => {
    const observation = { id: "obs", url: "https://shop.example/", capturedAt: "2026-01-01T00:00:00Z", status: "observed" as const, title: "", visibleText: "", structureFingerprint: "x", controls: [] };
    const result = discoverCandidates(observation, ["/products/bike", "/account/login", "/register"], "https://shop.example");
    expect(result.candidates).toEqual(["https://shop.example/products/bike"]);
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded.every((item) => item.reason === "authentication workflow is deferred")).toBe(true);
  });

  it("deduplicates variable entity URLs without merging distinct routes or structures", () => {
    const graph = new ObservationGraph();
    const make = (id: string, url: string, structureFingerprint: string) => ({ id, url, capturedAt: "2026-01-01T00:00:00Z", status: "observed" as const, title: "", visibleText: "", structureFingerprint, controls: [] });
    graph.addObservation(make("a", "https://shop.example/products/city-bike-123", "product"));
    graph.addObservation(make("b", "https://shop.example/products/touring-bike-456", "product"));
    graph.addObservation(make("c", "https://shop.example/categories/bikes", "category"));
    graph.addObservation(make("d", "https://shop.example/product", "product"));
    graph.addObservation(make("e", "https://shop.example/products/city-bike-123?color=red", "product"));
    expect(graph.nodes.size).toBe(4);
    expect([...graph.nodes.values()].find((node) => node.observationIds.includes("a"))?.observationIds).toEqual(["a", "b"]);
    const families = clusterPageFamilies([make("a", "https://shop.example/products/city-bike-123", "product"), make("b", "https://shop.example/products/touring-bike-456", "product"), make("c", "https://shop.example/about", "about")], "https://shop.example");
    expect(families.map((family) => family.pathPattern)).toContain("/products/:value");
    expect(families.map((family) => family.pathPattern)).toContain("/about");
  });

  it("keeps ambiguous action targets out of the executable inventory", () => {
    const action = { id: "a", targetEvidenceIds: ["missing"], locators: [], status: "approved" };
    expect(resolveActionEvidence([action], []).at(0)?.status).toBe("unresolved");
  });

  it("keeps unsupported agent claims as hypotheses and checks every evidence reference", () => {
    const proposal = AgentProposalSchema.parse({
      pageFamilies: [{ id: "home", label: "Home", pathPattern: "/", confidence: 0.8 }],
      actions: [
        { id: "guess", name: "guess", description: "Unsupported action", mode: "live-write", confidence: 0.9, evidenceIds: ["invented"], pageFamilyIds: ["home"] },
        { id: "no-evidence", name: "no_evidence", description: "Possible action", mode: "read", confidence: 0.4, evidenceIds: [] },
      ],
      semanticSummaries: [{ pageFamilyId: "home", heading: "Summary", content: "Fact", sourceObservationIds: ["obs"] }],
      nextFrontier: [],
    });
    const checked = validateProposalReferences(proposal, [{ id: "obs", url: "https://shop.example/", capturedAt: "2026-01-01T00:00:00Z", status: "observed", title: "", visibleText: "", structureFingerprint: "x", controls: [] }], [{ id: "home", label: "Home", origin: "https://shop.example", pathPattern: "/", queryRules: {}, examples: ["https://shop.example/"], counterexamples: [], observationIds: ["obs"], confidence: 0.8, status: "proposed" }], [
      { url: "https://shop.example/products", reason: "discovered link", novelty: 0.8, uncoveredFunctionality: 0.7, uncertaintyReduction: 0.6, cost: 0.2, accessRisk: 0 },
    ]);
    expect(checked.proposal.actions[0]?.confidence).toBe(0.25);
    expect(checked.proposal.actions[0]?.evidenceIds).toEqual([]);
    expect(checked.proposal.actions[1]?.evidenceIds).toEqual([]);
    expect(checked.issues).toHaveLength(1);
    expect(checked.proposal.nextFrontier).toEqual([]);
    expect(CandidateActionSchema.safeParse({ id: "bad", name: "bad", description: "Bad", pageFamilyIds: ["home"], mode: "live-write", inputSchema: {}, targetEvidenceIds: [], locators: [], preconditions: [], postconditions: [], risk: "high", confidence: 0.8, status: "approved" }).success).toBe(false);
  });

  it("accepts only distinct URLs from the discovered frontier and normalizes tracking variants", () => {
    const proposal = AgentProposalSchema.parse({
      pageFamilies: [], actions: [], semanticSummaries: [],
      nextFrontier: [
        { url: "https://shop.example/products?utm_source=nav", reason: "product family", novelty: 0.8, uncoveredFunctionality: 0.7, uncertaintyReduction: 0.6, cost: 0.2, accessRisk: 0 },
        { url: "https://invented.example/checkout", reason: "invented", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0, accessRisk: 0 },
        { url: "https://shop.example/products", reason: "duplicate", novelty: 0.9, uncoveredFunctionality: 0.8, uncertaintyReduction: 0.7, cost: 0.1, accessRisk: 0 },
      ],
    });
    const checked = validateProposalReferences(proposal, [], [], [
      { url: "https://shop.example/products", reason: "discovered", novelty: 0.5, uncoveredFunctionality: 0.5, uncertaintyReduction: 0.5, cost: 0.25, accessRisk: 0 },
    ]);
    expect(checked.proposal.nextFrontier).toHaveLength(1);
    expect(checked.proposal.nextFrontier[0]?.reason).toBe("product family");
    expect(checked.issues).toHaveLength(2);
  });
});

describe("review report", () => {
  it("shows partial coverage, external-origin separation, and deferred authentication", () => {
    const model = { schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: ["https://cdn.example"], runtimeExternalOrigins: [], relaxedQueryOrigins: ["https://shop.example"], createdAt: "2026-01-01T00:00:00Z" }, observations: [{ id: "blocked", url: "https://shop.example/", capturedAt: "2026-01-01T00:00:00Z", status: "blocked", title: "", visibleText: "", structureFingerprint: "blocked", controls: [], blockedReason: "challenge" }], evidence: [], pageFamilies: [], transitions: [], actions: [], semanticSources: [], validations: [], exploration: { status: "blocked", stopReason: "access denied", visitedCount: 1, estimatedCoverage: 0.1, unvisitedFrontier: [{ url: "https://shop.example/products", reason: "not observed" }], authenticationDeferred: true } } satisfies SiteModel;
    const report = renderSiteUnderstandingReport(model);
    expect(report).toContain("10.0%");
    expect(report).toContain("deferred");
    expect(report).toContain("https://cdn.example");
    expect(report).toContain("Origins with recorded observations: https://shop.example");
    expect(report).toContain("Origins accepting additional query keys: https://shop.example");
    expect(report).toContain("does not grant runtime access");
    expect(report).toContain("challenge");
  });
});
