/** Generated page-local runtime. No network or action-execution service is used. */
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
