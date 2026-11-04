/**
 * Versioned site-model contracts shared by observation, agent review, reporting,
 * and package generation. Keeping one runtime schema here prevents browser
 * evidence and generated executable tools from drifting into different shapes.
 */
import { z } from "zod";

const HttpUrl = z.string().url().refine((value) => /^https?:/.test(value), "URL must use HTTP or HTTPS");
/** Accept an explicitly supplied HTTP(S) URL and store only its canonical origin. */
const Origin = z.string().url().transform((value, context) => {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    context.addIssue({ code: "custom", message: "Origin allowlist entries must be HTTP(S) URLs without credentials." });
    return z.NEVER;
  }
  return parsed.origin;
});

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  observationId: z.string().min(1),
  url: HttpUrl,
  kind: z.enum(["accessible-control", "form", "text", "dom-context", "transition", "screenshot"]),
  summary: z.string().min(1),
  locator: z.object({
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    selector: z.string().optional(),
    uniqueInObservation: z.boolean().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }).optional(),
});

export const SiteIdentitySchema = z.object({
  schemaVersion: z.literal("1.0"),
  siteId: z.string().min(1),
  startUrl: HttpUrl,
  merchantOrigin: Origin,
  understandingOrigins: z.array(Origin).default([]),
  runtimeExternalOrigins: z.array(Origin).default([]),
  /** Exact observed origins whose reviewed page-family rules accept extra query keys. */
  relaxedQueryOrigins: z.array(Origin).default([]),
  createdAt: z.string().datetime(),
});

export const ObservationSchema = z.object({
  id: z.string().min(1),
  url: HttpUrl,
  capturedAt: z.string().datetime(),
  status: z.enum(["observed", "blocked", "failed", "deferred-auth"]),
  title: z.string().default(""),
  visibleText: z.string().default(""),
  /** Compact rendered-DOM evidence used for structural clustering and review. */
  domStructure: z.string().default(""),
  /** Best-effort role/name records; absence is valid because AOM is optional. */
  accessibleNodes: z.array(z.object({
    role: z.string().optional(),
    name: z.string().optional(),
    selector: z.string().optional(),
  })).default([]),
  structureFingerprint: z.string().min(1),
  controls: z.array(z.object({
    kind: z.enum(["link", "button", "input", "select", "textarea", "form"]),
    text: z.string().default(""),
    accessibleRole: z.string().optional(),
    accessibleName: z.string().optional(),
    label: z.string().optional(),
    selector: z.string().optional(),
    /** True only when this selector matched one rendered control at capture time. */
    uniqueInObservation: z.boolean().optional(),
    // Keep non-HTTP links as evidence so reports can explain why mailto:, tel:,
    // and custom-scheme actions were excluded from browser navigation.
    href: z.string().url().optional(),
    inputType: z.string().optional(),
    name: z.string().optional(),
    formAction: HttpUrl.optional(),
    passwordField: z.boolean().default(false),
  })).default([]),
  blockedReason: z.string().optional(),
  screenshotPath: z.string().optional(),
});

export const PageFamilySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Exact site origin hosting this family; external families need separate runtime approval. */
  origin: Origin,
  pathPattern: z.string().min(1),
  queryRules: z.record(z.string(), z.enum(["required", "optional", "ignored"])).default({}),
  examples: z.array(HttpUrl).min(1),
  counterexamples: z.array(HttpUrl).default([]),
  observationIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  status: z.enum(["proposed", "reviewed", "unresolved"]),
});

export const TransitionSchema = z.object({
  id: z.string().min(1),
  fromObservationId: z.string().min(1),
  toObservationId: z.string().optional(),
  triggerEvidenceId: z.string().min(1),
  result: z.enum(["navigated", "state-changed", "no-change", "blocked", "unknown"]),
  summary: z.string(),
});

/** A selector candidate tied to an observed control; unobserved selectors are invalid. */
export const LocatorCandidateSchema = z.object({
  strategy: z.enum(["role-name", "label", "id", "stable-attribute", "css", "text"]),
  selector: z.string().min(1),
  role: z.string().optional(),
  name: z.string().optional(),
  evidenceId: z.string().min(1),
  uniqueInObservation: z.boolean(),
});

/**
 * Bind one WebMCP input property to a unique native field from an observation.
 * The site-model validator resolves `evidenceId` back to its observation and
 * rejects selector, control-kind, or recorded input-type mismatches so guessed
 * fields cannot become executable package inputs.
 */
export const ActionInputBindingSchema = z.object({
  property: z.string().min(1),
  selector: z.string().min(1),
  controlKind: z.enum(["input", "select", "textarea"]),
  inputType: z.string().optional(),
  evidenceId: z.string().min(1),
  uniqueInObservation: z.boolean(),
});

export const CandidateActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  pageFamilyIds: z.array(z.string().min(1)).min(1),
  mode: z.enum(["read", "preview", "live-write"]),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  inputBindings: z.array(ActionInputBindingSchema).default([]),
  targetEvidenceIds: z.array(z.string().min(1)),
  locators: z.array(LocatorCandidateSchema).default([]),
  preconditions: z.array(z.string()).default([]),
  postconditions: z.array(z.string()).default([]),
  risk: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  status: z.enum(["hypothesis", "unresolved", "review-required", "approved", "validated"]),
}).superRefine((action, context) => {
  if (!["hypothesis", "unresolved"].includes(action.status) && action.targetEvidenceIds.length === 0) {
    context.addIssue({ code: "custom", path: ["targetEvidenceIds"], message: "Reviewable or executable actions must cite observed target evidence." });
  }
  const properties = action.inputSchema.properties;
  const inputProperties = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties as Record<string, unknown>) : [];
  const boundProperties = action.inputBindings.map((binding) => binding.property);
  if (new Set(boundProperties).size !== boundProperties.length) {
    context.addIssue({ code: "custom", path: ["inputBindings"], message: "Each action input property may be bound only once." });
  }
  if (inputProperties.some((property) => !boundProperties.includes(property))
    || boundProperties.some((property) => !inputProperties.includes(property))) {
    context.addIssue({ code: "custom", path: ["inputBindings"], message: "Every declared input property must have exactly one observed control binding." });
  }
  for (const [index, binding] of action.inputBindings.entries()) {
    if (!action.targetEvidenceIds.includes(binding.evidenceId) || !binding.uniqueInObservation) {
      context.addIssue({ code: "custom", path: ["inputBindings", index], message: "Input bindings must reference unique observed evidence included by the action." });
    }
  }
});

export const SemanticSourceSchema = z.object({
  id: z.string().min(1),
  pageFamilyId: z.string().min(1),
  sourceUrl: HttpUrl,
  heading: z.string().min(1),
  content: z.string(),
  kind: z.enum(["observed-fact", "summary", "action-semantics"]),
  evidenceIds: z.array(z.string().min(1)).min(1),
});

export const ValidationResultSchema = z.object({
  toolId: z.string().min(1),
  status: z.enum(["passed", "failed", "unconfirmed", "not-run"]),
  checkedAt: z.string().datetime(),
  details: z.string(),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

export const PackageMetadataSchema = z.object({
  schemaVersion: z.literal("1.0"),
  packageId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  merchantOrigin: Origin,
  externalOrigins: z.array(Origin).default([]),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  generatedAt: z.string().datetime(),
  /** Hashes are over the exact generated file contents and make publication immutable. */
  sourceModelSchema: z.literal("1.0").default("1.0"),
});

export const SiteModelSchema = z.object({
  schemaVersion: z.literal("1.0"),
  site: SiteIdentitySchema,
  observations: z.array(ObservationSchema),
  evidence: z.array(EvidenceSchema),
  pageFamilies: z.array(PageFamilySchema),
  transitions: z.array(TransitionSchema),
  actions: z.array(CandidateActionSchema),
  semanticSources: z.array(SemanticSourceSchema),
  validations: z.array(ValidationResultSchema),
  exploration: z.object({
    status: z.enum(["complete-within-budget", "partial", "blocked"]),
    stopReason: z.string(),
    visitedCount: z.number().int().nonnegative(),
    estimatedCoverage: z.number().min(0).max(1),
    unvisitedFrontier: z.array(z.object({ url: HttpUrl, reason: z.string() })),
    authenticationDeferred: z.boolean(),
  }),
}).superRefine((model, context) => {
  const observedOrigins = new Set([model.site.merchantOrigin, ...model.site.understandingOrigins].map((origin) => new URL(origin).origin));
  const evidenceById = new Map(model.evidence.map((item) => [item.id, item]));
  for (const [index, family] of model.pageFamilies.entries()) {
    if (!observedOrigins.has(new URL(family.origin).origin)) {
      context.addIssue({ code: "custom", path: ["pageFamilies", index, "origin"], message: "Page-family origin must be the merchant origin or an explicitly allowed understanding origin." });
    }
  }
  // URL matching may be relaxed for an observed temporary origin or a separately
  // approved runtime origin; runtime execution permission remains independently checked.
  const eligibleRelaxedOrigins = new Set([
    model.site.merchantOrigin,
    ...model.site.understandingOrigins,
    ...model.site.runtimeExternalOrigins,
  ].map((origin) => new URL(origin).origin));
  for (const [index, origin] of model.site.relaxedQueryOrigins.entries()) {
    if (!eligibleRelaxedOrigins.has(new URL(origin).origin)) {
      context.addIssue({ code: "custom", path: ["site", "relaxedQueryOrigins", index], message: "Relaxed-query origins must be the merchant origin, an explicitly allowed understanding origin, or an explicitly approved runtime external origin." });
    }
  }
  for (const [actionIndex, action] of model.actions.entries()) {
    for (const [bindingIndex, binding] of action.inputBindings.entries()) {
      const evidence = evidenceById.get(binding.evidenceId);
      const control = evidence && model.observations
        .find((observation) => observation.id === evidence.observationId)?.controls
        .find((item) => item.selector === binding.selector);
      const compatible = control && control.kind === binding.controlKind
        && (binding.controlKind !== "input" || !binding.inputType || control.inputType === binding.inputType);
      if (!evidence || !control || !compatible || !control.uniqueInObservation) {
        context.addIssue({
          code: "custom",
          path: ["actions", actionIndex, "inputBindings", bindingIndex],
          message: "Input binding must match a unique observed control with the same selector and control type.",
        });
      }
    }
  }
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type CandidateAction = z.infer<typeof CandidateActionSchema>;
export type SiteModel = z.infer<typeof SiteModelSchema>;
export type PageFamily = z.infer<typeof PageFamilySchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type SemanticSource = z.infer<typeof SemanticSourceSchema>;
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;
export type ActionInputBinding = z.infer<typeof ActionInputBindingSchema>;

/** Parse untrusted serialized model data and provide path-aware validation errors. */
export function parseSiteModel(value: unknown): SiteModel {
  return SiteModelSchema.parse(value);
}
