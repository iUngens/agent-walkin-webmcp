/** Runtime and compiler tests exercise origin isolation, registration, and publication filtering. */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePackage } from "../src/package-generation/compiler.js";
import { executeAction, matchRuntimeFamily, registerTools, type RuntimeConfig } from "../src/package-generation/runtime.js";
import type { SiteModel } from "../src/model/schema.js";
import { generateSemanticDocuments } from "../src/site-understanding/semantics.js";
import { createServer } from "node:http";
import { verifyHostedPackage } from "../src/package-generation/hosting.js";

const config: RuntimeConfig = { merchantOrigin: "https://shop.example", externalOrigins: [], relaxedQueryOrigins: [], pageFamilies: [{ id: "catalog", origin: "https://shop.example", pathPattern: "/products/:slug", queryRules: {} }] };

describe("WebMCP runtime", () => {
  it("registers only matching pages and merchant origins", async () => {
    expect(matchRuntimeFamily("https://shop.example/products/bike", config)).toBe("catalog");
    expect(matchRuntimeFamily("https://shop.example/about", config)).toBeUndefined();
    expect(matchRuntimeFamily("https://evil.example/products/bike", config)).toBeUndefined();
    expect(matchRuntimeFamily("https://shop.example/products/bike?unmodeled=value", config)).toBeUndefined();
    expect(matchRuntimeFamily("https://shop.example/products/bike?utm_campaign=spring", config)).toBe("catalog");
    const relaxedConfig: RuntimeConfig = { ...config, relaxedQueryOrigins: ["https://shop.example"] };
    expect(matchRuntimeFamily("https://shop.example/products/bike?campaign=spring", relaxedConfig)).toBe("catalog");
    expect(matchRuntimeFamily("https://shop.example/about?campaign=spring", relaxedConfig)).toBeUndefined();
    expect(matchRuntimeFamily("https://other.example/products/bike?campaign=spring", relaxedConfig)).toBeUndefined();

    const calls: unknown[] = [];
    const documentLike = { modelContext: { registerTool: (tool: unknown) => calls.push(tool) } } as unknown as Document;
    const diagnostics = await registerTools(documentLike, [{ name: "read", description: "Read", inputSchema: {}, execute: async () => ({}) }], "catalog");
    expect(diagnostics).toEqual([]);
    expect(calls).toHaveLength(1);
    expect((await registerTools({} as Document, [{ name: "read", description: "Read", inputSchema: {}, execute: async () => ({}) }], "catalog"))[0]?.code).toBe("webmcp-unavailable");
  });

  it("reports duplicate tools without registering them twice", async () => {
    const calls: unknown[] = [];
    const documentLike = { modelContext: { registerTool: (tool: unknown) => calls.push(tool) } } as unknown as Document;
    const tool = { name: "read", description: "Read", inputSchema: {}, execute: async () => ({}) };
    expect(await registerTools(documentLike, [tool], "catalog")).toEqual([]);
    expect(await registerTools(documentLike, [tool], "catalog")).toEqual([{ code: "duplicate-registration", message: "read: already registered on this document." }]);
    expect(calls).toHaveLength(1);
  });

  it("reports asynchronous native registration rejection and permits a retry", async () => {
    let rejectNext = true;
    const calls: unknown[] = [];
    const documentLike = { modelContext: { registerTool: async (tool: unknown) => {
      calls.push(tool);
      if (rejectNext) { rejectNext = false; throw new DOMException("Tools permission denied", "NotAllowedError"); }
    } } } as unknown as Document;
    const tool = { name: "read", description: "Read", inputSchema: {}, execute: async () => ({}) };
    expect(await registerTools(documentLike, [tool], "catalog")).toEqual([{ code: "registration-failed", message: "read: Tools permission denied" }]);
    expect(await registerTools(documentLike, [tool], "catalog")).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("requires a runtime allowlist entry before a temporary understanding origin can host tools", () => {
    const externalFamily = { id: "checkout", origin: "https://payments.example", pathPattern: "/checkout", queryRules: {} };
    const understoodOnly = { ...config, relaxedQueryOrigins: ["https://payments.example"], pageFamilies: [externalFamily] };
    expect(matchRuntimeFamily("https://payments.example/checkout", understoodOnly)).toBeUndefined();
    expect(matchRuntimeFamily("https://payments.example/checkout?campaign=spring", understoodOnly)).toBeUndefined();

    const explicitlyAllowed = { ...understoodOnly, externalOrigins: ["https://payments.example"] };
    expect(matchRuntimeFamily("https://payments.example/checkout", explicitlyAllowed)).toBe("checkout");
    expect(matchRuntimeFamily("https://payments.example/checkout?campaign=spring", explicitlyAllowed)).toBe("checkout");
    expect(matchRuntimeFamily("https://other.example/checkout", explicitlyAllowed)).toBeUndefined();
  });

  it("permits query relaxation on a runtime-approved external origin while retaining its path boundary", () => {
    const externalFamily = { id: "checkout", origin: "https://payments.example", pathPattern: "/checkout", queryRules: { session: "required" as const } };
    const external = {
      ...config,
      externalOrigins: ["https://payments.example"],
      relaxedQueryOrigins: ["https://payments.example"],
      pageFamilies: [externalFamily],
    };
    expect(matchRuntimeFamily("https://payments.example/checkout?session=abc&flow=express", external)).toBe("checkout");
    expect(matchRuntimeFamily("https://payments.example/checkout?flow=express", external)).toBeUndefined();
    expect(matchRuntimeFamily("https://payments.example/other?session=abc&flow=express", external)).toBeUndefined();
  });

  it("does not claim a live write when no postcondition was reviewed", async () => {
    const target = { textContent: "Buy", click: () => undefined };
    const documentLike = { querySelector: () => target, body: { innerText: "Buy" } } as unknown as Document;
    const result = await executeAction(documentLike, { id: "buy", name: "buy", mode: "live-write", locators: [{ strategy: "id", selector: "#buy" }], preconditions: [], postconditions: [], waitMs: 0 }, {});
    expect(result.status).toBe("unconfirmed");
  });

  it("keeps read and preview modes from triggering the target action", async () => {
    let clicks = 0;
    const target = { textContent: "Buy now", click: () => { clicks += 1; } };
    const documentLike = { querySelector: () => target, body: { innerText: "Buy now" } } as unknown as Document;
    const base = { id: "buy", name: "buy", locators: [{ strategy: "id", selector: "#buy" }], preconditions: [], postconditions: [], waitMs: 0 };

    const read = await executeAction(documentLike, { ...base, mode: "read" }, {});
    const preview = await executeAction(documentLike, { ...base, mode: "preview" }, {});

    expect(read.status).toBe("confirmed");
    expect(read.detail).toBe("Buy now");
    expect(preview.status).toBe("confirmed");
    expect(preview.detail).toContain("no live submission");
    expect(clicks).toBe(0);
  });

  it("validates bound inputs before interaction and applies them only for live writes", async () => {
    let clicks = 0;
    let inputEvents = 0;
    let changeEvents = 0;
    const field = { tagName: "INPUT", type: "text", value: "", dispatchEvent: (event: Event) => { if (event.type === "input") inputEvents += 1; if (event.type === "change") changeEvents += 1; } };
    const target = { textContent: "Search", click: () => { clicks += 1; } };
    const documentLike = { querySelector: (selector: string) => selector === "#query" ? field : target, body: { innerText: "Search" } } as unknown as Document;
    const definition = { id: "search", name: "search", mode: "live-write" as const, locators: [{ strategy: "id", selector: "#submit" }], inputBindings: [{ property: "query", selector: "#query", controlKind: "input" as const, inputType: "text" }], preconditions: [], postconditions: [], waitMs: 0 };
    const preview = await executeAction(documentLike, { ...definition, mode: "preview" }, { query: "bike" });
    expect(preview.status).toBe("confirmed");
    expect(field.value).toBe("");
    expect(inputEvents).toBe(0);
    const result = await executeAction(documentLike, definition, { query: "bike" });
    expect(result.status).toBe("unconfirmed");
    expect(field.value).toBe("bike");
    expect(inputEvents).toBe(1);
    expect(changeEvents).toBe(1);
    expect(clicks).toBe(1);
    const missing = await executeAction({ querySelector: () => null } as unknown as Document, definition, { query: "bike" });
    expect(missing.status).toBe("failed");
  });

  it("does not mutate live-write inputs if the reviewed target is no longer clickable", async () => {
    const field = { tagName: "INPUT", type: "text", value: "original", dispatchEvent: () => true };
    const documentLike = { querySelector: (selector: string) => selector === "#query" ? field : ({ textContent: "Submit" }), body: { innerText: "Ready" } } as unknown as Document;
    const result = await executeAction(documentLike, {
      id: "submit", name: "submit", mode: "live-write", locators: [{ strategy: "id", selector: "#submit" }],
      inputBindings: [{ property: "query", selector: "#query", controlKind: "input", inputType: "text" }],
      preconditions: [], postconditions: [], waitMs: 0,
    }, { query: "changed" });
    expect(result.status).toBe("failed");
    expect(field.value).toBe("original");
  });

  it("returns packaged semantic source references without fetching or mutating the page", async () => {
    const generated = generateSemanticDocuments(
      [{ id: "catalog", label: "Catalog", origin: "https://shop.example", pathPattern: "/products/:slug", queryRules: {}, examples: ["https://shop.example/products/bike"], counterexamples: [], observationIds: ["obs-1"], confidence: 0.9, status: "reviewed" }],
      [{ id: "source-1", pageFamilyId: "catalog", sourceUrl: "https://shop.example/products/bike", heading: "Shipping", content: "Ships in three business days.", kind: "observed-fact", evidenceIds: ["evidence-1"] }],
      [],
    );
    let fetches = 0;
    let clicks = 0;
    const documentLike = { querySelector: () => ({ textContent: "" , click: () => { clicks += 1; } }), body: { innerText: "" } } as unknown as Document;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { fetches += 1; throw new Error("unexpected network request"); }) as typeof fetch;
    try {
      const result = await executeAction(documentLike, { id: "lookup", name: "lookup", mode: "read", locators: [{ strategy: "id", selector: "#unused" }], preconditions: [], postconditions: [], waitMs: 0 }, {});
      const { semanticLookup } = await import("../src/package-generation/runtime.js");
      const semantic = semanticLookup(generated.get("catalog")!, { query: "shipping" });
      expect(result.status).toBe("confirmed");
      expect(semantic.content).toContain("Ships in three business days.");
      expect(semantic.content).toContain("https://shop.example/products/bike");
      expect(semantic.content).toContain("evidence-1");
      expect(fetches).toBe(0);
      expect(clicks).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("waits for a reviewed postcondition instead of sleeping for a fixed delay", async () => {
    let ready = false;
    const target = { textContent: "Add", click: () => { setTimeout(() => { ready = true; }, 5); } };
    const documentLike = { querySelector: () => target, body: { get innerText() { return ready ? "Added" : "Add"; } } } as unknown as Document;
    const result = await executeAction(documentLike, { id: "add", name: "add", mode: "live-write", locators: [{ strategy: "id", selector: "#add" }], preconditions: [], postconditions: ["text:Added"], waitMs: 100 }, {});
    expect(result.status).toBe("confirmed");
  });
});

describe("package compiler", () => {
  it("emits multiple files and excludes hypotheses from executable modules", () => {
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: [], runtimeExternalOrigins: [], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [{ id: "e", observationId: "obs", url: "https://shop.example/products/bike", kind: "accessible-control", summary: "product", locator: { selector: "#product" } }], pageFamilies: [{ id: "catalog", label: "Catalog", origin: "https://shop.example", pathPattern: "/products/:slug", queryRules: {}, examples: ["https://shop.example/products/bike"], counterexamples: [], observationIds: ["obs"], confidence: 1, status: "reviewed" }], transitions: [],
      actions: [
        { id: "ready", name: "read_product", description: "Read product", pageFamilyIds: ["catalog"], mode: "read", inputSchema: {}, inputBindings: [], targetEvidenceIds: ["e"], locators: [{ strategy: "id", selector: "#product", evidenceId: "e", uniqueInObservation: true }], preconditions: [], postconditions: [], risk: "low", confidence: 1, status: "approved" },
        { id: "guess", name: "guess", description: "Unresolved", pageFamilyIds: ["catalog"], mode: "live-write", inputSchema: {}, targetEvidenceIds: [], preconditions: [], postconditions: [], risk: "high", confidence: 0.2, status: "hypothesis" },
      ], semanticSources: [], validations: [{ toolId: "ready", status: "passed", checkedAt: "2026-01-01T00:00:00Z", details: "fixture" }], exploration: { status: "complete-within-budget", stopReason: "frontier-exhausted", visitedCount: 1, estimatedCoverage: 1, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    const compiled = compilePackage(model);
    expect(compiled.files.map((file) => file.path)).toEqual(expect.arrayContaining(["config.json", "runtime.js", "runtime-helpers.js", "merchant-integration.md", "page-families/catalog.js"]));
    const source = compiled.files.find((file) => file.path === "page-families/catalog.js")?.contents;
    expect(source).toContain("read_product");
    expect(source).not.toContain("guess");
    expect(compiled.files.map((file) => file.path)).toContain("hosting.json");
    expect(compiled.files.map((file) => file.path)).toContain("manifest.json");
    expect(compiled.files.find((file) => file.path === "merchant-integration.md")?.contents).toContain("type=\"module\"");
    expect(compiled.files.find((file) => file.path === "runtime-helpers.js")?.contents).toContain("new URL(family.origin).origin");
    expect(compiled.files.find((file) => file.path === "config.json")?.contents).toContain('"origin": "https://shop.example"');
    const generatedRuntime = compiled.files.find((file) => file.path === "runtime-helpers.js")?.contents;
    expect(generatedRuntime).toContain("config.relaxedQueryOrigins");
    expect(compiled.files.find((file) => file.path === "config.json")?.contents).toContain('"relaxedQueryOrigins": []');
    expect(generatedRuntime).toContain('typeof target.click !== "function"');
    expect(generatedRuntime).not.toContain("HTMLElement");
    expect(compiled.files.find((file) => file.path === "bootstrap.js")?.contents).not.toContain("assert { type: \"json\" }");
    const manifest = JSON.parse(compiled.files.find((file) => file.path === "manifest.json")!.contents) as { files: Array<{ path: string; sha256: string }> };
    const metadata = JSON.parse(compiled.files.find((file) => file.path === "metadata.json")!.contents) as { files: Array<{ path: string; sha256: string }> };
    expect(metadata.files).toEqual(manifest.files);
    expect(manifest.files.map((item) => item.path)).toEqual(compiled.files.filter((file) => !["metadata.json", "manifest.json"].includes(file.path)).map((file) => file.path));
    expect(compilePackage(model).files).toEqual(compiled.files);
  });

  it("executes the generated URL policy with the same origin and path boundaries", async () => {
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: [], runtimeExternalOrigins: [], relaxedQueryOrigins: ["https://shop.example"], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [], pageFamilies: [{ id: "catalog", label: "Catalog", origin: "https://shop.example", pathPattern: "/products/:slug", queryRules: { variant: "required" }, examples: ["https://shop.example/products/bike?variant=blue"], counterexamples: [], observationIds: ["obs"], confidence: 1, status: "reviewed" }], transitions: [], actions: [], semanticSources: [], validations: [], exploration: { status: "complete-within-budget", stopReason: "frontier-exhausted", visitedCount: 1, estimatedCoverage: 1, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    const source = compilePackage(model).files.find((file) => file.path === "runtime-helpers.js")!.contents;
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as { matchRuntimeFamily: (url: string, config: RuntimeConfig) => string | undefined };
    const packageConfig = JSON.parse(compilePackage(model).files.find((file) => file.path === "config.json")!.contents) as RuntimeConfig;
    expect(runtime.matchRuntimeFamily("https://shop.example/products/bike?variant=blue&campaign=spring", packageConfig)).toBe("catalog");
    expect(runtime.matchRuntimeFamily("https://shop.example/products/bike?variant=blue&utm_campaign=spring", packageConfig)).toBe("catalog");
    expect(runtime.matchRuntimeFamily("https://shop.example/products/bike?campaign=spring", packageConfig)).toBeUndefined();
    expect(runtime.matchRuntimeFamily("https://shop.example/about?campaign=spring", packageConfig)).toBeUndefined();
    expect(runtime.matchRuntimeFamily("https://other.example/products/bike?campaign=spring", packageConfig)).toBeUndefined();
  });

  it("keeps undeclared query keys strict unless that exact origin is approved", async () => {
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: [], runtimeExternalOrigins: [], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [], pageFamilies: [{ id: "catalog", label: "Catalog", origin: "https://shop.example", pathPattern: "/products/:slug", queryRules: {}, examples: ["https://shop.example/products/bike"], counterexamples: [], observationIds: ["obs"], confidence: 1, status: "reviewed" }], transitions: [], actions: [], semanticSources: [], validations: [], exploration: { status: "complete-within-budget", stopReason: "frontier-exhausted", visitedCount: 1, estimatedCoverage: 1, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    const source = compilePackage(model).files.find((file) => file.path === "runtime-helpers.js")!.contents;
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as { matchRuntimeFamily: (url: string, config: RuntimeConfig) => string | undefined };
    const packageConfig = JSON.parse(compilePackage(model).files.find((file) => file.path === "config.json")!.contents) as RuntimeConfig;
    expect(runtime.matchRuntimeFamily("https://shop.example/products/bike?campaign=spring", packageConfig)).toBeUndefined();
  });

  it("runs generated action and semantic helpers with the same outcome contract", async () => {
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: [], runtimeExternalOrigins: [], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [], pageFamilies: [], transitions: [], actions: [], semanticSources: [], validations: [], exploration: { status: "complete-within-budget", stopReason: "frontier-exhausted", visitedCount: 0, estimatedCoverage: 0, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    const source = compilePackage(model).files.find((file) => file.path === "runtime-helpers.js")!.contents;
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`) as {
      executeAction: (document: Document, definition: Parameters<typeof executeAction>[1], input: unknown) => Promise<{ status: string }>;
      semanticLookup: (text: string, input: unknown) => { content: string };
    };
    const action = { id: "submit", name: "submit", mode: "live-write", locators: [{ strategy: "id", selector: "#submit" }], preconditions: [], postconditions: ["text:Done"], waitMs: 0 } as const;
    const failed = await runtime.executeAction({ querySelector: () => ({ click: () => { throw new Error("blocked"); } }), body: { innerText: "Ready" } } as unknown as Document, action, {});
    expect(failed.status).toBe("failed");

    let clicks = 0;
    const target = { textContent: "Product", click: () => { clicks += 1; } };
    const documentLike = { querySelector: () => target, body: { innerText: "Product" } } as unknown as Document;
    await runtime.executeAction(documentLike, { ...action, mode: "read", postconditions: [] }, {});
    await runtime.executeAction(documentLike, { ...action, mode: "preview", postconditions: [] }, {});
    expect(clicks).toBe(0);

    const semantic = runtime.semanticLookup(["# Shipping", "Delivery takes three days.", "", "## Returns", "Return within 30 days."].join(String.fromCharCode(10)), { query: "delivery" });
    expect(semantic.content).toContain("Delivery takes three days.");
    expect(semantic.content).not.toContain("Return within 30 days.");
  });

  it("writes the exact manifest-listed payload for static hosting", async () => {
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: [], runtimeExternalOrigins: [], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [], pageFamilies: [], transitions: [], actions: [], semanticSources: [], validations: [], exploration: { status: "complete-within-budget", stopReason: "frontier-exhausted", visitedCount: 0, estimatedCoverage: 0, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    const compiled = compilePackage(model);
    const directory = await mkdtemp(join(tmpdir(), "webmcp-package-"));
    try {
      await (await import("../src/package-generation/compiler.js")).writePackage(compiled, directory);
      for (const file of compiled.files) expect(await readFile(join(directory, file.path), "utf8")).toBe(file.contents);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("verifies a published versioned directory against the downloaded package", async () => {
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: [], runtimeExternalOrigins: [], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [], pageFamilies: [], transitions: [], actions: [], semanticSources: [], validations: [], exploration: { status: "complete-within-budget", stopReason: "frontier-exhausted", visitedCount: 0, estimatedCoverage: 0, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    const compiled = compilePackage(model);
    const directory = await mkdtemp(join(tmpdir(), "webmcp-hosted-"));
    const server = createServer(async (request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname).replace(/^\/webmcp\/shop-webmcp\/0\.1\.0\//, "");
      const file = compiled.files.find((item) => item.path === path);
      if (!file) { response.statusCode = 404; response.end("missing"); return; }
      response.statusCode = 200; response.end(file.contents);
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Hosted verification fixture did not start");
    try {
      await (await import("../src/package-generation/compiler.js")).writePackage(compiled, directory);
      const result = await verifyHostedPackage(directory, `http://127.0.0.1:${address.port}/webmcp/${compiled.packageId}/${compiled.version}/`);
      expect(result.verifiedFiles).toBe(compiled.files.length);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects byte differences that decode to the same replacement character", async () => {
    const directory = await mkdtemp(join(tmpdir(), "webmcp-hosted-bytes-"));
    const payload = "\uFFFD";
    const manifest = JSON.stringify({ packageId: "shop-webmcp", version: "0.1.0", files: [{ path: "payload.txt", sha256: createHash("sha256").update(payload).digest("hex") }] });
    const assets = new Map<string, Uint8Array>([
      ["payload.txt", Buffer.from(payload, "utf8")],
      ["manifest.json", Buffer.from(manifest)],
      ["metadata.json", Buffer.from("{}")],
    ]);
    try {
      await writeFile(join(directory, "payload.txt"), payload, "utf8");
      await writeFile(join(directory, "manifest.json"), manifest, "utf8");
      await writeFile(join(directory, "metadata.json"), "{}", "utf8");
      const result = verifyHostedPackage(directory, "https://cdn.example/shop/0.1.0/", async (input) => {
        const path = new URL(input).pathname.split("/").at(-1)!;
        return new Response(path === "payload.txt" ? new Uint8Array([0xff]) : assets.get(path), { status: 200 });
      });
      await expect(result).rejects.toThrow("Hosted asset does not match the downloaded package: payload.txt.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("holds approved actions without passing validation or unique evidence-backed locators", () => {
    const model = {
      schemaVersion: "1.0", site: { schemaVersion: "1.0", siteId: "shop", startUrl: "https://shop.example/", merchantOrigin: "https://shop.example", understandingOrigins: [], runtimeExternalOrigins: [], createdAt: "2026-01-01T00:00:00Z" },
      observations: [], evidence: [{ id: "e", observationId: "obs", url: "https://shop.example/", kind: "accessible-control", summary: "button", locator: { selector: "#button" } }], pageFamilies: [{ id: "home", label: "Home", origin: "https://shop.example", pathPattern: "/", queryRules: {}, examples: ["https://shop.example/"], counterexamples: [], observationIds: ["obs"], confidence: 1, status: "reviewed" }], transitions: [],
      actions: [{ id: "draft", name: "draft", description: "Draft action", pageFamilyIds: ["home"], mode: "read", inputSchema: {}, inputBindings: [], targetEvidenceIds: ["e"], locators: [{ strategy: "id", selector: "#button", evidenceId: "e", uniqueInObservation: true }], preconditions: [], postconditions: [], risk: "low", confidence: 1, status: "approved" }], semanticSources: [], validations: [], exploration: { status: "partial", stopReason: "budget", visitedCount: 1, estimatedCoverage: 0.5, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    const compiled = compilePackage(model);
    expect(compiled.files.find((file) => file.path === "page-families/home.js")?.contents).not.toContain("name: \"draft\"");
  });

  it("omits semantic documents and lookup tools when a family has no useful source material", () => {
    const family = { id: "home", label: "Home", origin: "https://shop.example", pathPattern: "/", queryRules: {}, examples: ["https://shop.example/"], counterexamples: [], observationIds: ["obs"], confidence: 1, status: "reviewed" as const };
    expect(generateSemanticDocuments([family], [], [])).toEqual(new Map());
    expect(generateSemanticDocuments([family], [{ id: "empty", pageFamilyId: "home", kind: "summary", heading: "Blank", content: "  ", sourceUrl: "https://shop.example/", evidenceIds: [] }], [])).toEqual(new Map());
  });
});
