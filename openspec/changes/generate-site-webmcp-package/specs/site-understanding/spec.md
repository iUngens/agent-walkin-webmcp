# Spec Delta

## Purpose

Defines how the system builds a bounded, evidence-backed model of a general website's page families, meaningful states, content, and candidate agent actions. The model makes uncertainty visible so later package generation can be reviewed and tested instead of relying on guessed routes or selectors.

## ADDED Requirements

### Requirement: Bounded representative site exploration
The system MUST explore a site using a configurable finite budget for pages, interactions, time, and external origins. It MUST group observed URLs and states into page families and select new observations based on expected information gain, uncovered functionality, and unresolved uncertainty, rather than attempting to enumerate every possible URL or state combination.

#### Scenario: Many URLs share a page family
- **WHEN** a site exposes many URLs whose changing path or query values produce the same observed layout and interaction structure
- **THEN** the system records a representative page family with URL matching rules and variable dimensions, and does not crawl every value combination

#### Scenario: Exploration budget is reached
- **WHEN** any configured exploration limit is reached while useful frontiers remain
- **THEN** the system stops exploration, records the unvisited frontiers and reason, and reports partial coverage without claiming the site is fully understood

#### Scenario: Agent chooses a next observation
- **WHEN** multiple candidate pages or interactions could be explored next
- **THEN** the system ranks them using current coverage, novelty, action relevance, uncertainty, and cost, and records why the selected observation was useful

### Requirement: Evidence-backed page and action inventory
The system MUST produce a structured inventory of observed page families, state transitions, important content, candidate actions, and navigation rules. Every proposed action target MUST reference observed evidence such as its accessible name and role, associated form or label, DOM context, URL/state, and an observation artifact; unverified guesses MUST be marked as hypotheses and MUST NOT be emitted as ready-to-run actions.

#### Scenario: Candidate action is found
- **WHEN** an observed page exposes an interactive control or form that appears to support a user task
- **THEN** the inventory records its purpose, inputs, target evidence, preconditions, expected page or state change, and confidence for merchant review

#### Scenario: Target evidence is ambiguous
- **WHEN** multiple controls could satisfy the same candidate action and observation does not disambiguate them
- **THEN** the action remains unresolved with the competing evidence and is excluded from the executable action set

#### Scenario: Dynamic page state changes controls
- **WHEN** an interaction causes controls, available values, or page content to change asynchronously
- **THEN** the inventory records the relevant state transition and the conditions under which follow-up controls are available

### Requirement: Origin and access boundaries during understanding
The system MUST treat the merchant's configured origin as the primary crawl boundary. It MUST record and separately allowlist any additional origin that is necessary to understand the site, and MUST report blocked pages or unavailable states without bypassing access controls.

Origin inputs MUST accept an explicit HTTP(S) URL, including a path, query, or fragment, and normalize it to the URL's canonical origin. They MUST reject credentials and non-HTTP(S) schemes. Explicitly allowed understanding origins remain bounded by the configured origin budget; URL path/query details do not create path-scoped permissions because only the canonical origin is stored.

Page-family query matching MUST reject undeclared query keys by default. The site model MAY explicitly list the merchant origin, an allowed understanding origin, or an independently approved runtime external origin in `relaxedQueryOrigins` when observed URLs show additional keys that do not distinguish page families. This permission is origin-wide for matching reviewed families on that origin; it does not relax path matching, and required query keys remain enforced. URL relaxation MUST NOT grant runtime access, and runtime approval MUST NOT imply URL relaxation; an external origin requires separate entries for each permission.

The discovery CLI MUST accept repeated `--relaxed-query-origin` HTTP(S) URL values and store their canonical origins in the reviewable site model. Each selected origin MUST be the merchant origin, an origin separately approved for understanding, or an origin separately approved for runtime. The report MUST display the selected relaxed origins and state that relaxation does not grant runtime access.

#### Scenario: A page links to an external origin
- **WHEN** exploration encounters a relevant page or resource on another origin
- **THEN** the system does not silently treat it as merchant-owned and records whether it was visited under an explicit understanding-stage allowlist entry

#### Scenario: Site denies automated access
- **WHEN** a page is blocked by the site, a challenge, or an access policy
- **THEN** the system records the blocked observation and its effect on coverage without evading the control or reporting success

### Requirement: Semantic content and action meaning are compactly organized
The system MUST extract and organize useful public text and action semantics into compact, source-linked Markdown or text documents suitable for agent consumption. It MUST preserve the source page or page family for each material claim and distinguish observed facts from inferred summaries.

#### Scenario: Public content is summarized
- **WHEN** a page contains useful descriptive or policy content for agent tasks
- **THEN** the semantic document includes a concise summary with a source URL and does not imply that generated prose replaces the source of truth

#### Scenario: Action semantics are documented
- **WHEN** a candidate action is included in the site model
- **THEN** the semantic documents explain what the action does, its inputs, prerequisites, expected effects, and whether it reads, previews, or writes state

### Requirement: Authentication behavior is deferred
The system MUST NOT inspect, automate, or generate tools for login, account recovery, authenticated account areas, or credential entry in this change. It MUST mark such workflows as out of scope when encountered and leave their research and design for a later change.

#### Scenario: Login flow is encountered
- **WHEN** site exploration reaches a login or credential-entry flow
- **THEN** the system records that the flow is deferred and does not enter credentials, continue through the flow, or propose executable authentication actions

