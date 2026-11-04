# Design

## Context

See `proposal.md` for the motivation and scope. This is a greenfield repository with an initialized `spec-driven` OpenSpec and no existing application code or capability specs. The source notes are `/Users/owenyang/iUngens/agent-walkin.md` and `/Users/owenyang/iUngens/market_research.md`; the first describes a single-site-map and selector approach, while the research notes identify website-to-tool and llms.txt products that can inform discovery and content extraction.

The design must support general websites whose URL and state spaces are open-ended. It also must respect browser WebMCP as the execution interface: generated handlers run in the merchant page and register directly with its WebMCP API.

## Goals / Non-Goals

**Goals:**

- Turn bounded browser observations into a reviewable site model that records evidence, confidence, state transitions, and coverage.
- Use an AI-guided exploration loop to choose useful next observations instead of exhaustively crawling URL combinations.
- Compile the reviewed model into a versioned multi-file WebMCP package with page-family-aware tool registration and semantic material.
- Support static package delivery from merchant-controlled hosting or platform hosting, with merchant-controlled header injection in both cases.
- Validate generated behavior on the agreed demo sites and report when access limits prevent meaningful validation.

**Non-Goals:**

- Implementing login, credentials, account recovery, or authenticated site behavior.
- Requiring or adding an MCP server, connector, facade, WeKnora, or agent-commerce runtime.
- Automatically approving uncertain actions, silently repairing selectors, or treating a triggered click as proof of a completed business operation.
- Exhaustively enumerating every URL, product, filter combination, or transient state on a site.

## Decisions

### 1. Separate observation, reasoning, and compilation

The pipeline has four artifacts/stages: (1) browser observations, (2) a normalized site model, (3) a merchant-reviewable action and semantic inventory, and (4) a compiled package plus validation report. Browser observation captures rendered DOM/accessibility information when available, visible text, URL, screenshots where useful, and interaction results. AI reasoning proposes page-family membership, semantic meaning, and candidate actions against those observations. Deterministic validation checks references and targets before compilation. This keeps model guesses distinguishable from facts and makes later re-analysis possible without re-crawling everything.

Alternative considered: ask a model to emit final selectors and JavaScript from a page snapshot in one step. Rejected because it hides evidence, makes failures hard to diagnose, and allows unverified output to become executable.

### 2. Explore a graph of representative pages and states

Represent the site as an observed graph. Nodes are page families plus meaningful UI states; edges are observed navigation or interaction transitions. Initial candidates come from a bounded set of sources such as the start page, same-origin links, sitemap/robots hints when available, and visible forms. Normalize URLs by removing known tracking parameters and clustering variable path/query segments only when rendered structure and interaction evidence support the grouping.

For each observation, derive a frontier of unvisited pages or interactions. Rank each frontier item by expected information gain, uncovered action/content category, uncertainty reduction, estimated observation cost, and policy/access risk. A deterministic budget controller limits total pages, transitions, time, and origins; the AI may rank and explain choices but cannot expand the limits. Stop when the budget is exhausted or the remaining expected value is below a configured threshold. Always emit visited/estimated coverage, frontier remainder, and stop reason.

Alternative considered: sitemap-only crawl, breadth-first crawl, or listing every URL parameter combination. Those approaches either miss client-rendered flows or grow without bound and spend effort on repetitive states.

### 3. Keep the site model evidence-linked and confidence-aware

The intermediate model stores site identity and origin policy, observation records, page-family URL patterns, state and transition records, semantic source snippets, candidate tool definitions, target locators, preconditions, expected postconditions, risk class, and confidence. Each locator candidate includes its evidence provenance and can contain multiple strategies (semantic role/name, form relationship, stable attributes, scoped CSS, and observed interaction evidence). Runtime chooses only a reviewed and validated strategy; it does not self-heal by silently changing stored selectors.

The model distinguishes confirmed observations, AI inferences, merchant decisions, and unresolved hypotheses. Candidate actions with ambiguous targets or unobserved effects remain non-executable. The model should be versioned and serializable so generated package output can be reproduced and compared.

### 4. Treat AI as an exploration planner and interpreter, not an executor

The AI agent receives compact observations and the current graph/model, proposes clusters, labels, candidate actions, and a ranked next frontier item. A policy layer validates every browser operation against the configured origin allowlist and finite budget. A browser worker performs only approved navigation and ordinary UI interaction, records resulting evidence, and returns it for the next reasoning step. Login/credential flows are excluded. Access challenges are recorded as blocked.

This combines crawler repeatability with agent judgment: conventional crawling supplies candidates and captures pages; AI selects representative observations and interprets unfamiliar site structures. It avoids assuming that AOM exists or that a single DOM heuristic works for every site.

### 5. Compile directly to page-local WebMCP modules

The compiler emits a manifest/config file, a small bootstrap/loader, shared runtime helpers, one or more page-family action modules, semantic text/Markdown assets, source maps or provenance metadata, and merchant integration instructions. The loader checks the exact configured origin, matches the current path/query rules, checks WebMCP API availability, then imports only the applicable page-family modules and awaits tool registration through `document.modelContext.registerTool()`. An asynchronously rejected registration is reported and its name is released for a later retry; it is never reported as registered.

Tools are generated from reviewed definitions and use deterministic handlers with explicit preconditions, bounded waits for observed asynchronous transitions, and postcondition checks. Results distinguish performed, confirmed, unconfirmed, and failed. Page-specific `quote:read` may return visible order pricing. Preview tools do not submit a live action. Read and write scopes remain separate. Semantic helpers, when generated, read packaged documents only and remain read-only.

Alternative considered: one large global script with all tools or a server-side action service. A global script exposes irrelevant tools on every page and grows with the site; server-side execution changes the requested WebMCP architecture and moves actions away from the merchant page.

### 6. Separate static hosting from action execution

The same immutable versioned package can be exported as a file bundle or published to platform static hosting. Self-hosting instructions show the complete files and header entry. Platform hosting serves only package assets with versioning and integrity metadata; its host is not contacted to execute tools. The merchant adds the appropriate script tag to page headers in either mode. Hosting origin and merchant site origin are distinct concepts: only the configured merchant origin is allowed to run tools by default, while any cross-origin page that genuinely needs tools must be explicitly reviewed and listed.

### 7. Validate from observed behavior, including pre-existing WebMCP demos

Validation has unit-level checks for model/schema and compiler output, browser checks for URL matching and registration, and action checks against observed preconditions/postconditions. `grundig-bike.com` and the pizza-maker demo are inspected from ordinary rendered content, DOM, and direct UI interaction; existing WebMCP definitions are not used as discovery input. `phiphipirate.com/en` and `www.cariboucoffee.com` receive the same observation workflow. A block or unstable site is a validation result, not a reason to infer missing behavior.

The initial report records what page families were observed, which action candidates were validated, which remain unresolved, environment/WebMCP limitations, and why exploration stopped. It does not make a universal-coverage claim from four demos.

### 8. Fix the first-release operating boundary

The first release targets Chrome's experimental WebMCP API as exercised by the demos, and records the exact tested browser/API revision in validation output. Site understanding runs locally under the operator's configured Codex/agent workflow; browser access and model reasoning stay in that local workflow, with no platform model service required. The first release produces a human-readable review report and package files for approval outside the tool; a hosted merchant review UI is deferred. Keep the observation, reasoning, and package formats independent enough to add other browser APIs or review surfaces later without changing their site-model meaning.

## Risks / Trade-offs

- [A page family can be incorrectly grouped with another] → Preserve examples and counterexamples for each rule, require structural/behavioral evidence, expose confidence, and test route matching against held-out observed URLs.
- [AI may invent an action or target] → Require provenance for every target and keep hypotheses out of executable output until validated and reviewed.
- [Dynamic sites can make actions flaky] → Model preconditions and state transitions, use bounded condition-based waits, verify postconditions, and report unconfirmed results.
- [Sites may block automation or vary by region/session] → Record environment and blocked coverage; do not bypass challenges or claim a complete result.
- [WebMCP APIs may evolve or differ across agent/browser implementations] → Isolate registration behind a small compatibility boundary and test against the protocol/browser versions explicitly supported by the first release.
- [Platform-hosted package URLs introduce availability and supply-chain concerns] → Publish immutable versioned assets with integrity metadata and provide the same bundle for merchant hosting.
- [General-site support cannot mean every site works equally well] → Define the deliverable as evidence-backed coverage and explicit unresolved work, not universal automation success.

## Migration Plan

There is no existing application behavior to migrate. Build the first usable flow as a local project that accepts a site origin, performs bounded observation, exports a reviewable model, compiles a package, and runs validation. Add platform static hosting as a delivery mode over the same immutable package artifact. Rollback for platform delivery means switching the merchant header reference to a prior package version or to merchant-hosted files; generated bundles remain independently downloadable.

## Open Questions

None for the first implementation plan. Broader browser compatibility, hosted model execution, and an in-product merchant review interface are deferred follow-up decisions.

