# Tasks

## 1. Project foundation and contracts

- [x] 1.1 Establish the greenfield TypeScript project layout for the local site-understanding CLI, browser observer, shared site model, package compiler, and tests; verify clean install, typecheck, and test commands run from the repository root.
- [x] 1.2 Define and document versioned schemas for site identity/origin policy, observations, page families, state transitions, candidate actions, semantic sources, validation results, and generated-package metadata; verify valid and invalid fixtures with schema tests.
- [x] 1.3 Define URL normalization and page-family matching rules that preserve meaningful path/query dimensions and remove only known tracking parameters; verify matching and non-matching held-out URL fixtures.
- [x] 1.4 Define local run configuration for finite page, interaction, time, and origin budgets, with defaults and command-line overrides; verify invalid or excessive values are rejected and reported clearly.

## 2. Bounded browser observation and site understanding

- [x] 2.1 Implement a browser observer that captures URL, rendered DOM structure, accessible role/name data when available, visible text, relevant forms/controls, and optional screenshots without assuming AOM availability; verify capture fixtures with and without accessible metadata.
- [x] 2.2 Implement same-origin candidate discovery from the start page, rendered links/forms, and optional sitemap/robots hints; verify external origins are excluded unless explicitly allowlisted and blocked pages are recorded.
- [x] 2.3 Implement observed page/state graph storage and deduplication using URL normalization plus structural and interaction evidence; verify variable product/query values cluster while materially different states remain separate.
- [x] 2.4 Implement the bounded exploration loop with a deterministic frontier policy interface, finite budgets, stop reasons, and traceable selected-frontier explanations; verify the loop stops at every budget and reports unvisited candidates.
- [x] 2.5 Connect the local Codex/agent reasoning workflow to propose page-family labels, candidate actions, semantic summaries, and next-observation rankings from compact evidence; verify structured outputs are schema-checked and unsupported claims remain hypotheses.
- [x] 2.6 Implement evidence-linked locator candidates, action preconditions/postconditions, confidence, and unresolved ambiguity states; verify ambiguous or unsupported targets are excluded from the executable action inventory.
- [x] 2.7 Generate source-linked compact Markdown/text semantic documents for page content and action meaning, distinguishing observed facts from summaries; verify every material section has source references.
- [x] 2.8 Exclude authentication and credential workflows from observations and candidate actions; verify the run records a deferred boundary and stops before credential entry or authenticated-area exploration.
- [x] 2.9 Produce a site-understanding report containing page families, observations, candidate actions, confidence, coverage estimate, unvisited frontier, external-origin access, and block/stop reasons; verify report fixtures include partial and blocked runs.

## 3. WebMCP package generation

- [x] 3.1 Define the generated package layout and metadata for bootstrap, shared runtime, page-family modules, semantic documents, provenance, and merchant instructions; verify a sample build contains every declared file and reproducible version metadata.
- [x] 3.2 Implement page-family URL dispatch and exact merchant-origin enforcement in the runtime loader; verify unsupported paths and unrelated origins register no tools.
- [x] 3.3 Implement direct registration through the supported Chrome WebMCP API, including unavailable-API diagnostics and duplicate-registration handling; verify registration with protocol test doubles and a Chrome smoke test.
- [x] 3.4 Compile reviewed candidate actions into deterministic read, preview, and live-write handlers with bounded asynchronous waits and observable postcondition checks; verify read/preview never submit writes and click-only outcomes remain unconfirmed.
- [x] 3.5 Implement source-linked semantic lookup tools that read only packaged semantic assets and omit empty helpers; verify lookup returns relevant source references without network or page mutations.
- [x] 3.6 Enforce separation between understanding-stage temporary origins and runtime external-origin allowlists; verify a temporary observation origin is excluded until separately approved in package metadata.
- [x] 3.7 Generate complete self-hosted bundle instructions and merchant header script configuration; verify files run when served from a local static server.
- [ ] 3.8 Publish immutable, versioned package assets through platform static hosting without an action-execution endpoint; verify hosted and downloaded bundles have equivalent content and integrity metadata.
- [x] 3.9 Generate a package review report linking each tool to its evidence, risk classification, validation result, and unresolved limitations; verify unresolved or unvalidated candidates cannot appear as ready-to-publish tools.

## 4. Demo evaluation and release checks

- [x] 4.1 Run ordinary-page discovery on `https://grundig-bike.com/` and `https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/`; verify reports show no reuse of the sites' existing WebMCP tool definitions.
- [x] 4.2 Run the same bounded workflow on `https://phiphipirate.com/en` and `https://www.cariboucoffee.com/`; verify any access challenge or instability is recorded as blocked/partial without bypass.
- [x] 4.3 Exercise the end-to-end local workflow from origin input through site report, merchant review artifact, package build, and browser validation; verify a supported page registers only its relevant tools and a non-matching page registers none.
- [x] 4.4 Verify representative read, preview, and live-write flows against observable postconditions in controlled demo states; verify results distinguish confirmed, unconfirmed, and failed outcomes.
- [x] 4.5 Document the tested Chrome/WebMCP API revision, local Codex/agent prerequisites, package hosting choices, known demo coverage, and deferred authentication scope; verify docs match the CLI and generated merchant instructions.
