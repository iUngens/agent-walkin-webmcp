/** Contract tests for agent proposals, evidence-linked semantics, and credential exclusion. */
import { describe, expect, it } from "vitest";
import { parseSiteModel, type CandidateAction, type Observation, type PageFamily, type SemanticSource } from "../src/model/schema.js";
import { AgentProposalSchema, proposalActions, proposalSemantics, validateProposalReferences } from "../src/site-understanding/agent-reasoning.js";
import { generateSemanticDocuments } from "../src/site-understanding/semantics.js";

const observation: Observation = {
  id: "obs-home",
  url: "https://shop.example/",
  capturedAt: "2026-01-01T00:00:00Z",
  status: "observed",
  title: "Shop",
  visibleText: "Featured products",
  structureFingerprint: "home-v1",
  controls: [{ kind: "button", text: "Search", selector: "#search", uniqueInObservation: true }],
};

const family: PageFamily = {
  id: "home",
  label: "Home",
  origin: "https://shop.example",
  pathPattern: "/",
  queryRules: {},
  examples: ["https://shop.example/"],
  counterexamples: [],
  observationIds: ["obs-home"],
  confidence: 0.9,
  status: "proposed",
};

describe("understanding artifacts", () => {
  it("schema-checks proposals and downgrades unknown targets without breaking the site model", () => {
    const proposal = AgentProposalSchema.parse({
      pageFamilies: [{ id: "invented-family", label: "Invented", pathPattern: "/x", confidence: 0.9 }],
      actions: [
        { id: "unsupported", name: "submit_order", description: "Submit order", mode: "live-write", confidence: 0.95, evidenceIds: ["invented-evidence"], pageFamilyIds: ["invented-family"] },
        { id: "observed", name: "search", description: "Search products", mode: "read", confidence: 0.8, evidenceIds: ["evidence-obs-home-1"], pageFamilyIds: ["home"] },
      ],
      semanticSummaries: [
        { pageFamilyId: "home", heading: "Observed", content: "Featured products are shown.", sourceObservationIds: ["obs-home"] },
        { pageFamilyId: "missing", heading: "Unsupported", content: "Made up", sourceObservationIds: ["obs-home"] },
      ],
      nextFrontier: [],
    });
    const checked = validateProposalReferences(proposal, [observation], [family]);
    const actions = proposalActions(checked.proposal, [family.id]);
    const semantics = proposalSemantics(checked.proposal, [observation], [{ id: "evidence-obs-home-1", observationId: observation.id, url: observation.url, kind: "accessible-control", summary: "Search button" }]);
    const model = {
      schemaVersion: "1.0",
      site: { schemaVersion: "1.0", siteId: "shop", startUrl: observation.url, merchantOrigin: "https://shop.example", createdAt: "2026-01-01T00:00:00Z" },
      observations: [observation], evidence: [{ id: "evidence-obs-home-1", observationId: observation.id, url: observation.url, kind: "accessible-control", summary: "Search button" }],
      pageFamilies: [family], transitions: [], actions, semanticSources: semantics, validations: [],
      exploration: { status: "partial", stopReason: "test", visitedCount: 1, estimatedCoverage: 0.5, unvisitedFrontier: [], authenticationDeferred: true },
    };

    expect(checked.issues).toHaveLength(3);
    expect(actions[0]?.status).toBe("unresolved");
    expect(actions[0]?.confidence).toBeLessThanOrEqual(0.25);
    expect(actions[1]?.status).toBe("review-required");
    expect(() => parseSiteModel(model)).not.toThrow();
  });

  it("labels observed facts, agent summaries, and action meaning with source references", () => {
    const sources: SemanticSource[] = [
      { id: "fact", pageFamilyId: family.id, sourceUrl: observation.url, heading: "Products", content: "Three featured products are visible.", kind: "observed-fact", evidenceIds: ["e1"] },
      { id: "summary", pageFamilyId: family.id, sourceUrl: observation.url, heading: "Purpose", content: "This page appears to introduce the catalog.", kind: "summary", evidenceIds: ["e2"] },
      { id: "action-source", pageFamilyId: family.id, sourceUrl: observation.url, heading: "Search", content: "Search the visible product catalog.", kind: "action-semantics", evidenceIds: ["e3"] },
    ];
    const action: CandidateAction = {
      id: "search", name: "search_products", description: "Search visible products", pageFamilyIds: [family.id], mode: "read", inputSchema: {}, targetEvidenceIds: ["e1"], locators: [], preconditions: [], postconditions: [], risk: "low", confidence: 0.8, status: "review-required",
    };
    const document = generateSemanticDocuments([family], sources, [action], new Map([["e1", observation.url]])).get(family.id);

    expect(document).toContain("## Observed fact: Products");
    expect(document).toContain("## Agent summary: Purpose");
    expect(document).toContain("## Action semantics: Search");
    expect(document).toContain("Source: https://shop.example/ (evidence: e1)");
    expect(document).toContain("- Source: https://shop.example/");
    expect(document).toContain("- Mode: read");
  });

  it("does not serialize password field values into observations", () => {
    const authObservation: Observation = {
      id: "auth",
      url: "https://shop.example/account/login",
      capturedAt: "2026-01-01T00:00:00Z",
      status: "deferred-auth",
      title: "Sign in",
      visibleText: "",
      structureFingerprint: "auth-deferred",
      controls: [],
    };
    expect(JSON.stringify(authObservation)).not.toContain("must-not-leak");
    expect(authObservation.status).toBe("deferred-auth");
  });
});
