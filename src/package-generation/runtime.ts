/**
 * Browser-side runtime emitted into generated packages. It binds execution to
 * the reviewed origin and registers directly with Chrome's WebMCP API.
 */
export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

export interface RuntimeLocator { strategy: string; selector: string; role?: string; name?: string; }
export interface RuntimeActionDefinition {
  id: string;
  name: string;
  mode: "read" | "preview" | "live-write";
  locators: RuntimeLocator[];
  inputBindings?: Array<{ property: string; selector: string; controlKind: "input" | "select" | "textarea"; inputType?: string }>;
  preconditions: string[];
  postconditions: string[];
  waitMs?: number;
}

export interface RuntimeConfig {
  merchantOrigin: string;
  externalOrigins: string[];
  relaxedQueryOrigins: string[];
  pageFamilies: Array<{ id: string; origin: string; pathPattern: string; queryRules: Record<string, "required" | "optional" | "ignored"> }>;
}

export interface RegistrationDiagnostic { code: string; message: string; }

/** Query keys removed by URL normalization because they are analytics-only. */
const TRACKING_PARAMETERS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid",
]);

function matchesPath(url: URL, pattern: string): boolean {
  const actual = url.pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (expected.at(-1) !== "*" && actual.length !== expected.length) return false;
  return expected.every((part, index) => part === "*" || part.startsWith(":") || part === actual[index]);
}

/**
 * Find a reviewed family only when the current origin is approved for runtime use.
 * Understanding-stage access alone never grants generated tools permission to run.
 */
export function matchRuntimeFamily(locationHref: string, config: RuntimeConfig): string | undefined {
  const url = new URL(locationHref);
  const allowed = new Set([config.merchantOrigin, ...config.externalOrigins].map((origin) => new URL(origin).origin));
  if (!allowed.has(url.origin)) return undefined;
  const relaxedQueryOrigins = new Set(config.relaxedQueryOrigins.map((origin) => new URL(origin).origin));
  return config.pageFamilies.find((family) => {
    if (url.origin !== new URL(family.origin).origin) return false;
    if (!matchesPath(url, family.pathPattern)) return false;
    for (const [key, rule] of Object.entries(family.queryRules)) {
      if (rule === "required" && !url.searchParams.has(key)) return false;
    }
    // `ignored` means the value is deliberately excluded from family identity;
    // it must therefore remain acceptable at runtime.
    return relaxedQueryOrigins.has(url.origin) || [...url.searchParams.keys()].every((key) =>
      TRACKING_PARAMETERS.has(key.toLowerCase()) || family.queryRules[key] !== undefined);
  })?.id;
}

/**
 * Register tools through the native page API and return diagnostics instead of
 * throwing into the merchant page. Registration is awaited because browser
 * policy failures are reported by rejecting the WebMCP promise. The per-document
 * set reserves names while a registration is pending and releases them on error.
 */
export async function registerTools(documentLike: Document, tools: RuntimeTool[], familyId: string | undefined): Promise<RegistrationDiagnostic[]> {
  if (!familyId || tools.length === 0) return familyId ? [] : [{ code: "page-not-covered", message: "Current URL is not covered by the generated package." }];
  const modelContext = (documentLike as Document & { modelContext?: { registerTool?: (tool: unknown) => void | Promise<void> } }).modelContext;
  if (!modelContext?.registerTool) return [{ code: "webmcp-unavailable", message: "Chrome WebMCP registration API is unavailable on this page." }];
  const diagnostics: RegistrationDiagnostic[] = [];
  const registrationKey = "__agentWalkinWebmcpRegistered";
  const state = (documentLike as Document & { [registrationKey]?: Set<string> })[registrationKey] ?? new Set<string>();
  (documentLike as Document & { [registrationKey]?: Set<string> })[registrationKey] = state;
  for (const tool of tools) {
    if (state.has(tool.name)) {
      diagnostics.push({ code: "duplicate-registration", message: `${tool.name}: already registered on this document.` });
      continue;
    }
    state.add(tool.name);
    try {
      await modelContext.registerTool({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, execute: tool.execute });
    } catch (error) {
      state.delete(tool.name);
      diagnostics.push({ code: "registration-failed", message: `${tool.name}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return diagnostics;
}

function findTarget(documentLike: Document, definition: RuntimeActionDefinition): Element | undefined {
  for (const locator of definition.locators) {
    const candidate = documentLike.querySelector(locator.selector);
    if (candidate) return candidate;
  }
  return undefined;
}

function checkPreconditions(documentLike: Document, conditions: string[]): boolean {
  return conditions.every((condition) => {
    const selector = condition.match(/^selector:(.+)$/)?.[1];
    return selector ? Boolean(documentLike.querySelector(selector)) : true;
  });
}

function checkPostconditions(documentLike: Document, conditions: string[]): boolean {
  return conditions.every((condition) => {
    const selector = condition.match(/^selector:(.+)$/)?.[1];
    const text = condition.match(/^text:(.+)$/)?.[1];
    if (selector) return Boolean(documentLike.querySelector(selector));
    if (text) return (documentLike.body?.innerText ?? "").includes(text);
    return true;
  });
}

/**
 * Execute one reviewed action in the merchant document and classify its result.
 * Read and preview modes never dispatch an interaction. Live writes dispatch
 * only the reviewed target and distinguish an event failure from a missing
 * Input bindings are optional for zero-input tools; when present, the current
 * page controls are rechecked before any mode runs. Read and preview never
 * assign values. A missing postcondition remains unconfirmed because the site may have accepted
 * the action without exposing the expected signal.
 */
export async function executeAction(documentLike: Document, definition: RuntimeActionDefinition, input: unknown): Promise<{ status: "confirmed" | "unconfirmed" | "failed"; action: string; detail: string; input: unknown }> {
  if (!checkPreconditions(documentLike, definition.preconditions)) return { status: "failed", action: definition.name, detail: "A reviewed precondition was not met.", input };
  const values = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const inputBindings = definition.inputBindings ?? [];
  for (const binding of inputBindings) {
    const control = documentLike.querySelector(binding.selector) as (Element & { value?: string; tagName?: string; type?: string }) | null;
    const expectedTag = binding.controlKind === "textarea" ? "TEXTAREA" : binding.controlKind.toUpperCase();
    if (!control || control.tagName !== expectedTag || typeof control.value !== "string" || !(binding.property in values)) {
      return { status: "failed", action: definition.name, detail: `Input control for ${binding.property} is missing or no longer matches reviewed evidence.`, input };
    }
    if (binding.inputType && control.type !== binding.inputType) {
      return { status: "failed", action: definition.name, detail: `Input control type for ${binding.property} changed since review.`, input };
    }
  }
  const target = findTarget(documentLike, definition);
  if (!target) return { status: "failed", action: definition.name, detail: "No reviewed locator matched the current page.", input };
  if (definition.mode === "read") return { status: "confirmed", action: definition.name, detail: target.textContent?.trim() || "Target is present.", input };
  if (definition.mode === "preview") return { status: "confirmed", action: definition.name, detail: "Preview inspected the reviewed target; no live submission was performed.", input };
  // Complete non-mutating capability checks before changing merchant-page state.
  if (typeof (target as Element & { click?: unknown }).click !== "function") return { status: "failed", action: definition.name, detail: "Reviewed target is not an interactive HTML element.", input };
  for (const binding of inputBindings) {
    const control = documentLike.querySelector(binding.selector) as (Element & { value?: string }) | null;
    if (control) {
      control.value = String(values[binding.property]);
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  try {
    (target as Element & { click: () => void }).click();
  } catch (error) {
    return { status: "failed", action: definition.name, detail: `Interaction failed: ${error instanceof Error ? error.message : String(error)}`, input };
  }
  const deadline = Date.now() + Math.max(0, Math.min(definition.waitMs ?? 1_000, 10_000));
  while (definition.postconditions.length > 0 && Date.now() < deadline && !checkPostconditions(documentLike, definition.postconditions)) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
  // A click without an explicitly reviewed postcondition proves only that the
  // browser dispatched the event. It cannot prove a business state change.
  if (definition.postconditions.length === 0) return { status: "unconfirmed", action: definition.name, detail: "Interaction occurred but no reviewed postcondition was available.", input };
  const confirmed = checkPostconditions(documentLike, definition.postconditions);
  return { status: confirmed ? "confirmed" : "unconfirmed", action: definition.name, detail: confirmed ? "Observed postconditions matched." : "Interaction occurred but no reviewed postcondition was observed.", input };
}

/** Read only the compiled semantic asset; this helper never fetches or mutates the page. */
export function semanticLookup(documentText: string, input: unknown): { status: "confirmed"; query: string; content: string } {
  const query = typeof input === "object" && input !== null && "query" in input && typeof (input as { query: unknown }).query === "string"
    ? (input as { query: string }).query.trim() : "";
  if (!query) return { status: "confirmed", query, content: documentText };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const sections = documentText.split(/(?=^## )/m);
  const matches = sections.filter((section) => terms.some((term) => section.toLowerCase().includes(term)));
  return { status: "confirmed", query, content: (matches.length ? matches : sections.slice(0, 1)).join("\n").trim() };
}
