// What credit price is each model actually billed at, and does the source say
// the same thing?
//
//   npm run report:model-credit-weights
//   npm run report:model-credit-weights -- --json
//
// Reads ModelRegistryEntry and compares each row's `creditWeight` against what
// lib/models.ts would produce for the same model. Writes nothing, and exits 0
// whatever it finds -- see the header of report-model-credit-weights-core.mjs
// for why divergence is a question rather than a defect.
//
// Without a DATABASE_URL there is nothing to compare against, so it reports
// the catalogue's own numbers and says so. That run cannot find anything.

import { AVAILABLE_MODELS, getModelUsageProfile } from "../lib/models.ts";
import {
  OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS,
  STATIC_CATALOG_RECONCILIATION_MODEL_IDS,
} from "../lib/modelRegistryShared.ts";

// Only the models whose reconciliation actually writes `creditWeight`.
//
// Being in STATIC_CATALOG_RECONCILIATION_MODEL_IDS no longer implies that:
// the cap-only scope carries `maxOutputTokens` and nothing else, precisely so
// it cannot move a credit weight
// (docs/policy/perplexity-sonar-credit-price-hold.md). Handing the whole list
// to this report would file `perplexity/sonar` under "corrected on the next
// boot" -- which is false, and is the opposite of what that hold needs this
// report to say when it uses it to scope itself
// (docs/policy/perplexity-sonar-credit-price-hold.md §5).
const capOnly = new Set(OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS);
const CREDIT_WEIGHT_RECONCILED_MODEL_IDS =
  STATIC_CATALOG_RECONCILIATION_MODEL_IDS.filter((id) => !capOnly.has(id));
import {
  compareCreditWeights,
  creditWeightFindings,
  formatCreditWeightRow,
} from "./report-model-credit-weights-core.mjs";

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

const catalogueModels = AVAILABLE_MODELS.map((model) => ({
  id: model.id,
  provider: model.provider,
  enabled: model.enabled,
  creditWeight: getModelUsageProfile(model).credits,
  // Whether the source names this model's weight, or leaves it to the
  // usageClass default. A divergence only reads as a stranded edit when
  // somebody actually wrote a number down.
  explicitInCode:
    Number.isInteger(model.creditWeight) && (model.creditWeight || 0) > 0,
}));

let source = "compiled_catalogue";
let storedRows = [];
let note =
  "No DATABASE_URL: nothing to compare the catalogue against, so this run can find nothing.";

if (databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const rows = await prisma.modelRegistryEntry.findMany({
      select: { id: true, provider: true, enabled: true, creditWeight: true },
      orderBy: [{ provider: "asc" }, { sortOrder: "asc" }],
    });
    await prisma.$disconnect().catch(() => undefined);
    if (rows.length > 0) {
      storedRows = rows;
      source = "model_registry";
      note = `Read ${rows.length} ModelRegistryEntry row(s).`;
    } else {
      note =
        "The registry is empty, so every model reports as missing_in_db rather than as agreeing.";
      source = "model_registry";
    }
  } catch (error) {
    const message = String(error?.message || error).replaceAll(
      databaseUrl,
      "[redacted]"
    );
    note = `DATABASE_URL was set but unreadable, so nothing was compared: ${message.slice(0, 200)}`;
  }
}

const entries = compareCreditWeights({
  catalogueModels,
  storedRows,
  reconciledModelIds: CREDIT_WEIGHT_RECONCILED_MODEL_IDS,
});
const findings = creditWeightFindings(entries);

if (json) {
  console.log(JSON.stringify({ source, note, findings, entries }, null, 2));
} else {
  console.log(`Model credit weights (${source})\n  ${note}\n`);
  console.log(
    `  ${"model".padEnd(34)}${"catalogue".padEnd(14)}${"stored".padEnd(12)}${"state".padEnd(17)}`
  );
  for (const entry of entries) console.log(formatCreditWeightRow(entry));

  if (findings.strandedEdits.length > 0) {
    console.log(
      `\n  ${findings.strandedEdits.length} stranded edit(s). The source names a weight, the row disagrees,\n` +
        "  and no reconciliation covers the model -- so nothing will resolve this on its own.\n" +
        "  Either the row is a deliberate override and the source is misleading whoever reads it,\n" +
        "  or the edit never took effect. The column cannot tell you which."
    );
    for (const entry of findings.strandedEdits) {
      console.log(
        `    ${entry.modelId}: source ${entry.catalogueCredits}, billed ${entry.storedCredits}`
      );
    }
  }

  if (findings.pendingReconciliation.length > 0) {
    console.log(
      `\n  ${findings.pendingReconciliation.length} diverged row(s) inside STATIC_CATALOG_RECONCILIATION_MODEL_IDS.\n` +
        "  These are corrected on the next boot; they are listed so a run mid-deploy is not read as a finding."
    );
  }

  if (findings.missingInDb.length > 0) {
    console.log(
      `\n  ${findings.missingInDb.length} model(s) with no registry row. Seeding inserts these on next boot.`
    );
  }

  if (findings.unknownToCode.length > 0) {
    console.log(
      `\n  ${findings.unknownToCode.length} row(s) the catalogue does not know about.\n` +
        "  A model removed from the source keeps billing at its stored weight until the row is dealt with."
    );
    for (const entry of findings.unknownToCode) {
      console.log(`    ${entry.modelId}: billed ${entry.storedCredits}`);
    }
  }

  if (
    findings.diverged.length === 0 &&
    findings.missingInDb.length === 0 &&
    findings.unknownToCode.length === 0
  ) {
    console.log("\n  Every registry row bills at the weight the source states.");
  }
}
