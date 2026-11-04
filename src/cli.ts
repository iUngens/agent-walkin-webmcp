/** Local CLI entry point. Commands intentionally produce review artifacts before any package publish step. */
import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { parseBudgetOverrides, DEFAULT_BUDGETS } from "./site-understanding/budgets.js";
import { chromiumLaunchOptions } from "./site-understanding/browser-runtime.js";
import { capturePage, sameOriginCandidates } from "./site-understanding/browser-observer.js";
import { evidenceFromObservations } from "./site-understanding/action-evidence.js";
import { clusterPageFamilies } from "./site-understanding/graph.js";
import { parseSiteModel } from "./model/schema.js";
import { compilePackage, writePackage } from "./package-generation/compiler.js";
import { renderSiteUnderstandingReport } from "./site-understanding/report.js";
import { discoverCandidates } from "./site-understanding/discovery.js";
import { fetchSitemapHints } from "./site-understanding/discovery.js";
import { explore, type ObservationCandidate } from "./site-understanding/explorer.js";
import { AgentProposalSchema, buildReasoningInput, proposalActions, proposalSemantics, renderAgentPrompt, validateProposalReferences } from "./site-understanding/agent-reasoning.js";
import { resolveActionEvidence } from "./site-understanding/action-evidence.js";
import { verifyHostedPackage } from "./package-generation/hosting.js";

const program = new Command();
program.name("agent-walkin-webmcp").description("Bounded site understanding and direct WebMCP package generation").version("0.1.0");
program.command("budget").description("Validate finite exploration limits").option("--pages <number>").option("--interactions <number>").option("--seconds <number>").option("--origins <number>").action((options) => {
  const budget = parseBudgetOverrides({ maxPages: options.pages, maxInteractions: options.interactions, maxDurationSeconds: options.seconds, maxOrigins: options.origins });
  process.stdout.write(`${JSON.stringify(budget, null, 2)}\n`);
});
program.command("compile").description("Compile a reviewed site model into a static WebMCP package")
  .requiredOption("--model <path>", "Path to a reviewed site-model JSON file")
  .requiredOption("--out <directory>", "Output directory")
  .option("--package-version <semver>", "Generated package version", "0.1.0")
  .action(async (options) => {
    const model = parseSiteModel(JSON.parse(await readFile(options.model, "utf8")));
    const compiled = compilePackage(model, options.packageVersion);
    await writePackage(compiled, options.out);
    process.stdout.write(`${JSON.stringify({ packageId: compiled.packageId, version: compiled.version, files: compiled.files.map((file) => file.path) }, null, 2)}\n`);
  });

program.command("verify-hosted").description("Compare published static package assets with a downloaded package")
  .requiredOption("--package <directory>", "Downloaded generated package directory")
  .requiredOption("--base-url <url>", "Versioned static package URL, for example https://cdn.example/webmcp/shop-webmcp/1.0.0/")
  .action(async (options) => {
    const result = await verifyHostedPackage(options.package, options.baseUrl);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program.command("apply-proposal").description("Apply a schema-checked local agent proposal to a site model for merchant review")
  .requiredOption("--model <path>", "Input site-model JSON path")
  .requiredOption("--proposal <path>", "Agent proposal JSON path")
  .requiredOption("--out <path>", "Output site-model JSON path")
  .action(async (options) => {
    const model = parseSiteModel(JSON.parse(await readFile(options.model, "utf8")));
    const proposal = AgentProposalSchema.parse(JSON.parse(await readFile(options.proposal, "utf8")));
    const frontier = model.exploration.unvisitedFrontier.map((item) => ({
      ...item, novelty: 0.5, uncoveredFunctionality: 0.5, uncertaintyReduction: 0.5, cost: 0.25, accessRisk: 0,
    }));
    const checked = validateProposalReferences(proposal, model.observations, model.pageFamilies, frontier);
    const familyIds = model.pageFamilies.map((family) => family.id);
    const proposedFamilies = model.pageFamilies.map((family) => {
      const update = checked.proposal.pageFamilies.find((item) => item.id === family.id);
      return update ? { ...family, label: update.label, pathPattern: update.pathPattern, confidence: update.confidence, status: "proposed" as const } : family;
    });
    const proposedActions = resolveActionEvidence(proposalActions(checked.proposal, familyIds).map((action) => {
      const proposed = checked.proposal.actions.find((item) => item.id === action.id);
      const hasInvalidReference = proposed?.pageFamilyIds.some((id) => !familyIds.includes(id)) || proposed?.evidenceIds.some((id) => !model.evidence.some((evidence) => evidence.id === id));
      return hasInvalidReference ? { ...action, status: "unresolved" } : action;
    }), model.evidence);
    const mergedActions = [...model.actions.filter((existing) => !proposedActions.some((item) => item.id === existing.id)), ...proposedActions];
    const mergedSemantics = [...model.semanticSources, ...proposalSemantics(checked.proposal, model.observations, model.evidence)];
    const updated = parseSiteModel({ ...model, pageFamilies: proposedFamilies, actions: mergedActions, semanticSources: mergedSemantics });
    await writeFile(options.out, JSON.stringify(updated, null, 2) + "\n", "utf8");
    process.stdout.write(`${JSON.stringify({ out: options.out, actions: proposedActions.length, semanticSources: mergedSemantics.length, referenceIssues: checked.issues, status: "review-required" }, null, 2)}\n`);
  });

program.command("discover").description("Capture one ordinary page and write a reviewable site-understanding artifact")
  .requiredOption("--url <url>", "Merchant start URL")
  .requiredOption("--out <path>", "Output JSON path")
  .option("--agent-input <path>", "Compact evidence JSON path (defaults to <out>.agent-input.json)")
  .option("--agent-prompt <path>", "Local agent prompt path (defaults to <out>.agent-prompt.md)")
  .option("--screenshot-dir <directory>", "Optional screenshot directory")
  .option("--pages <number>", "Maximum pages to observe", String(DEFAULT_BUDGETS.maxPages))
  .option("--interactions <number>", "Maximum interactions", String(DEFAULT_BUDGETS.maxInteractions))
  .option("--seconds <number>", "Maximum duration in seconds", String(DEFAULT_BUDGETS.maxDurationSeconds))
  .option("--origins <number>", "Maximum origins visited (defaults to merchant origin plus explicitly allowed understanding origins)")
  .option("--understanding-origin <origin>", "Temporary origin allowed only during understanding", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--runtime-external-origin <origin>", "Merchant-approved external origin where generated tools may run", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--relaxed-query-origin <origin>", "Allow unmodeled query keys at this exact merchant, understanding, or runtime-approved external origin", (value: string, previous: string[] = []) => [...previous, value], [])
  .action(async (options) => {
    const startUrl = new URL(options.url);
    const understandingOrigins = (options.understandingOrigin as string[]).map((origin) => new URL(origin).origin);
    const runtimeExternalOrigins = (options.runtimeExternalOrigin as string[]).map((origin) => new URL(origin).origin);
    const relaxedQueryOrigins = (options.relaxedQueryOrigin as string[]).map((origin) => new URL(origin).origin);
    const budget = parseBudgetOverrides({
      maxPages: options.pages,
      maxInteractions: options.interactions,
      maxDurationSeconds: options.seconds,
      maxOrigins: options.origins ?? Math.max(DEFAULT_BUDGETS.maxOrigins, 1 + understandingOrigins.length),
    });
    const { chromium } = await import("playwright");
    const browser = await chromium.launch(chromiumLaunchOptions());
    const page = await browser.newPage();
    const observations = [] as import("./model/schema.js").Observation[];
    let initialLinks: string[] = [];
    let initialObservation: import("./model/schema.js").Observation;
    try {
      await page.goto(startUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      initialObservation = await capturePage(page, options.screenshotDir ? { screenshot: true, artifactDirectory: options.screenshotDir } : {});
      initialLinks = await page.locator("a[href]").evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href));
    } catch (error) {
      initialObservation = { id: "failed-start", url: page.url() || startUrl.toString(), capturedAt: new Date().toISOString(), status: "failed" as const, title: "", visibleText: "", domStructure: "", accessibleNodes: [], structureFingerprint: "failed", controls: [], blockedReason: error instanceof Error ? error.message : String(error) };
    } finally {
      await page.goto("about:blank").catch(() => undefined);
    }
    const sitemapHints = await fetchSitemapHints(startUrl.origin);
    const initialDiscovery = discoverCandidates(initialObservation, initialLinks, startUrl.origin, understandingOrigins, sitemapHints);
    const seedCandidates: ObservationCandidate[] = initialDiscovery.candidates.map((url, index) => ({ url, origin: new URL(url).origin, reason: index === 0 ? "rendered same-origin navigation" : "rendered same-origin candidate", novelty: 0.7, uncoveredFunctionality: 0.5, uncertaintyReduction: 0.5, cost: 0.2, accessRisk: 0 }));
    seedCandidates.unshift({ url: startUrl.toString(), origin: startUrl.origin, reason: "merchant start page", novelty: 1, uncoveredFunctionality: 1, uncertaintyReduction: 1, cost: 0.1, accessRisk: 0 });
    // Keep the first navigation result, including a block, so the report never
    // hides the failure or spends the page budget retrying the same start URL.
    observations.push(initialObservation);
    const result = await explore({
      observe: async (candidate) => {
        if (candidate.url === startUrl.toString()) return initialObservation;
        await page.goto(candidate.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const observation = await capturePage(page, options.screenshotDir ? { screenshot: true, artifactDirectory: options.screenshotDir } : {});
        return observation;
      },
      discover: async (observation) => {
        await page.goto(observation.url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        const links = await page.locator("a[href]").evaluateAll((elements) => elements.map((element) => (element as HTMLAnchorElement).href)).catch(() => [] as string[]);
        return discoverCandidates(observation, links, startUrl.origin, understandingOrigins).candidates.map((url) => ({ url, origin: new URL(url).origin, reason: "rendered link discovered from observed page", novelty: 0.6, uncoveredFunctionality: 0.5, uncertaintyReduction: 0.4, cost: 0.25, accessRisk: 0 }));
      },
    }, seedCandidates, budget);
    observations.push(...result.observations.filter((observation) => observation.url !== initialObservation.url && !observations.some((existing) => existing.id === observation.id)));
    await browser.close();
    const blockedCount = observations.filter((observation) => observation.status === "blocked").length;
    const observedCount = observations.filter((observation) => observation.status === "observed").length;
    const incompleteCount = observations.length - observedCount;
    const blocked = incompleteCount > 0;
    const onlyBlocked = observedCount === 0 && blockedCount > 0;
    const coverageDenominator = observations.length + result.unvisited.length;
    const model = parseSiteModel({
      schemaVersion: "1.0",
      site: { schemaVersion: "1.0", siteId: startUrl.hostname.replace(/[^a-z0-9]+/gi, "-"), startUrl: startUrl.toString(), merchantOrigin: startUrl.origin, understandingOrigins, runtimeExternalOrigins, relaxedQueryOrigins, createdAt: new Date().toISOString() },
      observations, evidence: evidenceFromObservations(observations), pageFamilies: clusterPageFamilies(observations, startUrl.origin, understandingOrigins), transitions: [], actions: [], semanticSources: [], validations: [],
      exploration: { status: onlyBlocked ? "blocked" : blocked || result.unvisited.length ? "partial" : "complete-within-budget", stopReason: onlyBlocked ? "all-observations-blocked" : result.stopReason, visitedCount: observedCount, estimatedCoverage: coverageDenominator ? observedCount / coverageDenominator : 0, unvisitedFrontier: result.unvisited.map((item) => ({ url: item.url, reason: item.reason })), authenticationDeferred: true },
    });
    const reasoningInput = buildReasoningInput(observations, model.pageFamilies, result.unvisited.map((item) => ({ ...item, novelty: 0.5, uncoveredFunctionality: 0.5, uncertaintyReduction: 0.5, cost: 0.25, accessRisk: 0 })));
    const agentInputPath = options.agentInput ?? `${options.out}.agent-input.json`;
    const agentPromptPath = options.agentPrompt ?? `${options.out}.agent-prompt.md`;
    await writeFile(agentInputPath, JSON.stringify(reasoningInput, null, 2) + "\n", "utf8");
    await writeFile(agentPromptPath, renderAgentPrompt(agentInputPath), "utf8");
    const reportPath = `${options.out}.report.md`;
    await writeFile(options.out, JSON.stringify(model, null, 2) + "\n", "utf8");
    await writeFile(reportPath, `${renderSiteUnderstandingReport(model)}\n## Discovery method\n\nBounded ordinary rendered-page observation; existing WebMCP definitions are not read.\n\n## URL matching policy\n\nExtra query keys are accepted only on these explicitly selected origins: ${relaxedQueryOrigins.length ? relaxedQueryOrigins.join(", ") : "none"}. Required query keys and page paths remain enforced. This matching rule does not grant runtime permission; external origins still require separate approval in the package runtime allowlist.\n\n## Frontier decisions\n\n${result.selected.map((item) => `- ${item.url}: ${item.reason} (score ${item.score.toFixed(3)})`).join("\n") || "No page was selected."}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ out: options.out, report: reportPath, agentInput: agentInputPath, agentPrompt: agentPromptPath, status: model.exploration.status, observedPages: observedCount, blockedPages: blockedCount, unvisited: result.unvisited.length }, null, 2)}\n`);
  });
program.parseAsync().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
