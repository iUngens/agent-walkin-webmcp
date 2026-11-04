/** Playwright fixtures verify the observer handles pages with and without explicit accessible metadata. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { capturePage, sameOriginCandidates } from "../src/site-understanding/browser-observer.js";
import { chromiumLaunchOptions } from "../src/site-understanding/browser-runtime.js";
import { discoverCandidates } from "../src/site-understanding/discovery.js";

describe("rendered page observer", () => {
  let browser: Browser;
  let page: Page;
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><html><body></body></html>"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch(chromiumLaunchOptions());
    page = await browser.newPage();
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve())); });

  it("captures visible controls and fallback names when the page has no AOM hints", async () => {
    await page.goto(`${baseUrl}/catalog`);
    await page.setContent('<title>Catalog</title><main><h1>Bike</h1><button>Add to cart</button><a href="https://shop.example/about">About</a></main>');
    const observation = await capturePage(page);
    expect(observation.status).toBe("observed");
    expect(observation.visibleText).toContain("Bike");
    expect(observation.controls.some((control) => control.kind === "button" && control.text === "Add to cart")).toBe(true);
    expect(observation.controls.some((control) => control.kind === "link" && control.href === "https://shop.example/about")).toBe(true);
  });

  it("retains available labels and roles, while deferring credential pages", async () => {
    await page.goto(`${baseUrl}/login`);
    await page.setContent('<main><button role="button" aria-label="Continue shopping">Go</button><label for="email">Email</label><input id="email" type="email"><input type="password"></main>');
    const observation = await capturePage(page);
    expect(observation.status).toBe("deferred-auth");
    expect(observation.controls).toEqual([]);
    expect(sameOriginCandidates(observation, [`${baseUrl}/next`, "https://elsewhere.example/"], [])).toEqual([`${baseUrl}/next`]);
  });

  it("serializes page evaluation without a transpiler-only helper", async () => {
    await page.goto(`${baseUrl}/portable`);
    await page.setContent('<main><h1>Portable</h1><button id="continue">Continue</button></main>');
    const observation = await capturePage(page);
    expect(observation.status).toBe("observed");
    expect(observation.controls.some((control) => control.selector === "#continue")).toBe(true);
  });

  it("truncates captured text at Unicode code-point boundaries", async () => {
    await page.goto(`${baseUrl}/unicode`);
    await page.setContent(`<main><p>${"a".repeat(19_999)}😀</p></main>`);
    const observation = await capturePage(page);
    expect(observation.visibleText).toHaveLength(20_001);
    expect(observation.visibleText.endsWith("😀")).toBe(true);
    expect(JSON.parse(JSON.stringify(observation)).visibleText).toBe(observation.visibleText);
  });

  it("captures a password control without leaking the value and marks authentication deferred", async () => {
    await page.goto(`${baseUrl}/auth`);
    await page.setContent('<main><label for="secret">Password</label><input id="secret" type="password" value="must-not-leak"></main>');
    const observation = await capturePage(page);
    expect(observation.status).toBe("deferred-auth");
    expect(JSON.stringify(observation)).not.toContain("must-not-leak");
    expect(observation.controls).toEqual([]);
  });

  it("ignores non-HTTP navigation links without invalidating page discovery", async () => {
    await page.goto(`${baseUrl}/links`);
    await page.setContent('<main><a href="mailto:support@example.test">Email support</a><a href="/catalog">Catalog</a></main>');
    const observation = await capturePage(page);
    const result = discoverCandidates(observation, ["mailto:support@example.test", `${baseUrl}/catalog`], baseUrl);
    expect(result.candidates).toEqual([`${baseUrl}/catalog`]);
    expect(result.excluded).toContainEqual({ url: "mailto:support@example.test", reason: "non-HTTP(S) link retained as evidence but excluded from navigation" });
  });

  it("marks browser challenges blocked and prevents them from seeding the frontier", async () => {
    await page.goto(`${baseUrl}/challenge`);
    await page.setContent('<title>Just a moment...</title><main>Checking your browser</main>');
    const observation = await capturePage(page);
    expect(observation.status).toBe("blocked");
    expect(observation.visibleText).toBe("");
    expect(observation.blockedReason).toContain("challenge");
    expect(discoverCandidates(observation, [`${baseUrl}/catalog`], baseUrl).candidates).toEqual([]);
  });

  it("recognizes an empty Cloudflare challenge from its URL token", async () => {
    await page.goto(`${baseUrl}/challenge?__cf_chl_tk=challenge-token`);
    await page.setContent('<title>Just a moment...</title><main></main>');
    const observation = await capturePage(page);

    expect(observation.status).toBe("blocked");
    expect(observation.visibleText).toBe("");
    expect(observation.blockedReason).toContain("challenge");
  });

  it("does not classify a generic challenge-like title as blocked without challenge evidence", async () => {
    await page.goto(`${baseUrl}/ordinary`);
    await page.setContent('<title>Just a moment...</title><main><h1>Product details</h1><button>Add to cart</button></main>');
    const observation = await capturePage(page);
    expect(observation.status).toBe("observed");
    expect(observation.visibleText).toContain("Product details");
  });
});
