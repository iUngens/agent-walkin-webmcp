# Spec Delta

## Purpose

Defines how a reviewed site model becomes a deployable set of page-aware JavaScript files that register tools directly with browser WebMCP, together with compact semantic documents and validation evidence. It covers both merchant-hosted and platform-hosted static assets while keeping tool execution in the merchant page.

## ADDED Requirements

### Requirement: Generate a multi-file, page-aware WebMCP package
The system MUST compile an approved site model into a versioned package containing shared bootstrap/runtime code, page-family tool modules, package metadata or loading rules, semantic documents, and merchant integration instructions. At runtime the package MUST select tools appropriate to the current page and register them directly through the page's WebMCP API, including awaiting `document.modelContext.registerTool()` where available. A rejected registration MUST produce a diagnostic and MUST NOT be treated as registered. It MUST NOT route action execution through a server-side MCP service, connector, or facade.

#### Scenario: Package is loaded on a supported page
- **WHEN** a merchant installs the generated header script on a page matching a reviewed page-family rule and WebMCP is available
- **THEN** the loader registers only the tools valid for that page family using the page's native WebMCP API

#### Scenario: Package is loaded where WebMCP is unavailable
- **WHEN** the script runs on a page without the required WebMCP registration API
- **THEN** it does not create a substitute connector or execute actions, and exposes a clear compatibility diagnostic

#### Scenario: URL does not match a reviewed page family
- **WHEN** the loader runs on a merchant origin but the current URL does not match any reviewed page family
- **THEN** it registers no page-specific action tools and reports that the page is not covered

### Requirement: Generate semantic documents and bounded semantic tools
The system MUST package compact Markdown or text semantic documents derived from the site model. It MAY generate a small set of page-appropriate WebMCP semantic lookup tools that return relevant packaged text; these tools MUST be read-only, source-linked, and limited to the generated documents.

#### Scenario: Agent requests site meaning
- **WHEN** a semantic lookup tool is available on a supported page and the agent asks about site content or action meaning
- **THEN** the tool returns relevant packaged text with source references and does not make a live network request or perform a site action

#### Scenario: Semantic helper is not needed
- **WHEN** the site model has no useful semantic material for a page family
- **THEN** the package does not add an empty or misleading semantic helper tool for that page

### Requirement: Separate read, preview, and live write actions
The system MUST classify generated tools as read or write and distinguish preview from live state-changing behavior. Read tools MUST NOT mutate site state; preview tools MUST NOT commit the represented business action; live write tools MUST be explicit and accurately describe their effect. A quote/read tool MAY expose order pricing when that pricing is present in the current merchant page state.

#### Scenario: Preview action is invoked
- **WHEN** an agent invokes a preview tool
- **THEN** the handler computes or displays the proposed outcome without submitting a live business action

#### Scenario: Live write action is invoked
- **WHEN** an agent invokes an approved live write tool
- **THEN** the tool description and result clearly identify the requested state change, and the handler reports observed evidence of completion rather than treating a click alone as success

#### Scenario: Order price is available for reading
- **WHEN** the current page exposes an order quote or price
- **THEN** an approved `quote:read` tool may return the visible quote and its currency/context without submitting an order or changing state

### Requirement: Bind package execution to the merchant origin
The system MUST bind each page family to its observed origin and MUST register or execute its tools only when the current origin matches that family and is either the configured merchant origin or explicitly included in the package's runtime external-origin allowlist. Site understanding MAY visit explicitly selected additional origins when needed to understand a linked flow, subject to the finite origin budget. Understanding-stage access MUST NOT silently become runtime permission.

#### Scenario: Package script appears on an unrelated origin
- **WHEN** the package is included by a page whose origin is not the configured merchant origin or an explicitly allowed external origin
- **THEN** the package registers no merchant tools and performs no merchant action

#### Scenario: Understanding used a temporary external origin
- **WHEN** an external origin was accessed only to understand a linked flow
- **THEN** the resulting page family records that origin, while generated runtime configuration excludes it until it is separately reviewed and allowlisted

### Requirement: Keep URL-family matching strict unless explicitly reviewed
Generated runtime MUST reject undeclared query keys by default. The site model MAY list exact merchant, understanding, or runtime-approved external origins in `relaxedQueryOrigins` when observed URLs show that extra query keys do not distinguish page families. This permission MUST apply only to those exact origins, MUST NOT bypass the merchant/runtime external-origin allowlist or page path matching, and MUST preserve required query rules. URL relaxation for an external origin MUST NOT add that origin to `runtimeExternalOrigins`, and runtime approval MUST NOT add it to `relaxedQueryOrigins`.

#### Scenario: A reviewed origin permits dynamic query keys
- **WHEN** a page matches a reviewed family's origin and path and that exact origin is explicitly listed in `relaxedQueryOrigins`
- **THEN** the loader may register that family's tools despite additional query keys, while still enforcing required keys

#### Scenario: URL relaxation encounters a different path or origin
- **WHEN** a URL has extra query keys but does not match a listed origin or the reviewed path rule
- **THEN** the loader registers no tools for that family

### Requirement: Support merchant-hosted and platform-hosted static delivery
The system MUST provide equivalent generated package contents for merchant self-hosting and platform static hosting. Both modes MUST use merchant-controlled header injection, and platform hosting MUST serve versioned static assets without becoming an action-execution intermediary.

#### Scenario: Merchant self-hosts generated files
- **WHEN** the merchant selects self-hosting
- **THEN** the system provides the complete versioned file set and header configuration needed to serve those files from merchant-controlled infrastructure

#### Scenario: Merchant uses platform hosting
- **WHEN** the merchant selects platform hosting
- **THEN** the header integration references versioned static assets on the platform host while tool handlers still execute in the merchant page

### Requirement: Validate package behavior and report limitations
The system MUST validate package generation, URL-to-page-family matching, tool registration, target availability, and observable postconditions against representative observations before marking a tool ready. It MUST provide a reviewable report of validation results, limitations, unresolved actions, and site coverage.

#### Scenario: Action target is missing or ambiguous during validation
- **WHEN** a generated handler cannot uniquely find its target or its preconditions are not met
- **THEN** validation fails that action and the package does not silently substitute a guessed target

#### Scenario: Triggered interaction has no confirmed postcondition
- **WHEN** an action is triggered but the expected state change cannot be observed
- **THEN** the result is reported as unconfirmed or failed rather than successful

#### Scenario: Demo site already exposes WebMCP
- **WHEN** validating `grundig-bike.com` or the Google Chrome Labs pizza-maker demo
- **THEN** discovery uses ordinary rendered content, DOM, and directly observed interactions and does not import, inspect, or reuse the site's existing WebMCP tool definitions

#### Scenario: Demo site is blocked
- **WHEN** `www.cariboucoffee.com` or another demo site blocks automated observation
- **THEN** the report records the block and incomplete validation without bypassing access controls or fabricating results

