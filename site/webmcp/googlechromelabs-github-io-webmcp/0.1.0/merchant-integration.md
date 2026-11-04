# Merchant integration

This package registers browser WebMCP tools on https://googlechromelabs.github.io. Handlers run in the merchant page. The package host serves files only and never receives action calls.

## Self-hosted files

Upload the complete package directory to a static host that serves JavaScript modules and JSON files with appropriate content types. Keep the relative directory structure intact. Add this tag to the merchant site's page header, replacing the URL with the deployed bootstrap path:

```html
<script type="module" src="/webmcp/googlechromelabs-github-io-webmcp/0.1.0/bootstrap.js"></script>
```

## Platform-hosted files

Upload the same immutable file set under the versioned path in `hosting.json`, then use the platform asset URL in the same header tag. Pin the version in production; changing versions requires a deliberate header update.

The loader checks the merchant origin or a separately approved runtime external origin, then checks the matching page family's own origin and URL rules. Explicit entries in `relaxedQueryOrigins` allow extra query keys on that exact origin while retaining path matching and required query rules. Understanding-stage origins do not gain runtime or URL-relaxation permissions automatically. An unsupported page registers no page-specific tools. A browser without the experimental WebMCP API reports a compatibility diagnostic.

## Review and limitations

Review `package-review.md` and `provenance.json` before installation. Only actions with passing validation, reviewed evidence, and evidence-linked locators are included as executable tools. Login and credential flows are deferred.
