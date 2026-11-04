/**
 * Deterministic compiler from reviewed site models into static WebMCP bundles.
 * It emits browser modules, per-family semantics, provenance, and publication
 * manifests; runtime action execution remains in the merchant document.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateAction, SiteModel } from "../model/schema.js";
import { generateSemanticDocuments } from "../site-understanding/semantics.js";
import { renderPackageReview } from "../site-understanding/report.js";

export interface PackageFile { path: string; contents: string; }
export interface CompiledPackage { packageId: string; version: string; files: PackageFile[]; }

/** Return a stable digest used by hosted and self-hosted integrity checks. */
function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function safeTool(action: CandidateAction, evidenceIds: Set<string>, validatedIds: Set<string>): boolean {
  return ["approved", "validated"].includes(action.status)
    && validatedIds.has(action.id)
    && action.targetEvidenceIds.length > 0
    && action.targetEvidenceIds.every((id) => evidenceIds.has(id))
    && action.locators.length > 0
    && action.locators.every((locator) => evidenceIds.has(locator.evidenceId)
      && action.targetEvidenceIds.includes(locator.evidenceId)
      && locator.uniqueInObservation)
    && (action.inputBindings ?? []).every((binding) => evidenceIds.has(binding.evidenceId)
      && action.targetEvidenceIds.includes(binding.evidenceId)
      && binding.uniqueInObservation)
    && (() => {
      const properties = action.inputSchema.properties;
      const names = properties && typeof properties === "object" && !Array.isArray(properties) ? Object.keys(properties) : [];
      const bindings = action.inputBindings ?? [];
      return names.length === bindings.length && names.every((name) => bindings.some((binding) => binding.property === name));
    })();
}

function moduleSource(familyId: string, actions: CandidateAction[], evidenceIds: Set<string>, validatedIds: Set<string>, semanticDocument?: string): string {
  const entries = actions.filter((action) => action.pageFamilyIds.includes(familyId) && safeTool(action, evidenceIds, validatedIds)).map((action) => {
    const definition = {
      id: action.id,
      name: action.name,
      mode: action.mode,
      locators: (action.locators ?? []).map(({ strategy, selector, role, name }) => ({ strategy, selector, ...(role ? { role } : {}), ...(name ? { name } : {}) })),
      inputBindings: (action.inputBindings ?? []).map(({ property, selector, controlKind, inputType }) => ({ property, selector, controlKind, ...(inputType ? { inputType } : {}) })),
      preconditions: action.preconditions,
      postconditions: action.postconditions,
      waitMs: 1_000,
    };
    return `  { name: ${JSON.stringify(action.name)}, description: ${JSON.stringify(action.description)}, inputSchema: ${JSON.stringify(action.inputSchema)}, execute: (input) => executeAction(document, ${JSON.stringify(definition)}, input) }`;
  });
  const semanticTool = semanticDocument ? `  { name: "site_semantics_lookup", description: "Read packaged semantic information for this page family.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, execute: (input) => semanticLookup(${JSON.stringify(semanticDocument)}, input) }` : "";
  return `/** Generated page-family module. Handlers remain page-local and never call a package server. */\nimport { executeAction, semanticLookup } from "../runtime-helpers.js";\nexport const tools = [\n${[...entries, semanticTool].filter(Boolean).join(",\n")}\n];\n`;
}

/** Emit the browser runtime from source so policy changes cannot depend on string replacement. */
function runtimeHelpersSource(): string {
  return `/** Generated page-local runtime. No network or action-execution service is used. */
const pathMatches = (url, pattern) => {
  const actual = url.pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (expected.at(-1) !== "*" && actual.length !== expected.length) return false;
  return expected.every((part, index) => part === "*" || part.startsWith(":") || part === actual[index]);
};
const trackingParameters = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid"]);
export function matchRuntimeFamily(locationHref, config) {
  const url = new URL(locationHref);
  const allowed = new Set([config.merchantOrigin, ...(config.externalOrigins || [])].map((origin) => new URL(origin).origin));
  if (!allowed.has(url.origin)) return undefined;
  return config.pageFamilies.find((family) => {
    if (url.origin !== new URL(family.origin).origin || !pathMatches(url, family.pathPattern)) return false;
    if (!Object.entries(family.queryRules || {}).every(([key, rule]) => rule !== "required" || url.searchParams.has(key))) return false;
    const relaxedOrigins = new Set((config.relaxedQueryOrigins || []).map((origin) => new URL(origin).origin));
    return relaxedOrigins.has(url.origin) || [...url.searchParams.keys()].every((key) => trackingParameters.has(key.toLowerCase()) || family.queryRules[key] !== undefined);
  })?.id;
}
export async function registerTools(documentLike, tools, familyId) {
  if (!familyId || !tools.length) return familyId ? [] : [{ code: "page-not-covered", message: "Current URL is not covered by the generated package." }];
  const context = documentLike.modelContext;
  if (!context?.registerTool) return [{ code: "webmcp-unavailable", message: "Chrome WebMCP registration API is unavailable on this page." }];
  const state = documentLike.__agentWalkinWebmcpRegistered ||= new Set();
  const diagnostics = [];
  for (const tool of tools) {
    if (state.has(tool.name)) {
      diagnostics.push({ code: "duplicate-registration", message: tool.name + ": already registered on this document." });
      continue;
    }
    state.add(tool.name);
    try { await context.registerTool(tool); }
    catch (error) {
      state.delete(tool.name);
      diagnostics.push({ code: "registration-failed", message: tool.name + ": " + String(error) });
    }
  }
  return diagnostics;
}
const targetFor = (documentLike, definition) => definition.locators.map((locator) => documentLike.querySelector(locator.selector)).find(Boolean);
const conditions = (documentLike, list) => list.every((condition) => condition.startsWith("selector:") ? Boolean(documentLike.querySelector(condition.slice(9))) : condition.startsWith("text:") ? (documentLike.body?.innerText || "").includes(condition.slice(5)) : true);
export async function executeAction(documentLike, definition, input) {
  if (!conditions(documentLike, definition.preconditions)) return { status: "failed", action: definition.name, detail: "A reviewed precondition was not met.", input };
  const values = input && typeof input === "object" ? input : {};
  for (const binding of definition.inputBindings || []) {
    const control = documentLike.querySelector(binding.selector);
    const expectedTag = binding.controlKind === "textarea" ? "TEXTAREA" : binding.controlKind.toUpperCase();
    if (!control || control.tagName !== expectedTag || typeof control.value !== "string" || !(binding.property in values) || (binding.inputType && control.type !== binding.inputType)) return { status: "failed", action: definition.name, detail: "An input control no longer matches its reviewed evidence.", input };
  }
  const target = targetFor(documentLike, definition);
  if (!target) return { status: "failed", action: definition.name, detail: "No reviewed locator matched the current page.", input };
  if (definition.mode === "read") return { status: "confirmed", action: definition.name, detail: target.textContent?.trim() || "Target is present.", input };
  if (definition.mode === "preview") return { status: "confirmed", action: definition.name, detail: "Preview inspected the reviewed target; no live submission was performed.", input };
  if (typeof target.click !== "function") return { status: "failed", action: definition.name, detail: "Reviewed target is not an interactive HTML element.", input };
  for (const binding of definition.inputBindings || []) {
    const control = documentLike.querySelector(binding.selector);
    control.value = String(values[binding.property]);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }
  try {
    target.click();
  } catch (error) {
    return { status: "failed", action: definition.name, detail: "Interaction failed: " + String(error), input };
  }
  const deadline = Date.now() + Math.max(0, Math.min(definition.waitMs || 1000, 10000));
  while (definition.postconditions.length && Date.now() < deadline && !conditions(documentLike, definition.postconditions)) await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  if (!definition.postconditions.length) return { status: "unconfirmed", action: definition.name, detail: "Interaction occurred but no reviewed postcondition was available.", input };
  const confirmed = conditions(documentLike, definition.postconditions);
  return { status: confirmed ? "confirmed" : "unconfirmed", action: definition.name, detail: confirmed ? "Observed postconditions matched." : "Interaction occurred but no reviewed postcondition was observed.", input };
}
export function semanticLookup(documentText, input) {
  const query = typeof input === "object" && input && typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { status: "confirmed", query, content: documentText };
  const terms = query.toLowerCase().split(" ").filter(Boolean);
  const sections = documentText.split(/(?=^## )/m);
  const matches = sections.filter((section) => terms.some((term) => section.toLowerCase().includes(term)));
  return { status: "confirmed", query, content: (matches.length ? matches : sections.slice(0, 1)).join(String.fromCharCode(10)).trim() };
}
`;
}

/** Compile only approved/validated actions; hypotheses and unresolved candidates remain in review artifacts. */
export function compilePackage(model: SiteModel, version = "0.1.0"): CompiledPackage {
  const packageId = `${model.site.siteId}-webmcp`;
  const evidenceIds = new Set(model.evidence.map((item) => item.id));
  const validatedIds = new Set(model.validations.filter((item) => item.status === "passed").map((item) => item.toolId));
  const files: PackageFile[] = [
    { path: "config.json", contents: JSON.stringify({ packageId, version, merchantOrigin: model.site.merchantOrigin, externalOrigins: model.site.runtimeExternalOrigins, relaxedQueryOrigins: model.site.relaxedQueryOrigins ?? [], pageFamilies: model.pageFamilies.map(({ id, origin, pathPattern, queryRules }) => ({ id, origin, pathPattern, queryRules })) }, null, 2) + "\n" },
    { path: "bootstrap.js", contents: `/** Generated header entry point. It executes only on an explicitly approved origin. */\nimport { matchRuntimeFamily, registerTools } from "./runtime-helpers.js";\nconst config = ${JSON.stringify({ packageId, version, merchantOrigin: model.site.merchantOrigin, externalOrigins: model.site.runtimeExternalOrigins, relaxedQueryOrigins: model.site.relaxedQueryOrigins ?? [], pageFamilies: model.pageFamilies.map(({ id, origin, pathPattern, queryRules }) => ({ id, origin, pathPattern, queryRules })) })};\nconst familyId = matchRuntimeFamily(location.href, config);\nif (familyId) {\n  const module = await import(\`./page-families/\${familyId}.js\`);\n  const diagnostics = await registerTools(document, module.tools, familyId);\n  for (const item of diagnostics) console.warn("[WebMCP package]", item.code, item.message);\n} else {\n  console.info("[WebMCP package] This page is outside the reviewed package scope.");\n}\n` },
    { path: "runtime.js", contents: `/** Generated WebMCP runtime for ${model.site.merchantOrigin}. */\nexport { matchRuntimeFamily, registerTools, executeAction } from "./runtime-helpers.js";\n` },
    { path: "runtime-helpers.js", contents: runtimeHelpersSource() },
    { path: "hosting.json", contents: JSON.stringify({ packageId, version, delivery: "static-assets-only", suggestedVersionedPath: `/webmcp/${packageId}/${version}/`, actionExecutionEndpoint: null, requiredMerchantInjection: "type=module" }, null, 2) + "\n" },
    { path: "merchant-integration.md", contents: `# Merchant integration\n\nThis package registers browser WebMCP tools on ${model.site.merchantOrigin}. Handlers run in the merchant page. The package host serves files only and never receives action calls.\n\n## Self-hosted files\n\nUpload the complete package directory to a static host that serves JavaScript modules and JSON files with appropriate content types. Keep the relative directory structure intact. Add this tag to the merchant site's page header, replacing the URL with the deployed bootstrap path:\n\n\`\`\`html\n<script type="module" src="/webmcp/${packageId}/${version}/bootstrap.js"></script>\n\`\`\`\n\n## Platform-hosted files\n\nUpload the same immutable file set under the versioned path in \`hosting.json\`, then use the platform asset URL in the same header tag. Pin the version in production; changing versions requires a deliberate header update.\n\nThe loader checks the merchant origin or a separately approved runtime external origin, then checks the matching page family's own origin and URL rules. Explicit entries in \`relaxedQueryOrigins\` allow extra query keys on that exact origin while retaining path matching and required query rules. Understanding-stage origins do not gain runtime or URL-relaxation permissions automatically. An unsupported page registers no page-specific tools. A browser without the experimental WebMCP API reports a compatibility diagnostic.\n\n## Review and limitations\n\nReview \`package-review.md\` and \`provenance.json\` before installation. Only actions with passing validation, reviewed evidence, and evidence-linked locators are included as executable tools. Login and credential flows are deferred.\n` },
    { path: "provenance.json", contents: JSON.stringify({ sourceSite: model.site.siteId, evidenceCount: model.evidence.length, generatedFromSchema: model.schemaVersion }, null, 2) + "\n" },
    { path: "package-review.md", contents: renderPackageReview(model) },
  ];
  const evidenceSourceUrls = new Map(model.evidence.map((item) => [item.id, item.url]));
  const semanticDocuments = generateSemanticDocuments(model.pageFamilies, model.semanticSources, model.actions, evidenceSourceUrls);
  for (const family of model.pageFamilies) files.push({ path: `page-families/${family.id}.js`, contents: moduleSource(family.id, model.actions, evidenceIds, validatedIds, semanticDocuments.get(family.id)) });
  for (const [familyId, content] of semanticDocuments) files.push({ path: `semantics/${familyId}.md`, contents: content });
  const sortedFiles = files.sort((left, right) => left.path.localeCompare(right.path));
  // Both manifests describe the payload files only, avoiding a circular hash
  // while keeping package contents independently verifiable by either host.
  const payloadHashes = sortedFiles.map((file) => ({ path: file.path, sha256: sha256(file.contents) }));
  sortedFiles.push({
    path: "metadata.json",
    contents: JSON.stringify({ schemaVersion: "1.0", packageId, version, merchantOrigin: model.site.merchantOrigin, externalOrigins: model.site.runtimeExternalOrigins, generatedAt: model.site.createdAt, files: payloadHashes }, null, 2) + "\n",
  });
  // Keep the manifest deterministic. Runtime file hashes are emitted by
  // writePackage after the exact files have been written, avoiding a circular
  // hash over the manifest itself.
  sortedFiles.push({
    path: "manifest.json",
    contents: JSON.stringify({
      schemaVersion: "1.0",
      packageId,
      version,
      merchantOrigin: model.site.merchantOrigin,
      externalOrigins: model.site.runtimeExternalOrigins,
      generatedAt: model.site.createdAt,
      files: payloadHashes,
    }, null, 2) + "\n",
  });
  return { packageId, version, files: sortedFiles };
}

/** Write a package and immutable SHA-256 metadata without introducing an action endpoint. */
export async function writePackage(compiled: CompiledPackage, directory: string): Promise<void> {
  for (const file of compiled.files) {
    const target = join(directory, file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.contents, "utf8");
  }
}
