/**
 * Browser-level package smoke test. It serves the exact compiler output from a
 * local static server and supplies a protocol test double for the experimental
 * WebMCP API, so generated dispatch, imports, registration, and diagnostics run
 * in Chromium even when that browser build does not expose document.modelContext.
 */
import type { Server } from "node:http";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { chromiumLaunchOptions } from "../src/site-understanding/browser-runtime.js";
import { compilePackage, writePackage } from "../src/package-generation/compiler.js";
import type { SiteModel } from "../src/model/schema.js";

describe("generated package in Chromium", () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let baseUrl: string;
  let outputDirectory: string;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/products/bike") {
        response.writeHead(200, { "content-type": "text/html" });
        const webmcpSetup = request.headers["x-no-webmcp"] ? "" : `<script>
          window.registrationAttempts = [];
          if (${Boolean(request.headers["x-reject-registration-once"])}) window.rejectRegistrationOnce = true;
          document.modelContext = { async registerTool(tool) {
            window.registrationAttempts.push(tool.name);
            if (window.rejectRegistrationOnce) { window.rejectRegistrationOnce = false; throw new Error("simulated WebMCP denial"); }
            (window.registeredTools ||= []).push(tool.name);
          } };
        </script>`;
        response.end(`<!doctype html><html><body><main><h1 id="price">$1,299</h1>${webmcpSetup}<script type="module" src="/bundle/bootstrap.js"></script></main></body></html>`);
        return;
      }
      if (pathname === "/outside") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><html><body><main><h1>Outside reviewed scope</h1><script type="module" src="/bundle/bootstrap.js"></script></main></body></html>`);
        return;
      }
      const relative = normalize(pathname.replace(/^\/bundle\/?/, ""));
      if (!relative || relative.startsWith("..")) { response.writeHead(404).end(); return; }
      const filePath = join(outputDirectory, relative);
      const contentType = extname(filePath) === ".js" ? "text/javascript" : extname(filePath) === ".json" ? "application/json" : "text/markdown";
      try {
        const contents = await readFile(filePath);
        response.writeHead(200, { "content-type": contentType }).end(contents);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Static package test server did not start");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const model = {
      schemaVersion: "1.0",
      site: { schemaVersion: "1.0", siteId: "smoke-shop", startUrl: `${baseUrl}/products/bike`, merchantOrigin: baseUrl, understandingOrigins: [], runtimeExternalOrigins: [], relaxedQueryOrigins: [baseUrl], createdAt: "2026-01-01T00:00:00Z" },
      observations: [],
      evidence: [{ id: "price-evidence", observationId: "obs", url: `${baseUrl}/products/bike`, kind: "text", summary: "Visible product price", locator: { selector: "#price", uniqueInObservation: true } }],
      pageFamilies: [{ id: "product", label: "Product", origin: baseUrl, pathPattern: "/products/:slug", queryRules: {}, examples: [`${baseUrl}/products/bike`], counterexamples: [], observationIds: ["obs"], confidence: 1, status: "reviewed" }],
      transitions: [],
      actions: [{ id: "read-price", name: "quote:read", description: "Read the visible product price.", pageFamilyIds: ["product"], mode: "read", inputSchema: {}, targetEvidenceIds: ["price-evidence"], locators: [{ strategy: "id", selector: "#price", evidenceId: "price-evidence", uniqueInObservation: true }], preconditions: [], postconditions: [], risk: "low", confidence: 1, status: "approved" }],
      semanticSources: [{ id: "source-price", pageFamilyId: "product", kind: "observed-fact", heading: "Price context", content: "Displayed price is a product price, not an order total.", sourceUrl: `${baseUrl}/products/bike`, evidenceIds: ["price-evidence"] }],
      validations: [{ toolId: "read-price", status: "passed", checkedAt: "2026-01-01T00:00:00Z", details: "Visible target observed." }],
      exploration: { status: "complete-within-budget", stopReason: "frontier-exhausted", visitedCount: 1, estimatedCoverage: 1, unvisitedFrontier: [], authenticationDeferred: true },
    } satisfies SiteModel;
    outputDirectory = await mkdtemp(join(tmpdir(), "webmcp-browser-package-"));
    await writePackage(compilePackage(model), outputDirectory);
    browser = await chromium.launch(chromiumLaunchOptions());
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  });

  it("loads static modules and registers only the matching page-family tools", async () => {
    await page.goto(`${baseUrl}/products/bike`);
    await expect.poll(() => page.evaluate(() => [...((window as Window & { registeredTools?: string[] }).registeredTools ?? [])].sort())).toEqual(["quote:read", "site_semantics_lookup"]);
    await page.goto(`${baseUrl}/outside`);
    await expect.poll(() => page.evaluate(() => (window as Window & { registeredTools?: string[] }).registeredTools ?? [])).toEqual([]);
    await page.goto(`${baseUrl}/products/bike?campaign=spring&variant=blue`);
    await expect.poll(() => page.evaluate(() => [...((window as Window & { registeredTools?: string[] }).registeredTools ?? [])].sort())).toEqual(["quote:read", "site_semantics_lookup"]);
    await page.goto(`${baseUrl}/outside?campaign=spring`);
    await expect.poll(() => page.evaluate(() => (window as Window & { registeredTools?: string[] }).registeredTools ?? [])).toEqual([]);
  });

  it("reports missing WebMCP without installing a substitute", async () => {
    const messages: string[] = [];
    page.on("console", (message) => { if (message.type() === "warning") messages.push(message.text()); });
    await page.setExtraHTTPHeaders({ "x-no-webmcp": "1" });
    await page.goto(`${baseUrl}/products/bike`);
    await page.setExtraHTTPHeaders({});
    await expect.poll(() => messages.some((message) => message.includes("webmcp-unavailable"))).toBe(true);
    expect(await page.evaluate(() => (window as Window & { registeredTools?: string[] }).registeredTools ?? [])).toEqual([]);
  });

  it("reports an asynchronous registration rejection and retries the same tool name", async () => {
    const messages: string[] = [];
    page.on("console", (message) => { if (message.type() === "warning") messages.push(message.text()); });
    await page.setExtraHTTPHeaders({ "x-reject-registration-once": "1" });
    await page.goto(`${baseUrl}/products/bike`);
    await page.setExtraHTTPHeaders({});
    await expect.poll(() => page.evaluate(() => [...((window as Window & { registrationAttempts?: string[] }).registrationAttempts ?? [])].sort())).toEqual(["quote:read", "site_semantics_lookup"]);
    await expect.poll(() => messages.some((message) => message.includes("registration-failed") && message.includes("simulated WebMCP denial"))).toBe(true);

    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const retry = document.createElement("script");
        retry.type = "module";
        retry.src = `/bundle/bootstrap.js?retry=${Date.now()}`;
        retry.onload = () => resolve();
        retry.onerror = () => reject(new Error("Generated bootstrap retry failed to load."));
        document.head.append(retry);
      });
    });

    await expect.poll(() => page.evaluate(() => [...((window as Window & { registeredTools?: string[] }).registeredTools ?? [])].sort())).toEqual(["quote:read", "site_semantics_lookup"]);
    await expect.poll(() => page.evaluate(() => [...((window as Window & { registrationAttempts?: string[] }).registrationAttempts ?? [])].sort())).toEqual(["quote:read", "quote:read", "site_semantics_lookup"]);
  });
});
