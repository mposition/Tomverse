// What the Router would do with the whole catalogue, for every item in an
// evaluation set, decided offline.
//
// Reads the set, runs the product's own decision on each item over the static
// catalogue, and prints for every model whether it was chosen, was a fallback
// candidate, or was refused and for which fixed reason; which quality evidence
// (if any) the choice rested on; what separated the primary from each loser;
// and how the output cap the Router routed under compares with the one
// dispatch will apply. Nothing is called, nothing is billed, nothing is
// written unless --json or --md names a path.
//
// Usage:
//   node --import tsx scripts/report-router-full-catalog.mjs \
//     [--set=docs/ops/router-evaluation-set/development-v0.json] \
//     [--items=adopted|all] [--plan=Pro] [--requested-model=<catalogue id>] \
//     [--fallback-flag=off|on] [--json=<out.json>] [--md=<out.md>] [--quiet]
//
// The catalogue is lib/models.ts as committed. The product routes over the
// runtime registry's rows instead, with health and measured signals from the
// database, so this describes the Router as the catalogue would run it, not
// as the deployment does today. The report's `inputs` block says so.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { diagnoseFullCatalog, TIE_BREAK_ORDER } from "../lib/routerFullCatalogDiagnostic.ts";
import { adoptedItems } from "../lib/routerQualityEvalSet.ts";
import { NO_WEB_SEARCH_BACKENDS } from "../lib/webSearchBackends.ts";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length > 0 ? rest.join("=") : "true"];
  })
);
const flag = (name, fallback) => args.get(name) ?? fallback;
const die = (message) => {
  console.error(message);
  process.exit(1);
};

const setPath = flag("set", "docs/ops/router-evaluation-set/development-v0.json");
const itemScope = flag("items", "adopted");
if (itemScope !== "adopted" && itemScope !== "all") die("--items must be adopted or all.");
const plan = flag("plan", "Pro");
if (!["Guest", "Free", "Pro", "Max"].includes(plan)) die("--plan must be Guest, Free, Pro or Max.");
const fallbackFlag = flag("fallback-flag", "off");
if (fallbackFlag !== "off" && fallbackFlag !== "on") die("--fallback-flag must be off or on.");
const quiet = flag("quiet", "false") === "true";

const set = JSON.parse(readFileSync(setPath, "utf8"));
const items = itemScope === "adopted" ? adoptedItems(set) : set.items;
const requestedModelId = flag("requested-model", set.baseline?.modelId);
if (!requestedModelId) die("--requested-model is required when the set names no baseline.");

const report = diagnoseFullCatalog({
  items,
  models: AVAILABLE_MODELS,
  plan,
  requestedModelId,
  // No credential is assumed. A deployment holding one passes a different
  // readiness and gets a different answer on current-information items.
  searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
  fallbackEnvironment: fallbackFlag === "on" ? { AUTO_ROUTER_FALLBACK_ENABLED: "on" } : {},
  catalogueSource: "lib/models.ts (static catalogue, not the runtime registry)",
});

const pct = (numerator, denominator) =>
  denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(1)}%`;

const lines = [];
const say = (line = "") => lines.push(line);

say(`# Full-catalogue routing diagnostic — ${set.version} (${itemScope} items)`);
say();
say(`Diagnostic ${report.version}; Router ${JSON.stringify(report.routerVersions)}.`);
say(
  `Catalogue: ${report.inputs.catalogueModelCount} models, ${report.inputs.enabledModelCount} enabled ` +
    `(${report.inputs.catalogueSource}). Plan ${report.inputs.plan}; routed under ${report.inputs.requestedModelId}'s ` +
    `cap of ${report.inputs.routerRequestOutputCapTokens} output tokens; no sticky state; signals supplied: ` +
    `${report.inputs.signalsSupplied.length === 0 ? "none (cost derived from the pricing registry)" : report.inputs.signalsSupplied.join(", ")}; ` +
    `fallback flag ${report.inputs.fallbackFlagAsDeployed}.`
);
say(`Tie-break order: ${TIE_BREAK_ORDER.join(" > ")}.`);
say();

say("## Summary");
say();
say(`| | |`);
say(`|---|---|`);
say(`| items | ${report.inputs.itemCount} |`);
say(`| items whose explanation disagrees with the product decision | ${report.summary.consistencyProblems} |`);
say(
  `| (model, kind) cells with approved quality evidence | ${report.summary.evidenceCells.withEvidence} of ${report.summary.evidenceCells.total} |`
);
say(`| items where dispatch's output cap differs from the Router's | ${report.summary.outputCapMismatchItems} |`);
say(`| pairwise inversions against the primary | ${report.summary.pairwiseInversions} |`);
say(`| enabled models never eligible on any item | ${report.summary.neverEligible.filter((e) => AVAILABLE_MODELS.find((m) => m.id === e.modelId)?.enabled).length} |`);
say(`| models eligible at least once and never primary | ${report.summary.eligibleNeverPrimary.length} |`);
say();

say("### Primary by model");
say();
say("| model | items | share |");
say("|---|---|---|");
for (const [modelId, n] of Object.entries(report.summary.primaryCounts).sort((a, b) => b[1] - a[1])) {
  say(`| ${modelId} | ${n} | ${pct(n, report.inputs.itemCount)} |`);
}
say();

say("### Primary by ranking kind");
say();
say("| kind | items | primaries |");
say("|---|---|---|");
for (const [kind, byModel] of Object.entries(report.summary.primaryCountsByKind).sort()) {
  const total = Object.values(byModel).reduce((sum, n) => sum + n, 0);
  say(
    `| ${kind} | ${total} | ${Object.entries(byModel)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${id} ${n}`)
      .join(", ")} |`
  );
}
say();

say("### What decided the top two");
say();
say("| criterion | items |");
say("|---|---|");
for (const [criterion, n] of Object.entries(report.summary.decidedByCounts).sort((a, b) => b[1] - a[1])) {
  say(`| ${criterion} | ${n} |`);
}
say();

say("### Rejections, summed over items");
say();
say("| reason | model-items |");
say("|---|---|");
for (const [reason, n] of Object.entries(report.summary.rejectionCounts).sort((a, b) => b[1] - a[1])) {
  say(`| ${reason} | ${n} |`);
}
say();

say("### Never eligible");
say();
say("| model | enabled | reasons |");
say("|---|---|---|");
for (const entry of report.summary.neverEligible) {
  const model = AVAILABLE_MODELS.find((m) => m.id === entry.modelId);
  say(`| ${entry.modelId} | ${model?.enabled ? "yes" : "no"} | ${entry.reasons.join(", ")} |`);
}
say();
if (report.summary.eligibleNeverPrimary.length > 0) {
  say("### Eligible at least once, never primary");
  say();
  say(report.summary.eligibleNeverPrimary.map((id) => `- ${id}`).join("\n"));
  say();
}

say("### Fallback scope as deployed");
say();
say("| scope | items |");
say("|---|---|");
for (const [scope, n] of Object.entries(report.summary.fallbackScopeAsDeployed).sort((a, b) => b[1] - a[1])) {
  say(`| ${scope} | ${n} |`);
}
say();

say("## Improvement and evaluation candidates");
say();
say("Offline work this diagnostic points at. None of it changes routing on its own.");
say();
for (const candidate of report.improvementCandidates) {
  say(`- **${candidate.kind}** (${candidate.itemCount} item(s); kinds ${candidate.taskKinds.join(", ")}): ${candidate.detail}`);
  say(`  models: ${candidate.modelIds.join(", ")}`);
}
say();

if (report.problems.length > 0) {
  say("## Problems");
  say();
  for (const problem of report.problems) say(`- ${problem}`);
  say();
}

say("## Per item");
say();
say("| item | kind (conf) | primary | decided by | reason | eligible | rejected | router→dispatch output cap | first fallback |");
say("|---|---|---|---|---|---|---|---|---|");
for (const item of report.items) {
  const eligible = item.models.filter((m) => m.rejectionReason === null).length;
  const cap = item.caps.primary
    ? `${item.caps.primary.routerOutputTokens}→${item.caps.primary.dispatchOutputTokens ?? item.caps.primary.dispatchFit}${item.caps.primary.outputCapDiffers ? " (differs)" : ""}`
    : "—";
  const fallback = item.fallback.firstExecutable
    ? `${item.fallback.firstExecutable.modelId} (${item.fallback.scopeAsDeployed.allowed ? "allowed" : item.fallback.scopeAsDeployed.reason})`
    : "none";
  say(
    `| ${item.itemId} | ${item.profile.rankingKind} (${item.profile.kindConfidence}) | ${item.decision.primaryModelId ?? "—"} | ` +
      `${item.decision.decidedBy ?? "—"} | ${item.decision.selectionReason} | ${eligible} | ${item.models.length - eligible} | ${cap} | ${fallback} |`
  );
}

const markdown = `${lines.join("\n")}\n`;
if (!quiet) process.stdout.write(markdown);

const jsonOut = args.get("json");
if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`written ${jsonOut}`);
}
const mdOut = args.get("md");
if (mdOut) {
  mkdirSync(dirname(mdOut), { recursive: true });
  writeFileSync(mdOut, markdown);
  console.error(`written ${mdOut}`);
}
