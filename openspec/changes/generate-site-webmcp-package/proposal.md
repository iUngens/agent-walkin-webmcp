# Proposal

## Why

Independent websites expose useful content and actions through page-specific interfaces, but agents cannot reliably understand or operate those interfaces from ordinary HTML alone. This project will provide a general tool that observes a merchant site, organizes its page families and candidate actions, then produces a reviewable, multi-file WebMCP package and compact semantic documents that the merchant can inject into page headers.

## What Changes

- Add a bounded, AI-assisted site-understanding workflow that samples representative pages and states, groups them into page families, identifies candidate actions and semantic content, and reports coverage, uncertainty, and blocked areas without claiming exhaustive URL coverage.
- Add a structured intermediate site model that separates observations, evidence, confidence, page-family rules, action definitions, and semantic documents from generated runtime files.
- Add a WebMCP package generator that produces page-aware JavaScript modules calling the page's `document.modelContext.registerTool()` API, plus compact semantic documents and deployment instructions.
- Support both merchant-hosted static package files and platform-hosted static files; both deployment modes require merchant-controlled header script injection.
- Require site-origin binding and explicit external-origin allowlists, distinguish preview from live write actions, keep read and write scopes separate, and report observed evidence rather than treating a triggered click as confirmed business success.
- Validate generated packages against the four agreed demo sites. Inspect the first two sites from ordinary page content and interactions without importing their existing WebMCP tool definitions.
- Defer authentication and login behavior for separate research. Do not add an MCP server, connector/facade, WeKnora dependency, agent-commerce runtime, or alert delivery workflow.

## Capabilities

### New Capabilities
- `site-understanding`: Bounded, evidence-based discovery of page families, states, content, and candidate actions for general websites.
- `webmcp-package-generation`: Compilation and validation of multi-file, page-aware WebMCP JavaScript packages and their semantic documents for merchant-hosted or platform-hosted delivery.

### Modified Capabilities

None.

## Impact

- Greenfield repository; no existing product code or capability specs are present.
- Planned areas include a site observer/browser automation layer, an AI-assisted exploration and evidence model, a package compiler, static package hosting, and demo/evaluation fixtures.
- Merchant-facing integration uses header-injected JavaScript that registers tools directly with the browser's WebMCP API. Platform hosting serves static generated assets and does not execute actions on behalf of the browser.
- Demo targets: `https://grundig-bike.com/`, `https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/`, `https://phiphipirate.com/en`, and `https://www.cariboucoffee.com/`.
