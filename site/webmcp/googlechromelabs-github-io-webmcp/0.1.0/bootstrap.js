/** Generated header entry point. It executes only on an explicitly approved origin. */
import { matchRuntimeFamily, registerTools } from "./runtime-helpers.js";
const config = {"packageId":"googlechromelabs-github-io-webmcp","version":"0.1.0","merchantOrigin":"https://googlechromelabs.github.io","externalOrigins":[],"relaxedQueryOrigins":[],"pageFamilies":[{"id":"family-1","origin":"https://googlechromelabs.github.io","pathPattern":"/webmcp-tools/demos/pizza-maker","queryRules":{}}]};
const familyId = matchRuntimeFamily(location.href, config);
if (familyId) {
  const module = await import(`./page-families/${familyId}.js`);
  const diagnostics = await registerTools(document, module.tools, familyId);
  for (const item of diagnostics) console.warn("[WebMCP package]", item.code, item.message);
} else {
  console.info("[WebMCP package] This page is outside the reviewed package scope.");
}
