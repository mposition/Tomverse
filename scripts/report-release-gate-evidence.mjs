// Reports which release gates already have their named evidence in the tree,
// and which have nothing built yet.
//
// See scripts/report-release-gate-evidence-core.mjs for why this exists and
// what each verdict does and does not claim. This file only reads the registry
// and the filesystem; it never writes to either.
//
// Usage:
//   node scripts/report-release-gate-evidence.mjs [--json]
//   node scripts/report-release-gate-evidence.mjs --condition memory-release-b-enabled=false
//
// `--condition` supplies an `appliesWhen` flag. It is a runtime setting rather
// than a repository fact, so gates whose condition is not supplied are reported
// as undetermined instead of being assumed off.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import {
  GATE_VERDICTS,
  inventoryReleaseGates,
} from "./report-release-gate-evidence-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");

const REGISTRY = join(root, "docs", "release-gates", "tomverse-chat-v1.yaml");

const conditions = {};
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "--condition") continue;
  const pair = args[index + 1];
  if (!pair || !pair.includes("=")) {
    console.error("--condition needs a name=true|false pair.");
    process.exit(1);
  }
  const [name, value] = pair.split("=");
  if (value !== "true" && value !== "false") {
    console.error(`--condition ${name} must be true or false, got ${value}.`);
    process.exit(1);
  }
  conditions[name] = value === "true";
}

let registry;
try {
  registry = parse(readFileSync(REGISTRY, "utf8"));
} catch (cause) {
  console.error(`Could not read ${REGISTRY}: ${cause.message}`);
  process.exit(1);
}

const gates = registry?.gates;
if (!Array.isArray(gates) || gates.length === 0) {
  console.error(`${REGISTRY} has no gates.`);
  process.exit(1);
}

const report = inventoryReleaseGates({
  gates,
  exists: (path) => existsSync(join(root, path)),
  conditions,
});

const LABELS = {
  [GATE_VERDICTS.NOT_IMPLEMENTED]: "nothing built yet",
  [GATE_VERDICTS.IMPLEMENTED_UNMEASURED]: "built, nothing measures it",
  [GATE_VERDICTS.EVIDENCE_PRESENT]: "named evidence is present",
  [GATE_VERDICTS.APPLICABILITY_UNKNOWN]: "applicability undetermined",
  [GATE_VERDICTS.NOT_APPLICABLE]: "not applicable",
  [GATE_VERDICTS.UNMAPPED]: "no evidence mapping written",
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const status = registry.metadata?.status ?? "unknown";
  console.log(
    `${gates.length} gates, registry status ${status}. ` +
      `This reports artefacts, never thresholds -- no gate below is claimed to pass.\n`
  );

  for (const group of [
    ["Nothing built yet", report.backlog],
    ["Built, nothing measures it", report.unproven],
    ["Named evidence is present", report.evidencePresent],
    ["Undetermined", report.undetermined],
    ["Not applicable", report.notApplicable],
  ]) {
    const [title, entries] = group;
    if (entries.length === 0) continue;
    console.log(`## ${title} (${entries.length})`);
    for (const gate of entries) {
      console.log(`  ${gate.id}  [${LABELS[gate.verdict]}]`);
      if (gate.present.length > 0) {
        console.log(`    present: ${gate.present.join(", ")}`);
      }
      if (gate.missing.length > 0) {
        console.log(`    missing: ${gate.missing.join(", ")}`);
      }
      if (gate.note) console.log(`    ${gate.note}`);
    }
    console.log("");
  }

  console.log(
    `Start work from "nothing built yet" (${report.backlog.length}). ` +
      `"Built, nothing measures it" (${report.unproven.length}) is usually a test or a report rather than a feature.`
  );
  if (report.undetermined.length > 0) {
    console.log(
      `Undetermined: ${report.undetermined.map((gate) => gate.id).join(", ")} -- ` +
        `supply --condition, or write a mapping, before reading these as either done or not.`
    );
  }
}

// Reporting only. The registry is the approval system of record and a human
// act; a script that could fail a build on its own reading of the evidence
// would become a second, quieter approval path beside it.
process.exit(0);
