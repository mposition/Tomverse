// Where the running model catalogue and the code disagree about what a user
// gets. Read-only: it writes nothing, anywhere, and exits 0 whatever it finds.
//
// See scripts/report-product-consistency-core.mjs for each rule and why a
// finding is a question rather than a defect.
//
// Usage:
//   npm run report:product-consistency
//   npm run report:product-consistency -- --catalog-url https://staging.tomverse.app/api/models/catalog
//   npm run report:product-consistency -- --catalog-file catalog.json [--json]
//
// The catalogue is the public, unauthenticated `/api/models/catalog` body --
// the same one every guest's browser reads -- so no credential is needed or
// read. The web search register is this checkout's lib/webSearchCapability.ts;
// if the deployed build carries a different register, a finding can be about
// code that is not live yet, so the checkout's commit is printed beside it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getWebSearchCapability, WEB_SEARCH_CAPABILITIES } from "../lib/webSearchCapability.ts";
import { parseCatalogue, productConsistencyReport, RULES } from "./report-product-consistency-core.mjs";

const DEFAULT_CATALOG_URL = "https://tomverse.app/api/models/catalog";
const FETCH_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const value = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const found = args[index + 1];
  if (!found || found.startsWith("--")) {
    console.error(`${flag} needs a value.`);
    process.exit(1);
  }
  return found;
};

const catalogFile = value("--catalog-file");
const catalogUrl = value("--catalog-url");
if (catalogFile && catalogUrl) {
  console.error("Pass --catalog-file or --catalog-url, not both.");
  process.exit(1);
}
const source = catalogFile ?? catalogUrl ?? DEFAULT_CATALOG_URL;
if (!catalogFile && !/^https:\/\/[^/\s]+\/api\/models\/catalog$/.test(source)) {
  console.error("--catalog-url is an https URL ending in /api/models/catalog.");
  process.exit(1);
}

const readCatalogue = async () => {
  if (catalogFile) return JSON.parse(readFileSync(catalogFile, "utf8"));
  const response = await fetch(source, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${source} answered ${response.status}.`);
  }
  return response.json();
};

let raw;
try {
  raw = await readCatalogue();
} catch (error) {
  console.error(`Could not read the catalogue: ${error.message}`);
  process.exit(1);
}
const parsed = parseCatalogue(raw);
if (parsed.problems) {
  console.error(`${source} is not a model catalogue this report can read:`);
  for (const problem of parsed.problems) console.error(`  ${problem}`);
  process.exit(1);
}

const head = spawnSync("git", ["rev-parse", "--short=9", "HEAD"], { encoding: "utf8" });
const checkout = head.status === 0 ? head.stdout.trim() : "unknown";

const report = productConsistencyReport({
  models: parsed.models,
  register: WEB_SEARCH_CAPABILITIES,
  capabilityOf: getWebSearchCapability,
});

if (asJson) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), source, checkout, ...report }, null, 2));
  process.exit(0);
}

const byRule = (rule) => report.findings.filter((finding) => finding.rule === rule);

console.log(`Catalogue: ${source} (${report.catalogue.models} models, ${report.catalogue.enabled} enabled)`);
console.log(`Web search register: this checkout (${checkout})`);

const webSearch = byRule(RULES.webSearchNativeProviderOnAppBackend);
console.log(`\nEnabled models that search through the app backend although their provider has a native tool here (${webSearch.length})`);
for (const finding of webSearch) {
  const replaces = finding.nativePredecessors.length
    ? `; replaces ${finding.nativePredecessors.join(", ")}, which search${finding.nativePredecessors.length === 1 ? "es" : ""} natively`
    : "";
  console.log(`  ${finding.modelId} (${finding.provider}) -> ${finding.searchBackend ?? "app backend"}: not in WEB_SEARCH_CAPABILITIES${replaces}`);
}
if (webSearch.length) {
  console.log("  Native search is verified, bounded and priced per model in lib/webSearchCapability.ts;");
  console.log("  registering one changes the reserved search cost (docs/policy/credit-and-cost-limits.md).");
}

const retired = byRule(RULES.retiredModelNamesNoSuccessor);
console.log(`\nRetired models whose declared replacement the chat route will not name (${retired.length})`);
for (const finding of retired) {
  const next = finding.firstNameableSuccessor
    ? `first nameable successor along the chain: ${finding.firstNameableSuccessor}`
    : "no nameable successor along the chain";
  console.log(`  ${finding.modelId} -> ${finding.replacementModelId} (${finding.replacementState}); ${next}`);
}
if (retired.length) {
  console.log("  The route names a replacement one hop away only when it is enabled, listed and not deleted;");
  console.log('  otherwise the user is told to "select another model".');
}

console.log("\nA report, not a gate: each line is a question for the operator, not a defect verdict.");
