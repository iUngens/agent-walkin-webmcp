# Agent Walkin WebMCP

This greenfield TypeScript project turns bounded, evidence-backed observations of a merchant website into reviewable site models and page-aware WebMCP packages. The local CLI coordinates browser observation, agent review, and package compilation; generated runtime files register tools directly in the merchant page.

## Development

Requires Node.js 22 or newer. Run `npm install`, then `npm run typecheck` and `npm test`. `npm run dev -- --help` shows the local CLI once its commands are implemented. Browser observation uses Playwright and a locally installed Chromium browser; it does not read existing page WebMCP tool definitions.

The first release targets Chrome's experimental WebMCP API. Site understanding runs locally through the operator's Codex/agent workflow. Exploration ranks a bounded frontier with deterministic novelty, functionality, uncertainty, cost, and access-risk factors. An agent can reorder only URLs already discovered by the browser workflow; malformed, duplicated, or invented suggestions are ignored, and every omitted candidate remains eligible under deterministic ranking. The CLI writes a merchant-reviewable JSON model and Markdown report before compilation:

```bash
npm run dev -- discover --url https://example.com/ --out artifacts/site.json
npm run dev -- apply-proposal --model artifacts/site.json --proposal artifacts/proposal.json --out artifacts/reviewed-site.json
npm run dev -- compile --model artifacts/reviewed-site.json --out artifacts/package --package-version 0.1.0
npm run dev -- verify-hosted --package artifacts/package --base-url https://cdn.example/webmcp/example-webmcp/0.1.0/
```

`verify-hosted` checks the downloaded package's SHA-256 payload list, then fetches every payload, `metadata.json`, and `manifest.json` from the supplied versioned static URL and compares raw bytes. It is provider-neutral and read-only; publishing remains the responsibility of the selected static host.

The GitHub Pages workflow publishes committed files under `site/` as static assets only. Generated package versions live under `site/webmcp/<packageId>/<version>/`; once a version directory exists in the previous `main` revision, CI rejects changes to any file in that directory. Add a new version directory to publish an update. The Pages workflow does not run actions or receive requests from the merchant page.

`discover` writes a plain site-model JSON file to `--out`, plus `<out>.report.md`, `<out>.agent-input.json`, and `<out>.agent-prompt.md`. The plain model is directly usable by `apply-proposal` and `compile`. Give the prompt and evidence JSON to the local Codex/agent, save its JSON response as `artifacts/proposal.json`, then run `apply-proposal`. The agent can rank only URLs discovered in this run; unsupported, duplicate, and invented frontier entries are rejected, while omitted candidates remain in the deterministic exploration frontier.

Use `--understanding-origin https://payments.example` when a linked page or resource on that origin is needed to understand the merchant flow. Repeat the option for each necessary origin; the default origin budget expands to include those entries. An explicit `--origins` value remains a hard cap, and the finite origin budget supports up to 500 origins. Page families keep their own exact origin. An understanding origin is evidence only and is not copied into the generated runtime allowlist: a family on another origin can register tools only after that origin is separately approved in `runtimeExternalOrigins`. Non-HTTP links are reported as excluded candidates; challenge pages are recorded as blocked and do not count as observed coverage. `--origins`, `--pages`, `--interactions`, and `--seconds` keep discovery finite. The `apply-proposal` command validates local agent output and leaves proposed actions review-required; a merchant must approve and validate them before compilation can emit executable tools.
Use `--runtime-external-origin https://payments.example` only when the merchant approves generated tools on that external origin. This does not add the origin to the understanding crawl allowlist. The two flags can be used together when both kinds of access are needed.

Origin inputs accept an explicit HTTP(S) URL, including a path, query, or fragment, and are stored canonically as the URL's origin (for example, `https://shop.example/catalog?ref=home` becomes `https://shop.example`). Credentials and non-HTTP(S) schemes are rejected. A necessary external origin can be added explicitly for understanding; it remains separate from the runtime external-origin allowlist.

Page-family URL rules are strict by default: only declared query keys match. After reviewing observations that show extra query keys do not change page-family identity (for example, campaign parameters or storefront state), the site model may list that exact merchant, understanding, or runtime-approved external origin in `site.relaxedQueryOrigins`. This is an explicit, origin-wide relaxation for reviewed families on that origin. Extra keys are then accepted only there, while page paths and required query keys remain enforced. URL relaxation does not grant runtime permission; an external origin must also be listed in `runtimeExternalOrigins` before tools can run there.

Action inputs are mapped to observed, unique native controls through `inputBindings`. Every declared WebMCP input property must have exactly one binding, and the site model validator checks the evidence ID, selector, control kind, and observed input type together. Read and preview tools inspect those controls without changing their values; only a live-write handler applies supplied values and dispatches input/change events before its reviewed action.

For a known origin, `discover` can record this review decision directly with `--relaxed-query-origin https://shop.example`. The option accepts an HTTP(S) URL and stores its canonical origin. Each selected origin must be the merchant origin, one explicitly allowed during understanding, or one explicitly approved in `runtimeExternalOrigins`. Repeat the option for multiple origins. This only relaxes undeclared query keys; it never makes a different path or origin match, and it never adds an external origin to the runtime allowlist.

## Project areas

- `src/model`: versioned input/output contracts and validation.
- `src/site-understanding`: URL rules, browser observation, bounded exploration, and reports.
- `src/package-generation`: deterministic package compilation and static delivery artifacts.
- `tests`: contract and behavior tests, including held-out URL examples.
- `docs`: operational and merchant integration guidance.

Authentication workflows are outside the first release. Exploration has finite page, interaction, time, and origin limits. It records blocked access rather than bypassing it.

## Validation notes

The current browser smoke was run with Chrome `156.0.8078.80` and `--enable-experimental-web-platform-features`. It confirmed that `document.modelContext.registerTool()` is present and accepts a minimal tool on a local test page. Browser support remains experimental and version-sensitive; this smoke confirms the API on that tested build, not across Chrome releases or other agents. See [the operating boundary and validation record](docs/operating-boundary.md#browser-validation) for the exact scope and four-site discovery status.
